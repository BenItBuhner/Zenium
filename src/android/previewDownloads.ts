import type { PreviewDownloadSpec } from './previewSpec'

/** Raised on `window` by a `download=<file>` preview state; the detail is the `PreviewDownloadSpec`. */
export const PREVIEW_DOWNLOAD_EVENT = 'zen-preview-download'

/** How often a playing transfer reports, like `Downloads.kt`'s throttle. */
const TICK_MS = 250
/** `DownloadLogic.MAX_AUTO_RESUMES`: the downloader's own attempts after a network failure. */
const MAX_AUTO_RESUMES = 3
/** `DownloadLogic.autoResumeDelayMs`: 2 s, 4 s, then 8 s before attempt 1, 2, 3. */
const autoResumeDelayMs = (attempt: number): number =>
  2000 << Math.min(Math.max(attempt - 1, 0), MAX_AUTO_RESUMES - 1)

interface HostEvents {
  hostEvent(name: string, json: string): void
}

type Handler = (args: Record<string, unknown>) => unknown

interface Playing {
  token: string
  /** The core's record id, known once the core has bound the token. */
  id: string | null
  spec: PreviewDownloadSpec
  received: number
  timer: ReturnType<typeof setInterval> | null
  /** The downloader's own attempts made after a network failure (HB-43), and the next one waiting. */
  attempts: number
  retry: ReturnType<typeof setTimeout> | null
  /** How many of those attempts the spec still has failing again. */
  failuresLeft: number
}

/**
 * The preview host's stand-in for `Downloads.kt`: no bytes move, but the core hears exactly what
 * Kotlin would say. A `download=<file>` preview state announces a transfer (`download.started`),
 * the core binds it, and it then reports every quarter second at the requested speed until it
 * completes, pauses or fails where the spec says; Pause, Resume, Retry and Cancel from the sheet
 * go through the same `download.*` bridge calls the real host answers, so the Android downloads
 * UI can be exercised (and captured) in a desktop browser. The finished files it pretends to
 * have written answer the engine's existence check (`download.exists`, which the sheet asks for
 * as it opens) and its Delete file (`download.deleteFile`), so a `deleted` spec – or a Delete
 * file from a mouse's panel – reads Deleted in the row as it does on a phone (#166). A network
 * failure with `retrying` is retried the way `Downloads.kt` retries its own (HB-43): the
 * interruption is reported with the next attempt's time (`autoResumeAt`, 2 / 4 / 8 s on), the
 * row counts down to it, and the attempt plays on or fails again as the spec says – the core
 * schedules nothing for this host (`autoResume: 'host'`), exactly as on a phone.
 */
export function createPreviewDownloads(
  host: () => HostEvents,
  downloadsDir: string
): Record<string, Handler> {
  const playing = new Map<string, Playing>()
  /** Final paths of finished files that are gone again: deleted, or never there (`deleted`). */
  const gone = new Set<string>()
  let sequence = 0

  const emit = (name: string, payload: Record<string, unknown>): void =>
    host().hostEvent(name, JSON.stringify(payload))
  const partialPath = (p: Playing): string => `${downloadsDir}/${p.spec.filename}.zeniumdownload`
  const finalPath = (p: Playing): string => `${downloadsDir}/${p.spec.filename}`
  const byId = (id: unknown): Playing | undefined => [...playing.values()].find((p) => p.id === id)

  const stop = (p: Playing): void => {
    if (p.timer !== null) clearInterval(p.timer)
    p.timer = null
    if (p.retry !== null) clearTimeout(p.retry)
    p.retry = null
  }

  const report = (p: Playing, state: 'progressing' | 'paused'): void =>
    emit('download.progress', {
      token: p.token,
      receivedBytes: p.received,
      totalBytes: p.spec.totalBytes,
      state,
      canResume: true,
      etag: '"preview"',
      lastModified: '',
      savePath: partialPath(p),
      filename: p.spec.filename,
      finalName: p.spec.filename,
      mimeType: p.spec.mimeType
    })

  const finish = (
    p: Playing,
    state: 'completed' | 'cancelled' | 'interrupted',
    error?: string
  ): void => {
    stop(p)
    playing.delete(p.token)
    // `Downloads.kt`'s rule: the network's failure of a transfer whose server takes ranges can
    // be picked up (the stand-in's server always does), and so can a server's refusal of a
    // request continuing a partial file; a server refusing a fresh request (a 404, a 5xx, no
    // ranges) leaves nothing to resume, and the row offers Retry or nothing, per the verbs table.
    const canResume =
      state === 'interrupted' && ((error ?? '').startsWith('network-') || p.received > 0)
    const keepFile = state === 'completed' || canResume
    emit('download.done', {
      token: p.token,
      state,
      savePath: keepFile ? (state === 'completed' ? finalPath(p) : partialPath(p)) : '',
      filename: p.spec.filename,
      finalName: p.spec.filename,
      receivedBytes: p.received,
      totalBytes: p.spec.totalBytes,
      canResume,
      error: error ?? null,
      mimeType: p.spec.mimeType
    })
  }

  const tick = (p: Playing): void => {
    p.received = Math.min(p.spec.totalBytes, p.received + p.spec.bytesPerSecond / (1000 / TICK_MS))
    if (p.received >= p.spec.totalBytes) finish(p, 'completed')
    else report(p, 'progressing')
  }

  /**
   * The transfer failed with the spec's network reason and the downloader will try again itself
   * (`retrying`): the interruption goes out as Kotlin's does, with the time of the next attempt,
   * and at that time the attempt either fails again (the spec has failures left) or plays on;
   * the fourth failure in a row is final, as `DownloadLogic.shouldAutoResume` makes it.
   */
  const interrupt = (p: Playing): void => {
    const error = p.spec.error ?? 'network-failed'
    const attempt = p.attempts + 1
    if (!error.startsWith('network-') || attempt > MAX_AUTO_RESUMES) {
      finish(p, 'interrupted', error)
      return
    }
    const at = Date.now() + autoResumeDelayMs(attempt)
    emit('download.progress', {
      token: p.token,
      receivedBytes: p.received,
      totalBytes: p.spec.totalBytes,
      state: 'interrupted',
      canResume: true,
      etag: '"preview"',
      lastModified: '',
      savePath: partialPath(p),
      filename: p.spec.filename,
      finalName: p.spec.filename,
      mimeType: p.spec.mimeType,
      error,
      autoResumeAt: at
    })
    p.retry = setTimeout(() => {
      p.retry = null
      p.attempts = attempt
      report(p, 'progressing')
      if (p.failuresLeft > 0) {
        p.failuresLeft--
        interrupt(p)
      } else {
        p.timer = setInterval(() => tick(p), TICK_MS)
      }
    }, at - Date.now())
  }

  /** The core has bound the announced transfer: play it from where the spec put it. */
  const play = (p: Playing): void => {
    if (p.spec.error) {
      report(p, 'progressing')
      if ((p.spec.retrying ?? 0) > 0) {
        p.failuresLeft = p.spec.retrying ?? 0
        interrupt(p)
      } else {
        finish(p, 'interrupted', p.spec.error)
      }
      return
    }
    // A finished file since gone: complete at once, and the file is not there when asked.
    if (p.spec.deleted) {
      p.received = p.spec.totalBytes
      gone.add(finalPath(p))
      finish(p, 'completed')
      return
    }
    if (p.spec.paused) {
      report(p, 'paused')
      return
    }
    // A fresh record starts at zero bytes; a transfer picked up part-way first settles where it
    // is (a paused report resets the core's rate estimate there), so the bytes already there do
    // not read as one enormous burst of speed.
    if (p.received > 0) report(p, 'paused')
    report(p, 'progressing')
    p.timer = setInterval(() => tick(p), TICK_MS)
  }

  const announce = (
    spec: PreviewDownloadSpec,
    resumes: string | null,
    received: number
  ): Playing => {
    const p: Playing = {
      token: `preview-download-${++sequence}`,
      id: resumes,
      spec,
      received,
      timer: null,
      attempts: 0,
      retry: null,
      failuresLeft: 0
    }
    playing.set(p.token, p)
    emit('download.started', {
      token: p.token,
      url: spec.url,
      referrer: 'https://downloads.example.com/',
      filename: spec.filename,
      totalBytes: spec.totalBytes,
      mimeType: spec.mimeType,
      // A transfer the tab's own navigation produced (a PDF the viewer opens) names the tab and
      // says so, as Kotlin's DownloadListener does; a plain download names neither.
      sourceTabId: resumes ? null : (spec.sourceTabId ?? null),
      navigation: !resumes && spec.navigation === true,
      containerId: spec.private ? 'private' : 'default',
      resumes,
      savePath: resumes ? partialPath(p) : undefined,
      canResume: resumes ? true : undefined
    })
    return p
  }

  /** Resume or Retry of a record the core describes: play it on, or over, as a fresh transfer. */
  const again = (args: Record<string, unknown>, fromScratch: boolean): void => {
    const id = typeof args['id'] === 'string' ? args['id'] : null
    if (!id) return
    const previous = byId(id)
    if (previous) {
      stop(previous)
      playing.delete(previous.token)
    }
    const spec: PreviewDownloadSpec = previous?.spec ?? {
      filename: String(args['finalName'] || args['filename'] || 'download'),
      url: String(args['url'] ?? ''),
      mimeType: String(args['mimeType'] ?? 'application/octet-stream'),
      totalBytes: Number(args['totalBytes']) || 0,
      receivedBytes: 0,
      bytesPerSecond: 2_400_000,
      paused: false,
      error: null,
      deleted: false,
      private: args['private'] === true,
      sourceTabId: null,
      navigation: false
    }
    // The transfer the spec had failing, pausing or losing its file has done that once; it runs
    // on from here (a Resume during the countdown drops the attempt waiting: `stop` above), and
    // the file it writes is there again.
    const running = { ...spec, paused: false, error: null, retrying: 0, deleted: false }
    const received = fromScratch ? 0 : (previous?.received ?? 0)
    gone.delete(`${downloadsDir}/${spec.filename}`)
    announce(running, id, received)
  }

  window.addEventListener(PREVIEW_DOWNLOAD_EVENT, (e) => {
    const spec = (e as CustomEvent<PreviewDownloadSpec>).detail
    if (spec && typeof spec.filename === 'string') announce(spec, null, spec.receivedBytes)
  })

  return {
    'download.bind': ({ token, id }) => {
      const p = playing.get(String(token))
      if (!p) return
      p.id = String(id)
      if (p.timer === null) play(p)
    },
    // The core refused the transfer (`insecure-blocked`: `download=<file>&url=http://…` under
    // the stand-in's https referrer); nothing plays and nothing more is said of it.
    'download.refuse': ({ token }) => {
      const p = playing.get(String(token))
      if (!p) return
      stop(p)
      playing.delete(p.token)
    },
    'download.pause': ({ id }) => {
      const p = byId(id)
      if (!p) return
      stop(p)
      report(p, 'paused')
    },
    'download.resume': (args) => again(args, false),
    'download.retry': (args) => again(args, true),
    'download.cancel': ({ id }) => {
      const p = byId(id)
      if (p) finish(p, 'cancelled')
    },
    // Releasing a kept file moves it to its final name; the stand-in just says where that is.
    'download.release': ({ finalName, filename }) => ({
      savePath: `${downloadsDir}/${String(finalName || filename)}`,
      finalName: String(finalName || filename)
    }),
    'download.discard': () => undefined,
    'download.open': () => undefined,
    'download.openWith': () => undefined,
    'download.share': () => undefined,
    // The engine's existence check and Delete file (#166), against the files pretended so far:
    // a path is there unless it went, and deleting a gone one says so.
    'download.exists': ({ savePath }) => !gone.has(String(savePath)),
    'download.deleteFile': ({ savePath }) => {
      const path = String(savePath)
      if (gone.has(path)) return 'missing'
      gone.add(path)
      return 'deleted'
    },
    'download.showAll': () => console.info('[zen preview] open the system Downloads app'),
    // A picked folder comes back as a document-tree URI, as the SAF picker would hand it over.
    'download.chooseDirectory': () =>
      'content://com.android.externalstorage.documents/tree/primary%3ADownload%2FZenium'
  }
}

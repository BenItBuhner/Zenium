import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type DownloadItem as ElectronDownloadItem,
  type Session,
  type WebContents
} from 'electron'
import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { copyFile, rename, rm } from 'node:fs/promises'
import { PRIVATE_CONTAINER_ID, type DownloadItem } from '../../shared/types'
import { PARTIAL_SUFFIX, finalName as stripPartial } from '../../shared/downloads'
import type { DownloadHost } from '../../core/platform'
import type { DownloadService } from '../../core/downloads'
import type { ZenWindow } from '../../core/window'
import { uniquePath } from './uniquePath'

export { uniquePath } from './uniquePath'

let configuredDirectory: (() => string | null) | null = null

/** Settings › Downloads decides the folder; the rest of the host reads it through `downloadDir`. */
export function setDownloadDirectoryProvider(provider: () => string | null): void {
  configuredDirectory = provider
}

/**
 * The folder downloads go to: the one from Settings when it exists (or can be created), else the
 * platform's Downloads folder. Electron falls back to $HOME when the XDG dir is missing, so
 * create it.
 */
export function downloadDir(): string {
  const configured = configuredDirectory?.() ?? null
  if (configured) {
    try {
      mkdirSync(configured, { recursive: true })
      return configured
    } catch {
      // Fall through to the platform default.
    }
  }
  let dir = app.getPath('downloads')
  if (!dir || dir === app.getPath('home')) dir = join(app.getPath('home'), 'Downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface ElectronDownloadSettings {
  askWhereToSave: boolean
  directory: string | null
}

interface Live {
  item: ElectronDownloadItem
  session: Session
}

/**
 * Tracks Electron's download items and feeds the core's `DownloadService`. Files are written as
 * `<name>.zeniumdownload` next to their final place and renamed when the core releases them;
 * with "always ask where to save" on, the partial file waits in the Downloads folder while the
 * save dialog is open and moves to the chosen path at the end.
 *
 * Every session (one per container, plus the in-memory private one) is attached with its
 * container id, which stamps `containerId` and `private` on each record; retries and resumes run
 * in the record's own session so a private download never touches a persistent partition.
 */
export class ElectronDownloads implements DownloadHost {
  private readonly live = new Map<string, Live>()
  private readonly tracked = new WeakSet<ElectronDownloadItem>()
  private readonly reserved = new Set<string>()
  /** Intended final path of each in-flight download (the partial file may live elsewhere). */
  private readonly finalPaths = new Map<string, string>()
  /** Partial-file path → record, for downloads re-created with `createInterruptedDownload`. */
  private readonly pendingResumes = new Map<string, DownloadItem>()
  private readonly pendingRetries: DownloadItem[] = []
  /** Save dialogs still open; a transfer that finishes meanwhile is placed once they close. */
  private readonly pendingDialogs = new Map<string, Promise<void>>()
  private readonly sessions = new Map<string, Session>()
  private service: DownloadService | null = null
  /** Set by `park`: Chromium's teardown of the live items is not to be reported as cancels. */
  private quitting = false
  private tabIdFor: (source: WebContents) => string | null = () => null
  private parentWindow: (sourceTabId: string | null) => BrowserWindow | undefined = () => undefined

  constructor(private readonly settings: () => ElectronDownloadSettings) {
    setDownloadDirectoryProvider(() => this.settings().directory)
  }

  bind(
    service: DownloadService,
    hooks: {
      tabIdFor: (source: WebContents) => string | null
      parentWindow: (sourceTabId: string | null) => BrowserWindow | undefined
    }
  ): void {
    this.service = service
    this.tabIdFor = hooks.tabIdFor
    this.parentWindow = hooks.parentWindow
  }

  attach(ses: Session, containerId: string, onStarted: (sourceTabId: string | null) => void): void {
    this.sessions.set(containerId, ses)
    ses.on('will-download', (_event, item, source) => {
      const sourceTabId = source && !source.isDestroyed() ? this.tabIdFor(source) : null
      const resumed = this.track(item, ses, containerId, source, sourceTabId)
      if (!resumed) onStarted(sourceTabId)
    })
  }

  /** Returns true when the item continues an existing record (no new download to announce). */
  private track(
    item: ElectronDownloadItem,
    ses: Session,
    containerId: string,
    source: WebContents | undefined,
    sourceTabId: string | null
  ): boolean {
    const service = this.service
    if (!service || this.tracked.has(item)) return false
    this.tracked.add(item)

    const resuming = this.takePendingResume(item)
    if (resuming) {
      const record = service.begin({
        url: item.getURL(),
        filename: resuming.filename,
        totalBytes: item.getTotalBytes() || resuming.totalBytes,
        mimeType: item.getMimeType() || resuming.mimeType,
        savePath: resuming.savePath,
        containerId,
        resumes: resuming.id
      })
      this.live.set(record.id, { item, session: ses })
      this.finalPaths.set(record.id, join(dirname(resuming.savePath), resuming.finalName))
      this.wire(item, record)
      // Electron creates the item interrupted; it only starts once asked to resume.
      setTimeout(() => {
        if (item.getState() === 'interrupted' && item.canResume()) item.resume()
      }, 0)
      return true
    }

    const retried = this.takePendingRetry(item)
    const filename = stripPartial(item.getFilename() || retried?.filename || 'download')
    const referrer = retried?.referrer ?? referrerOf(source, item.getURL())
    const settings = this.settings()

    // The partial file is reserved up front so simultaneous downloads never share a name; with
    // "ask where to save" it waits in the Downloads folder until the dialog decides.
    const dir = downloadDir()
    const candidate = uniquePath(dir, filename, (p) => this.taken(p))
    const partial = candidate + PARTIAL_SUFFIX
    this.reserved.add(candidate)
    item.setSavePath(partial)

    const record = service.begin({
      url: item.getURL(),
      referrer,
      filename,
      finalName: basename(candidate),
      totalBytes: item.getTotalBytes(),
      mimeType: item.getMimeType(),
      savePath: partial,
      sourceTabId,
      userGesture: item.hasUserGesture(),
      canResume: Boolean(item.getETag() || item.getLastModifiedTime()),
      etag: item.getETag(),
      lastModified: item.getLastModifiedTime(),
      containerId,
      private: containerId === PRIVATE_CONTAINER_ID,
      resumes: retried?.id
    })
    this.live.set(record.id, { item, session: ses })
    this.finalPaths.set(record.id, candidate)
    this.wire(item, record)

    if (settings.askWhereToSave && !retried) {
      const dialogDone = this.askDestination(item, record, sourceTabId, candidate).finally(() =>
        this.pendingDialogs.delete(record.id)
      )
      this.pendingDialogs.set(record.id, dialogDone)
    }
    return Boolean(retried)
  }

  private wire(item: ElectronDownloadItem, record: DownloadItem): void {
    const service = this.service
    if (!service) return
    const fields = (): Pick<DownloadItem, 'receivedBytes' | 'totalBytes' | 'savePath'> => ({
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath: item.getSavePath() || record.savePath
    })
    item.on('updated', (_e, state) => {
      if (this.quitting) return
      service.progress(record.id, {
        ...fields(),
        etag: item.getETag() || undefined,
        lastModified: item.getLastModifiedTime() || undefined,
        canResume:
          state === 'interrupted'
            ? item.canResume()
            : Boolean(item.getETag() || item.getLastModifiedTime()),
        state: state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      })
    })
    item.once('done', (_e, state) => {
      this.live.delete(record.id)
      // On quit Chromium cancels the item itself; the record was parked and persisted already.
      if (this.quitting) return
      if (state === 'completed') {
        service.finish(record.id, 'completed', fields())
      } else if (state === 'cancelled') {
        this.forget(record.id)
        // The row may already be gone (removed while running); the partial file must go anyway.
        const partial = item.getSavePath() || record.savePath
        if (partial.endsWith(PARTIAL_SUFFIX)) void rm(partial, { force: true })
        service.finish(record.id, 'cancelled', fields())
      } else {
        service.finish(record.id, 'interrupted', {
          ...fields(),
          canResume: false,
          error: 'interrupted'
        })
      }
    })
  }

  /** "Always ask where to save": our own dialog, so the partial file stays under our control. */
  private async askDestination(
    item: ElectronDownloadItem,
    record: DownloadItem,
    sourceTabId: string | null,
    candidate: string
  ): Promise<void> {
    const parent = this.parentWindow(sourceTabId)
    const options = {
      title: 'Save as',
      defaultPath: candidate,
      properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<
        'createDirectory' | 'showOverwriteConfirmation'
      >
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      // No download at all, like Chrome: cancel the transfer and drop the record.
      const live = this.live.get(record.id)
      if (live && live.item.getState() !== 'completed') {
        live.item.once('done', () => this.service?.remove(record.id))
        live.item.cancel()
      } else {
        await this.deletePartial(record)
        this.service?.remove(record.id)
      }
      return
    }
    const chosen = result.filePath
    this.finalPaths.set(record.id, chosen)
    this.service?.progress(record.id, {
      finalName: basename(chosen),
      state: item.isPaused() ? 'paused' : 'progressing'
    })
  }

  private taken(path: string): boolean {
    return existsSync(path) || existsSync(path + PARTIAL_SUFFIX) || this.reserved.has(path)
  }

  private forget(id: string): void {
    const final = this.finalPaths.get(id)
    if (final) this.reserved.delete(final)
    this.finalPaths.delete(id)
  }

  private sessionFor(item: DownloadItem): Session | undefined {
    return this.sessions.get(item.containerId) ?? this.sessions.values().next().value
  }

  private takePendingResume(item: ElectronDownloadItem): DownloadItem | null {
    const path = item.getSavePath()
    const byPath = path ? this.pendingResumes.get(path) : undefined
    if (byPath) {
      this.pendingResumes.delete(path)
      return byPath
    }
    const url = item.getURL()
    for (const [key, record] of this.pendingResumes) {
      if (record.url === url) {
        this.pendingResumes.delete(key)
        return record
      }
    }
    return null
  }

  private takePendingRetry(item: ElectronDownloadItem): DownloadItem | null {
    const url = item.getURL()
    const chain = item.getURLChain()
    const index = this.pendingRetries.findIndex((r) => r.url === url || chain.includes(r.url))
    if (index === -1) return null
    return this.pendingRetries.splice(index, 1)[0] ?? null
  }

  // ---------------------------------------------------------------------------
  // DownloadHost
  // ---------------------------------------------------------------------------

  pause(id: string): void {
    this.live.get(id)?.item.pause()
  }

  resume(item: DownloadItem): void {
    const live = this.live.get(item.id)
    if (live) {
      if (live.item.canResume()) live.item.resume()
      return
    }
    // After a restart: continue the partial file where it stopped (Chromium sends Range and
    // If-Range from the validators we kept; a server that ignores them makes it start over).
    const partial = item.savePath
    const ses = this.sessionFor(item)
    if (!ses || !partial || !existsSync(partial)) {
      this.retry(item)
      return
    }
    const offset = statSync(partial).size
    this.pendingResumes.set(partial, item)
    ses.createInterruptedDownload({
      path: partial,
      urlChain: [item.url],
      mimeType: item.mimeType,
      offset,
      length: item.totalBytes > 0 ? item.totalBytes : offset,
      lastModified: item.lastModified,
      eTag: item.etag,
      startTime: Math.floor(item.startedAt / 1000)
    })
  }

  cancel(id: string): void {
    this.live.get(id)?.item.cancel()
  }

  retry(item: DownloadItem): void {
    const ses = this.sessionFor(item)
    if (!ses) return
    this.pendingRetries.push(item)
    ses.downloadURL(item.url, item.referrer ? { headers: { Referer: item.referrer } } : undefined)
  }

  async release(item: DownloadItem): Promise<{ savePath: string; finalName: string } | null> {
    await this.pendingDialogs.get(item.id)
    const partial = item.savePath
    const wanted = this.finalPaths.get(item.id) ?? join(dirname(partial), item.finalName)
    this.forget(item.id)
    if (!existsSync(partial)) {
      return existsSync(wanted) ? { savePath: wanted, finalName: basename(wanted) } : null
    }
    const final =
      existsSync(wanted) && wanted !== partial
        ? uniquePath(dirname(wanted), basename(wanted), (p) => this.taken(p))
        : wanted
    try {
      mkdirSync(dirname(final), { recursive: true })
      await move(partial, final)
      return { savePath: final, finalName: basename(final) }
    } catch (error) {
      console.warn('[zenium] could not place the download:', (error as Error).message)
      return null
    }
  }

  async deletePartial(item: DownloadItem): Promise<void> {
    this.forget(item.id)
    // Only ever delete what we wrote ourselves: partial and quarantined files carry the suffix.
    if (item.savePath.endsWith(PARTIAL_SUFFIX)) await rm(item.savePath, { force: true })
  }

  /**
   * Quitting: Chromium cancels every in-flight item during shutdown and deletes the file at the
   * path it knows, so the partial is renamed out of its reach first. It goes next to the intended
   * final file (the chosen folder with "ask where to save"), or stays in its own folder when that
   * is another volume; a still-open handle keeps writing into the renamed file on POSIX. Returns
   * null when the rename failed (Windows keeps the file locked): the record then resumes from zero.
   */
  park(item: DownloadItem): string | null {
    this.quitting = true
    const partial = item.savePath
    if (!partial || !partial.endsWith(PARTIAL_SUFFIX) || !existsSync(partial)) return null
    const target = this.finalPaths.get(item.id) ?? join(dirname(partial), item.finalName)
    const parkedName = `${basename(target)}.${Date.now().toString(36)}${PARTIAL_SUFFIX}`
    for (const dir of [dirname(target), dirname(partial)]) {
      const parked = join(dir, parkedName)
      try {
        mkdirSync(dir, { recursive: true })
        renameSync(partial, parked)
        return parked
      } catch {
        // Another volume or a locked file: try the partial's own folder, then give up.
      }
    }
    return null
  }

  showInFolder(item: DownloadItem): void {
    if (item.savePath && existsSync(item.savePath)) shell.showItemInFolder(item.savePath)
  }

  async open(item: DownloadItem): Promise<void> {
    if (item.savePath && existsSync(item.savePath)) await shell.openPath(item.savePath)
  }

  async chooseDirectory(win?: ZenWindow): Promise<string | null> {
    const host = win?.host as { win?: BrowserWindow } | undefined
    const parent = host?.win && !host.win.isDestroyed() ? host.win : undefined
    const options = {
      title: 'Choose where Zenium saves downloads',
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  }
}

/** The page a download came from: the source view's committed document, if it has one. */
function referrerOf(source: WebContents | undefined, downloadUrl: string): string {
  if (!source || source.isDestroyed()) return ''
  const url = source.getURL()
  if (!url || url === downloadUrl || !/^https?:/.test(url)) return ''
  return url
}

/** Rename, or copy and delete when the destination is on another volume. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

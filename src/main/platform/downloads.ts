import {
  app,
  dialog,
  net,
  shell,
  type BrowserWindow,
  type ClientRequest,
  type DownloadItem as ElectronDownloadItem,
  type Session,
  type WebContents
} from 'electron'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type DownloadInterruptReason,
  type DownloadItem
} from '../../shared/types'
import {
  PARTIAL_SUFFIX,
  filenameForResponse,
  finalName as stripPartial,
  interruptReasonFromHttpStatus,
  interruptReasonFromNetError,
  interruptReasonFromRangeResponse,
  isAttachmentDisposition
} from '../../shared/downloads'
import type { DownloadHost } from '../../core/platform'
import type { DownloadService } from '../../core/downloads'
import type { ZenWindow } from '../../core/window'
import { APP_ICON_DEFAULT, type AppIconId } from '../../shared/appIcon'
import { openDownloadsFolder, startFileDrag } from './downloadsShell'
import type { WebRequestDetails, WebRequestEvent, WebRequestListener } from './webRequest'
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
  /**
   * Why the transfer's request ended, from the session's `webRequest` events: the `net::` error
   * of `onErrorOccurred` or a refusing HTTP status of `onCompleted`. Electron's item only says
   * `interrupted`; this names the reason when the item settles.
   */
  reason?: DownloadInterruptReason
}

/** The one method of the `webRequest` multiplexer the host needs: observe-only listeners. */
export interface RequestObserver {
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: { registrant: string }
  ): () => void
}

/** A name proposed for a new download's file (an extension's `download()` or `onDeterminingFilename`). */
export interface FilenameSuggestion {
  /** Relative to the downloads folder, forward slashes; the caller checked it is safe. */
  filename: string
  /** What to do when a file of that name exists: number it, replace it, or ask the user. */
  conflictAction: 'uniquify' | 'overwrite' | 'prompt'
}

/**
 * Asked once per new transfer, before its file is placed, with the record and the name it would
 * get by default; null keeps that name. The transfer runs into its partial file meanwhile.
 */
export type FilenameDeterminer = (
  record: DownloadItem,
  suggested: string
) => Promise<FilenameSuggestion | null>

/** A transfer started on someone's behalf rather than by a page (`chrome.downloads.download`). */
export interface ProgrammaticDownload {
  url: string
  headers?: Record<string, string>
  /** Session the request runs in; the default container when omitted. */
  containerId?: string
  /** The caller's own name for the file, applied before the determiner is asked. */
  suggestion?: FilenameSuggestion
  /** Show the save dialog whatever the setting says. */
  saveAs?: boolean
}

interface PendingStart {
  request: ProgrammaticDownload
  resolve: (record: DownloadItem) => void
}

/** How long a programmatic start waits for the engine to announce the transfer. */
const START_TIMEOUT_MS = 60_000
/** How long a refusal seen before its download item exists waits for `will-download`. */
const PENDING_REASON_MS = 60_000
const MAX_PENDING_REASONS = 64
/**
 * Ask the server what it answered Chromium's refused resume with (see `investigate`): one extra
 * request per interruption nobody noted a reason for, in exchange for the exact reason Chrome
 * shows ("No file", "Forbidden", …) instead of the coarse verdict.
 */
const PROBE_REFUSED_RESUME = true
const PROBE_TIMEOUT_MS = 10_000
/** Requests of ours (probes) and requests we answered for (dead links): their events are not a transfer's. */
const MAX_IGNORED_REQUESTS = 64

/** What the server answered the probe with; the reason is read from it by `interruptReasonFromRangeResponse`. */
interface ProbeAnswer {
  status: number
  contentRange: string | null
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
  /**
   * URLs whose next transfer asks where to save whatever the setting says: the context menu's
   * "Save Link / Image / Video As…", which always ask in Chrome. Each entry serves one download.
   */
  private readonly saveAsUrls: string[] = []
  /** Refusals of requests no live item claimed yet (canonical URL → reason), see `observeRequests`. */
  private readonly pendingReasons = new Map<
    string,
    { reason: DownloadInterruptReason; at: number }
  >()
  /**
   * Request ids whose refusals and errors are not a transfer's: our own probes of a refused
   * resume, and the frame navigations we made a failed row for (their `onErrorOccurred` follows).
   */
  private readonly ignoredRequests = new Set<string>()
  /** Canonical URLs a probe is in flight for, to know the probe's own request when it starts. */
  private readonly probing = new Set<string>()
  private readonly sessions = new Map<string, Session>()
  /** `attach`'s "a download started" hook per container, for the rows made without an item. */
  private readonly startedHooks = new Map<string, (sourceTabId: string | null) => void>()
  private service: DownloadService | null = null
  /** Set by `park`: Chromium's teardown of the live items is not to be reported as cancels. */
  private quitting = false
  private determiner: FilenameDeterminer | null = null
  private readonly pendingStarts: PendingStart[] = []
  /** Records whose determined name replaces an existing file at release instead of numbering. */
  private readonly overwriting = new Set<string>()
  private tabIdFor: (source: WebContents) => string | null = () => null
  private parentWindow: (sourceTabId: string | null) => BrowserWindow | undefined = () => undefined

  constructor(
    private readonly settings: () => ElectronDownloadSettings,
    /** The app icon a dragged-out file falls back to when the OS has none for its type. */
    private readonly appIcon: () => AppIconId = () => APP_ICON_DEFAULT
  ) {
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

  /**
   * Watch the sessions' requests for how a download's own request ends, so an interrupted item
   * can name its reason the way Chromium's download core does: a refusing HTTP status read at
   * `onHeadersReceived` (404 is `server-bad-content`, 403 `server-forbidden`, …) or the `net::`
   * error of `onErrorOccurred` (which reaches us before the item settles). Requests are matched
   * to the live items by URL (any URL of the redirect chain); a reason seen before the item
   * exists (the first response of a transfer is judged before `will-download`) waits for it.
   * Chromium's own abort of a loader it refused is `ERR_ABORTED`, which names nothing.
   *
   * Two kinds of request are not a transfer's and are left out: the host's own probes of a
   * refused resume (`investigate`; known by URL when they start, then by request id), and a
   * frame navigation the server refuses with `Content-Disposition: attachment`, for which no
   * item ever appears – that one becomes the failed row Chrome shows instead (`deadLink`).
   */
  observeRequests(observer: RequestObserver): void {
    const options = { registrant: 'zenium:downloads' }
    observer.addListener(
      'onBeforeRequest',
      (details) => {
        // A probe runs outside any tab; a page's request to the same URL has one.
        if (details.tabId === null && this.probing.has(canonical(details.url)))
          this.ignore(details.requestId)
      },
      options
    )
    observer.addListener(
      'onHeadersReceived',
      (details) => {
        if (this.ignoredRequests.has(details.requestId)) return
        const status = details.statusCode
        if (status === undefined) return
        const reason = interruptReasonFromHttpStatus(status)
        if (!reason) return
        if (
          status >= 400 &&
          (details.resourceType === 'main_frame' || details.resourceType === 'sub_frame') &&
          isAttachmentDisposition(header(details.responseHeaders, 'content-disposition'))
        ) {
          // The navigation's own failure follows (`ERR_INVALID_RESPONSE`); it is this row's.
          this.ignore(details.requestId)
          this.deadLink(details, reason)
          return
        }
        this.noteReason(details.url, reason)
      },
      options
    )
    observer.addListener(
      'onErrorOccurred',
      (details) => {
        if (this.ignoredRequests.delete(details.requestId)) return
        const error = details.error
        if (!error || /ERR_ABORTED$/.test(error)) return
        this.noteReason(details.url, interruptReasonFromNetError(error))
      },
      options
    )
  }

  private ignore(requestId: string): void {
    if (this.ignoredRequests.size >= MAX_IGNORED_REQUESTS) {
      const oldest = this.ignoredRequests.values().next().value
      if (oldest !== undefined) this.ignoredRequests.delete(oldest)
    }
    this.ignoredRequests.add(requestId)
  }

  /**
   * Chrome turns a navigation the server answers with `Content-Disposition: attachment` into a
   * download whatever the status, so a link to a download the server refuses (a dead download
   * link) shows in its bubble as "Failed · No file". Electron's Chromium creates no item for it
   * (the navigation fails with `ERR_INVALID_RESPONSE`, no `will-download`), so the host makes
   * the record Chrome would have: begun and finished interrupted in one tick, named by the
   * header (RFC 6266, `filename*` first) or the URL's last segment, typed by `Content-Type`, in
   * the request's container and from its tab, which the core then leaves as it was (no error
   * page of ours). Frames only: a fetch or XHR never becomes a download, whatever it answers.
   */
  private deadLink(details: WebRequestDetails, reason: DownloadInterruptReason): void {
    const service = this.service
    if (!service) return
    const referrer =
      [details.documentUrl, details.initiator].find((u) => u && /^https?:/.test(u)) ?? ''
    const record = service.begin({
      url: details.url,
      referrer,
      filename: filenameForResponse(
        details.url,
        header(details.responseHeaders, 'content-disposition')
      ),
      totalBytes: 0,
      mimeType: mediaType(header(details.responseHeaders, 'content-type')),
      sourceTabId: details.tabId,
      userGesture: null,
      canResume: false,
      containerId: details.partition,
      private: details.partition === PRIVATE_CONTAINER_ID
    })
    // Noted before the start hook, which may close a tab that had nothing but this navigation.
    service.noteDeadLink(details.tabId, details.url)
    this.startedHooks.get(details.partition)?.(details.tabId)
    service.finish(record.id, 'interrupted', { canResume: false, error: reason })
  }

  private noteReason(url: string, reason: DownloadInterruptReason): void {
    const live = this.liveFor(url)
    if (live) {
      live.reason = reason
      return
    }
    const now = Date.now()
    for (const [key, entry] of this.pendingReasons) {
      if (now - entry.at > PENDING_REASON_MS) this.pendingReasons.delete(key)
    }
    if (this.pendingReasons.size >= MAX_PENDING_REASONS) {
      const oldest = this.pendingReasons.keys().next().value
      if (oldest !== undefined) this.pendingReasons.delete(oldest)
    }
    this.pendingReasons.set(canonical(url), { reason, at: now })
  }

  /** The live transfer whose request (any URL of its redirect chain) is `url`. */
  private liveFor(url: string): Live | undefined {
    const wanted = canonical(url)
    for (const live of this.live.values()) {
      const { item } = live
      if (canonical(item.getURL()) === wanted) return live
      if (item.getURLChain().some((u) => canonical(u) === wanted)) return live
    }
    return undefined
  }

  /** A new live entry, carrying the reason its request was refused with before it existed, if any. */
  private newLive(item: ElectronDownloadItem, session: Session): Live {
    const live: Live = { item, session }
    for (const url of [item.getURL(), ...item.getURLChain()]) {
      const key = canonical(url)
      const pending = this.pendingReasons.get(key)
      if (!pending) continue
      this.pendingReasons.delete(key)
      if (Date.now() - pending.at <= PENDING_REASON_MS) live.reason = pending.reason
    }
    return live
  }

  /** The next download of `url` (started right after this call) goes through the save dialog. */
  expectSaveAs(url: string): void {
    this.saveAsUrls.push(url)
    // A download the engine never started (blocked, offline) must not make a later plain
    // download of the same URL ask.
    setTimeout(() => this.takeSaveAs(url), 30_000)
  }

  private takeSaveAs(url: string): boolean {
    const index = this.saveAsUrls.indexOf(url)
    if (index === -1) return false
    this.saveAsUrls.splice(index, 1)
    return true
  }

  /** Whether `item` is a "Save As…" transfer (matched on any URL of its redirect chain). */
  private isSaveAs(item: ElectronDownloadItem): boolean {
    if (this.saveAsUrls.length === 0) return false
    const urls = [item.getURL(), ...item.getURLChain()]
    return urls.some((url) => this.takeSaveAs(url))
  }

  attach(ses: Session, containerId: string, onStarted: (sourceTabId: string | null) => void): void {
    this.sessions.set(containerId, ses)
    this.startedHooks.set(containerId, onStarted)
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
      this.live.set(record.id, this.newLive(item, ses))
      this.finalPaths.set(record.id, join(dirname(resuming.savePath), resuming.finalName))
      this.wire(item, record)
      // Electron creates the item interrupted; it only starts once asked to resume.
      setTimeout(() => {
        if (item.getState() === 'interrupted' && item.canResume()) item.resume()
      }, 0)
      return true
    }

    const retried = this.takePendingRetry(item)
    const started = retried ? null : this.takePendingStart(item)
    const filename = stripPartial(item.getFilename() || retried?.filename || 'download')
    const referrer = retried?.referrer ?? referrerOf(source, item.getURL())
    // Taken here, once per transfer: a "Save As…" expectation is consumed by the item it was for.
    const saveAs = this.isSaveAs(item)

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
    this.live.set(record.id, this.newLive(item, ses))
    this.finalPaths.set(record.id, candidate)
    this.wire(item, record)
    started?.resolve(record)

    if (!retried) {
      const placed = this.place(
        item,
        record,
        sourceTabId,
        candidate,
        started?.request,
        saveAs
      ).finally(() => this.pendingDialogs.delete(record.id))
      this.pendingDialogs.set(record.id, placed)
    }
    return Boolean(retried)
  }

  /**
   * Settle where a new transfer's file goes: the caller's own name (`download({filename})`),
   * then the determiner's (extensions' `onDeterminingFilename`), then the save dialog when the
   * setting, the caller, a "Save As…" menu item (`saveAs`) or a `prompt` conflict action asks
   * for it. The transfer runs into its partial file meanwhile; `release` waits for this before
   * placing it.
   */
  private async place(
    item: ElectronDownloadItem,
    record: DownloadItem,
    sourceTabId: string | null,
    candidate: string,
    request: ProgrammaticDownload | undefined,
    saveAs: boolean
  ): Promise<void> {
    let suggestion = request?.suggestion ?? null
    let prompt = this.settings().askWhereToSave || Boolean(request?.saveAs) || saveAs
    if (this.determiner) {
      const determined = await this.determiner(record, suggestion?.filename ?? basename(candidate))
      // Removed or cancelled while the determiner was asked: nothing left to place. A transfer
      // that completed meanwhile is still waiting on this before its file is released.
      if (this.service?.item(record.id) !== record || record.state === 'cancelled') return
      if (determined) suggestion = determined
    }
    let target = candidate
    if (suggestion) {
      const wanted = this.underDownloadDir(suggestion.filename)
      if (wanted) {
        if (suggestion.conflictAction === 'prompt') {
          prompt = true
          target = wanted
        } else if (suggestion.conflictAction === 'overwrite') {
          target = wanted
          this.overwriting.add(record.id)
        } else {
          target = uniquePath(
            dirname(wanted),
            basename(wanted),
            (p) => p !== candidate && this.taken(p)
          )
        }
      }
    }
    if (target !== candidate) this.retarget(record, candidate, target)
    if (prompt) await this.askDestination(item, record, sourceTabId, target)
  }

  /** A relative name resolved under the downloads folder; null when it would escape it. */
  private underDownloadDir(relative: string): string | null {
    const root = downloadDir()
    const full = resolve(root, ...relative.split('/'))
    return full.startsWith(root + sep) ? full : null
  }

  private retarget(record: DownloadItem, from: string, to: string): void {
    this.reserved.delete(from)
    this.reserved.add(to)
    this.finalPaths.set(record.id, to)
    const state =
      record.state === 'paused' || record.state === 'interrupted' ? record.state : 'progressing'
    this.service?.progress(record.id, { finalName: basename(to), state })
  }

  private wire(item: ElectronDownloadItem, record: DownloadItem): void {
    const service = this.service
    if (!service) return
    const fields = (): Pick<DownloadItem, 'receivedBytes' | 'totalBytes' | 'savePath'> => ({
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath: item.getSavePath() || record.savePath
    })
    // The reason the request ended with (see `observeRequests`); Electron's item names none
    // itself, and the core reads a plain network failure into an interruption without one.
    // Taken once per interruption: a resumed transfer's next failure gets its own.
    const reason = (): DownloadInterruptReason | undefined => {
      const live = this.live.get(record.id)
      const known = live?.reason
      if (live) delete live.reason
      return known
    }
    item.on('updated', (_e, state) => {
      if (this.quitting) return
      const interrupted = state === 'interrupted'
      const noted = interrupted ? reason() : undefined
      service.progress(record.id, {
        ...fields(),
        etag: item.getETag() || undefined,
        lastModified: item.getLastModifiedTime() || undefined,
        canResume: interrupted
          ? item.canResume()
          : Boolean(item.getETag() || item.getLastModifiedTime()),
        state: interrupted ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing',
        error: noted
      })
      // Interrupted but resumable (Electron's `updated`): a network-class reason in Chromium's
      // book, `network-failed` unless noted – or the server refusing the range (416), which
      // only asking it tells.
      if (interrupted && !noted) this.investigate(record, item, true)
    })
    item.once('done', (_e, state) => {
      const noted = reason()
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
        // Electron's `done` with `interrupted` is Chromium's "cannot resume": Chromium marks
        // the server's refusals (SERVER_FAILED, SERVER_BAD_CONTENT, SERVER_UNAUTHORIZED,
        // SERVER_FORBIDDEN) non-resumable and every network failure resumable, so an http(s)
        // transfer that reached the server and ends here with nothing noted (its resume
        // requests do not pass the session's `webRequest`) was refused by the server.
        const error = noted ?? (isHttp(record.url) ? 'server-failed' : undefined)
        service.finish(record.id, 'interrupted', { ...fields(), canResume: false, error })
        if (!noted) this.investigate(record, item, false)
      }
    })
  }

  /**
   * Chromium's own resume requests never pass the session's `webRequest`, so when a transfer
   * interrupts with no reason noted the host asks the server itself: one GET of what Chromium's
   * resume sent (`Range: bytes=<received>-` with the record's validator as `If-Range`, the
   * referrer, the session's cookies), aborted as soon as the headers arrive. A refusing status
   * is the exact reason (404 `server-bad-content`, 403 `server-forbidden`, 401 / 407
   * `server-unauthorized`, 416 `server-no-range`, 5xx `server-failed`), and a full answer with
   * no `Content-Range` to a request from past byte 0 is `server-no-range`. When the server
   * answers well the coarse verdict stands for a resumable interruption (`network-failed`),
   * and a non-resumable one reads `file-failed`: the server did not refuse, and Chromium's
   * other non-resumable reasons are the file's. A probe that fails on the network changes
   * nothing. One probe per interruption, http(s) only, `PROBE_TIMEOUT_MS`.
   */
  private investigate(record: DownloadItem, item: ElectronDownloadItem, resumable: boolean): void {
    if (!PROBE_REFUSED_RESUME || !isHttp(record.url)) return
    const ses = this.sessions.get(record.containerId)
    if (!ses) return
    const offset = item.getReceivedBytes()
    const validator =
      item.getETag() || item.getLastModifiedTime() || record.etag || record.lastModified
    void this.probe(record.url, ses, { offset, validator, referrer: record.referrer }).then(
      (answer) => {
        if (!answer) return
        const exact = interruptReasonFromRangeResponse(answer.status, answer.contentRange, offset)
        const reason = exact ?? (resumable ? null : 'file-failed')
        if (reason) this.service?.reclassify(record.id, reason)
      }
    )
  }

  /** The request of `investigate`; null when the server could not be asked or did not answer in time. */
  private probe(
    url: string,
    ses: Session,
    req: { offset: number; validator: string; referrer: string }
  ): Promise<ProbeAnswer | null> {
    return new Promise((resolve) => {
      const key = canonical(url)
      this.probing.add(key)
      let request: ClientRequest
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = (answer: ProbeAnswer | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.probing.delete(key)
        resolve(answer)
      }
      try {
        request = net.request({
          url,
          method: 'GET',
          session: ses,
          credentials: 'include',
          cache: 'no-store'
        })
      } catch {
        finish(null)
        return
      }
      if (req.offset > 0) {
        request.setHeader('Range', `bytes=${req.offset}-`)
        if (req.validator) request.setHeader('If-Range', req.validator)
      }
      if (req.referrer) request.setHeader('Referer', req.referrer)
      timer = setTimeout(() => {
        finish(null)
        request.abort()
      }, PROBE_TIMEOUT_MS)
      request.on('response', (response) => {
        finish({
          status: response.statusCode,
          contentRange: firstHeader(response.headers['content-range'])
        })
        // The headers were the question; the body is not wanted.
        request.abort()
      })
      // A 401 is an answer, not a question: no credentials, and the response comes through.
      request.on('login', (_info, callback) => callback())
      request.on('error', () => finish(null))
      request.on('abort', () => finish(null))
      request.on('close', () => finish(null))
      request.end()
    })
  }

  /**
   * "Always ask where to save" and the menu's "Save … As…": our own dialog, so the partial file
   * stays under our control.
   */
  private async askDestination(
    item: ElectronDownloadItem,
    record: DownloadItem,
    sourceTabId: string | null,
    candidate: string
  ): Promise<void> {
    const parent = this.parentWindow(sourceTabId)
    const options = {
      title: 'Save As',
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
    this.overwriting.delete(id)
  }

  private takePendingStart(item: ElectronDownloadItem): PendingStart | null {
    if (this.pendingStarts.length === 0) return null
    const urls = new Set([item.getURL(), ...item.getURLChain()].map(canonical))
    const index = this.pendingStarts.findIndex((p) => urls.has(canonical(p.request.url)))
    if (index === -1) return null
    return this.pendingStarts.splice(index, 1)[0] ?? null
  }

  // ---------------------------------------------------------------------------
  // Programmatic downloads (the extension API)
  // ---------------------------------------------------------------------------

  /**
   * One determiner at a time (the extension API multiplexes its listeners); null restores the
   * default names. Retries and resumes keep their names and never ask.
   */
  setFilenameDeterminer(determiner: FilenameDeterminer | null): void {
    this.determiner = determiner
  }

  /** Where an in-flight download's file is meant to end up; null once released or unknown. */
  targetPath(id: string): string | null {
    return this.finalPaths.get(id) ?? null
  }

  /**
   * Start a transfer by URL; resolves with its record once the engine announces it (after the
   * response headers), rejects when nothing arrives within a minute.
   */
  startDownload(request: ProgrammaticDownload): Promise<DownloadItem> {
    const ses =
      this.sessions.get(request.containerId ?? DEFAULT_CONTAINER_ID) ??
      this.sessions.values().next().value
    if (!ses) return Promise.reject(new Error('NETWORK_FAILED'))
    return new Promise<DownloadItem>((resolve, reject) => {
      const pending: PendingStart = {
        request,
        resolve: (record) => {
          clearTimeout(timer)
          resolve(record)
        }
      }
      const timer = setTimeout(() => {
        const index = this.pendingStarts.indexOf(pending)
        if (index !== -1) this.pendingStarts.splice(index, 1)
        reject(new Error('NETWORK_TIMEOUT'))
      }, START_TIMEOUT_MS)
      this.pendingStarts.push(pending)
      ses.downloadURL(request.url, request.headers ? { headers: request.headers } : undefined)
    })
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
    const overwrite = this.overwriting.has(item.id)
    this.forget(item.id)
    if (!existsSync(partial)) {
      return existsSync(wanted) ? { savePath: wanted, finalName: basename(wanted) } : null
    }
    const final =
      existsSync(wanted) && wanted !== partial && !overwrite
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

  /** A stat: the file the row points at is there (a folder in its place does not count). */
  async exists(item: DownloadItem): Promise<boolean> {
    if (!item.savePath) return false
    try {
      return (await stat(item.savePath)).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      // Unreadable (permissions, a detached volume): not known to be gone.
      return true
    }
  }

  /**
   * Chrome's "Delete file": `fs.rm` on the released file. Only a plain file goes (never a folder
   * that took its place); `missing` when nothing is there, `failed` when it stays (locked on
   * Windows, no permission).
   */
  async deleteFile(item: DownloadItem): Promise<'deleted' | 'missing' | 'failed'> {
    if (!item.savePath) return 'missing'
    try {
      if (!(await stat(item.savePath)).isFile()) return 'failed'
      await rm(item.savePath)
      return 'deleted'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed'
    }
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

  // Desktop UI plumbing (the shell owns the implementation; the core reaches it through the host).
  startFileDrag(item: DownloadItem, win: ZenWindow): void {
    startFileDrag(item, win, this.appIcon())
  }

  openDownloadsFolder(): void {
    openDownloadsFolder()
  }
}

/** The page a download came from: the source view's committed document, if it has one. */
function referrerOf(source: WebContents | undefined, downloadUrl: string): string {
  if (!source || source.isDestroyed()) return ''
  const url = source.getURL()
  if (!url || url === downloadUrl || !/^https?:/.test(url)) return ''
  return url
}

function isHttp(url: string): boolean {
  return /^https?:/i.test(url)
}

/** The first value of a response header, by name in any case; null when absent or empty. */
function header(headers: Record<string, string[]> | undefined, name: string): string | null {
  if (!headers) return null
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return firstHeader(values)
  }
  return null
}

function firstHeader(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value
  return first !== undefined && first.trim() !== '' ? first : null
}

/** `application/octet-stream; charset=binary` → `application/octet-stream`. */
function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/** URLs as the engine reports them (`HTTP://Example.com/a` and `http://example.com/a` are one). */
function canonical(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
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

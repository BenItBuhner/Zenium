import type { Session, WebContents, WebFrameMain } from 'electron'
import {
  ExtensionErrorRing,
  attributePageMessage,
  consoleLevel,
  extensionIdOfUrl,
  type ExtensionErrorReport
} from '../../core/extensions/errorConsole'
import type { ExtensionErrorEntry } from '../../shared/types'

/**
 * A line that repeats on every request (a listener failing per event) must not commit the app
 * state per line; changes pool this long and the chrome hears once.
 */
export const ERROR_CONSOLE_NOTIFY_DELAY_MS = 250

/** What the console needs of the process: every WebContents there is and will be. */
export interface ErrorConsoleProcess {
  allWebContents(): WebContents[]
  onWebContentsCreated(listener: (contents: WebContents) => void): void
}

/**
 * A page's console line as Electron's `console-message` reports it, the frame resolved to its
 * URL (null when the frame was gone by the time the event arrived).
 */
export interface PageConsoleLine {
  level: string
  message: string
  lineNumber: number
  sourceId: string
  frameUrl: string | null
}

/**
 * A worker's console line (`ServiceWorkers`' `console-message`), with the worker's script and
 * scope when the engine still knows the version.
 */
export interface WorkerConsoleLine {
  level: number
  message: string
  lineNumber: number
  sourceUrl: string
  scriptUrl: string | null
  scope: string | null
}

export interface ErrorConsoleOptions {
  now?: () => number
  /** Lines of extensions this rejects are dropped (one uninstalled while its scripts still ran). */
  accept?: (extensionId: string) => boolean
  notifyDelayMs?: number
}

/**
 * The extensions' error consoles (`ExtensionInfo.errors`), fed from where Electron surfaces what
 * extension code prints and throws: every page's `console-message` (the extension's own
 * documents, and tab pages running its content scripts) and every persistent session's
 * service-worker `console-message` (MV3 workers). Uncaught exceptions and unhandled rejections
 * arrive the same way, as Chromium's "Uncaught ..." error lines. Load failures and manifest
 * warnings come from the extension service directly (`report`).
 */
export class ExtensionErrorConsole {
  private readonly rings = new Map<string, ExtensionErrorRing>()
  private readonly watched = new WeakSet<WebContents>()
  private readonly sessions = new WeakSet<Session>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly accept: (extensionId: string) => boolean
  private readonly notifyDelayMs: number
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ErrorConsoleOptions = {}) {
    this.now = options.now ?? Date.now
    this.accept = options.accept ?? (() => true)
    this.notifyDelayMs = options.notifyDelayMs ?? ERROR_CONSOLE_NOTIFY_DELAY_MS
  }

  /** Hear every page's console: the ones alive already and the ones to come. */
  install(process: ErrorConsoleProcess): void {
    for (const contents of process.allWebContents()) this.watch(contents)
    process.onWebContentsCreated((contents) => this.watch(contents))
  }

  watch(contents: WebContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    contents.on('console-message', (details) => {
      this.pageLine({
        level: details.level,
        message: details.message,
        lineNumber: details.lineNumber,
        sourceId: details.sourceId,
        frameUrl: frameUrl(details.frame) ?? contentsUrl(contents)
      })
    })
  }

  /** Hear the session's service workers (extension workers log through the session, not a page). */
  attachSession(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    ses.serviceWorkers.on('console-message', (_event, details) => {
      const worker = workerOf(ses, details.versionId)
      this.workerLine({
        level: details.level,
        message: details.message,
        lineNumber: details.lineNumber,
        sourceUrl: details.sourceUrl,
        scriptUrl: worker?.scriptUrl ?? null,
        scope: worker?.scope ?? null
      })
    })
  }

  /** A page's line: the extension's own document, or one of its scripts inside a tab page. */
  pageLine(line: PageConsoleLine): void {
    const level = consoleLevel(line.level)
    if (!level) return
    const owner = attributePageMessage(line.frameUrl, line.sourceId)
    if (!owner) return
    this.report(owner.extensionId, {
      level,
      source: owner.source,
      message: line.message,
      url: line.sourceId || null,
      line: line.lineNumber,
      context: line.frameUrl
    })
  }

  /** A worker's line: the extension is the script's, else the worker's (a line without a script). */
  workerLine(line: WorkerConsoleLine): void {
    const level = consoleLevel(line.level)
    if (!level) return
    const extensionId =
      extensionIdOfUrl(line.sourceUrl) ??
      extensionIdOfUrl(line.scriptUrl) ??
      extensionIdOfUrl(line.scope)
    if (!extensionId) return
    this.report(extensionId, {
      level,
      source: 'worker',
      message: line.message,
      url: line.sourceUrl || line.scriptUrl,
      line: line.lineNumber,
      context: line.scriptUrl ?? line.scope
    })
  }

  report(extensionId: string, report: ExtensionErrorReport): void {
    if (!this.accept(extensionId)) return
    let ring = this.rings.get(extensionId)
    if (!ring) {
      ring = new ExtensionErrorRing()
      this.rings.set(extensionId, ring)
    }
    ring.push(report, this.now())
    this.scheduleNotify()
  }

  list(extensionId: string): ExtensionErrorEntry[] {
    return this.rings.get(extensionId)?.list() ?? []
  }

  /** `extension.clearErrors`: the console starts over. */
  clear(extensionId: string): void {
    const ring = this.rings.get(extensionId)
    if (!ring || ring.size === 0) return
    ring.clear()
    this.scheduleNotify()
  }

  /**
   * Drops the lines `predicate` picks. A reload keeps the runtime lines and replaces the load
   * ones, as Chrome does (its manifest errors belong to an install, its runtime errors to the
   * extension).
   */
  remove(extensionId: string, predicate: (entry: ExtensionErrorEntry) => boolean): void {
    const ring = this.rings.get(extensionId)
    if (ring && ring.remove(predicate) > 0) this.scheduleNotify()
  }

  /** The extension is gone (uninstalled): so is its console. */
  forget(extensionId: string): void {
    if (this.rings.delete(extensionId)) this.scheduleNotify()
  }

  /** The extension loaded under another id than the registry had; its console follows. */
  rekey(from: string, to: string): void {
    const ring = this.rings.get(from)
    if (!ring || from === to) return
    this.rings.delete(from)
    this.rings.set(to, ring)
  }

  /** Fires once per pool of changes; returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      for (const listener of this.listeners) listener()
    }, this.notifyDelayMs)
    this.notifyTimer.unref?.()
  }
}

/** The frame's URL, or null once it is disposed (reading a disposed `WebFrameMain` throws). */
function frameUrl(frame: WebFrameMain | null | undefined): string | null {
  if (!frame) return null
  try {
    return frame.url || null
  } catch {
    return null
  }
}

function contentsUrl(contents: WebContents): string | null {
  try {
    return contents.isDestroyed() ? null : contents.getURL() || null
  } catch {
    return null
  }
}

/** The worker of a version, running or not; null when the engine no longer knows the version. */
function workerOf(ses: Session, versionId: number): { scriptUrl: string; scope: string } | null {
  try {
    const running = ses.serviceWorkers.getWorkerFromVersionID(versionId)
    if (running) return { scriptUrl: running.scriptURL, scope: running.scope }
  } catch {
    /* fall through to the registration */
  }
  try {
    const info = ses.serviceWorkers.getInfoFromVersionID(versionId)
    return { scriptUrl: info.scriptUrl, scope: info.scope }
  } catch {
    return null
  }
}

/**
 * The task manager's process list on Electron (`Platform.tasks`, a `TaskHost`; the page is
 * `zen://tasks`, the naming `core/tasks.ts`).
 *
 * `app.getAppMetrics()` is the engine's word on every process – pid, type, working set, private
 * bytes where the OS gives them cheaply, the share of a core since the previous call. The host
 * only PLACES each one: a renderer is a tab's when a tab view's web contents (or one of its
 * out-of-process frames) runs in it, an extension's when a `chrome-extension://<id>/` document
 * does (a background page, a popup, an options page, an offscreen document, the side panel), a
 * DevTools frontend's when a toolbox does, a window's own chrome when the window's web contents
 * does – all through `webContents.getAllWebContents()`, which lists every one of them. What is
 * left is a renderer with no frame the engine will name: the spare renderer Chromium keeps
 * warm, a process being torn down, or an MV3 extension's service worker alone in its process
 * (Electron says which VIRTUAL process a worker runs in, `ServiceWorkerInfo.renderProcessId`,
 * never the OS pid; when the extension has any document open the worker's process is placed
 * through it, when it has none the row reads "Renderer").
 *
 * Network is counted where it is cheap: the request multiplexer's `onCompleted` already fires
 * for every request of every session, and a tab id rides on each; the host adds the response's
 * `content-length` to the tab's count and hands the page bytes per second at the next sample.
 * The count runs only while the page samples (it stops a few seconds after the last ask), so a
 * closed task manager costs nothing.
 *
 * End process: a renderer the host can see a web contents of is crashed in place with
 * `forcefullyCrashRenderer()` – the tab shows its crashed page and reloads on demand, the way
 * Chrome's task manager ends a tab – and a helper is killed. The browser process is refused
 * (quitting has its own verb), and so is a pid that is no longer one of ours.
 */
import { app, webContents as electronWebContents, type WebContents } from 'electron'
import type { TaskHost, TaskSample } from '../../core/platform'
import type { TaskKind } from '../../shared/types'
import type { WebRequestMultiplexer } from './webRequest'

/** `app.getAppMetrics()`'s row, the part the host reads. */
export interface EngineProcess {
  pid: number
  type: string
  serviceName?: string
  name?: string
  cpuPercent: number
  /** Kilobytes, as the engine reports them. */
  workingSetKb: number
  privateKb?: number
}

/** One frame of a web contents: its own renderer when the engine put it out of process. */
export interface EngineFrame {
  osProcessId: number
  url: string
}

/** A live web contents, the part the host reads. */
export interface EngineContents {
  id: number
  osProcessId: number
  url: string
  /** The frames under the main one, with their renderers (an out-of-process iframe runs in its own). */
  frames: EngineFrame[]
  /** The toolbox open on these contents, when one is. */
  devToolsContentsId: number | null
  /** `forcefullyCrashRenderer()`. */
  crash(): void
}

/** What the engine gives, behind one surface so the mapping can be driven without Electron. */
export interface TaskEngine {
  processes(): EngineProcess[]
  contents(): EngineContents[]
  /** The browser process's own pid. */
  browserPid(): number
  kill(pid: number): boolean
}

export interface ElectronTaskHostOptions {
  /** The tab a web contents is the view of, when it is one. */
  tabIdForWebContents(id: number): string | undefined
  /**
   * The core's id of the window whose chrome these web contents are, when they are a window's
   * (`ElectronWindowFactory.windowForWebContents`); null for a page, an extension's document.
   */
  chromeWindowId(id: number): string | null
  engine?: TaskEngine
  now?: () => number
}

/** The network count stops this long after the last sample: the page has closed or hidden. */
export const NETWORK_IDLE_MS = 10_000

interface Placement {
  kind: TaskKind
  tabIds: string[]
  extensionId: string | null
  devtoolsForTabId: string | null
  /** The window whose chrome runs here, when one does. */
  windowId: string | null
  serviceName: string | null
}

/** How the kinds rank when one process hosts several things (a tab's frame beside an extension's). */
const PLACEMENT_RANK: Record<TaskKind, number> = {
  tab: 0,
  extension: 1,
  devtools: 2,
  browser: 3,
  renderer: 4,
  gpu: 5,
  utility: 6,
  other: 7
}

export class ElectronTaskHost implements TaskHost {
  private readonly engine: TaskEngine
  private readonly now: () => number
  private multiplexer: WebRequestMultiplexer | null = null
  private detachNetwork: (() => void) | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Bytes received per tab since the last sample. */
  private readonly bytesByTab = new Map<string, number>()
  private lastSampleAt: number | null = null
  /** The pids of the last sample: `end()` ends nothing the page has not been shown. */
  private lastPids = new Map<number, TaskKind>()

  constructor(private readonly options: ElectronTaskHostOptions) {
    this.engine = options.engine ?? electronEngine()
    this.now = options.now ?? Date.now
  }

  /** The request multiplexer to count network on; wired once the blocking engine exists (`start`). */
  attachNetwork(multiplexer: WebRequestMultiplexer): void {
    this.multiplexer = multiplexer
  }

  sample(): TaskSample[] {
    const now = this.now()
    const counting = this.beginCounting()
    const elapsedSeconds =
      counting && this.lastSampleAt !== null
        ? Math.max(0.001, (now - this.lastSampleAt) / 1000)
        : null
    const placements = this.place()
    const browserPid = this.engine.browserPid()
    const samples: TaskSample[] = []
    for (const process of this.engine.processes()) {
      const placement = placements.get(process.pid)
      const base = classify(process, placement, browserPid)
      const network =
        elapsedSeconds !== null && base.kind === 'tab'
          ? this.bytesOf(base.tabIds) / elapsedSeconds
          : null
      samples.push({
        pid: process.pid,
        kind: base.kind,
        tabIds: base.tabIds,
        extensionId: base.extensionId,
        devtoolsForTabId: base.devtoolsForTabId,
        windowId: base.windowId,
        serviceName: base.serviceName,
        memoryBytes: Math.round(process.workingSetKb * 1024),
        privateBytes: process.privateKb === undefined ? null : Math.round(process.privateKb * 1024),
        cpuPercent: Number.isFinite(process.cpuPercent) ? process.cpuPercent : 0,
        networkBytesPerSecond: network === null ? null : Math.round(network)
      })
    }
    this.bytesByTab.clear()
    this.lastSampleAt = now
    this.lastPids = new Map(samples.map((s) => [s.pid, s.kind]))
    return samples
  }

  end(pid: number): boolean {
    const kind = this.lastPids.get(pid)
    if (kind === undefined || kind === 'browser' || kind === 'other') return false
    if (pid === this.engine.browserPid()) return false
    // Crash the renderer in place where a web contents runs in it: the tab keeps its row and
    // its crashed page, an extension's pages come back on their next open.
    const hosted = this.engine.contents().filter((c) => c.osProcessId === pid)
    if (hosted.length) {
      let crashed = false
      for (const contents of hosted) {
        try {
          contents.crash()
          crashed = true
        } catch {
          // Gone between the sample and the verb.
        }
      }
      if (crashed) return true
    }
    return this.engine.kill(pid)
  }

  /** Stop counting (a quit, a test): the listener goes, nothing is owed. */
  dispose(): void {
    this.stopCounting()
  }

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------

  private place(): Map<number, Placement> {
    const placements = new Map<number, Placement>()
    const contents = this.engine.contents()
    const toolboxes = new Map<number, string | null>()
    for (const c of contents) {
      if (c.devToolsContentsId === null) continue
      toolboxes.set(c.devToolsContentsId, this.options.tabIdForWebContents(c.id) ?? null)
    }
    const put = (pid: number, next: Placement): void => {
      if (pid <= 0) return
      const current = placements.get(pid)
      if (!current) {
        placements.set(pid, next)
        return
      }
      // One process, several things in it: keep the highest-ranking kind and every tab id.
      const kind =
        PLACEMENT_RANK[next.kind] < PLACEMENT_RANK[current.kind] ? next.kind : current.kind
      const tabIds = [...current.tabIds]
      for (const id of next.tabIds) if (!tabIds.includes(id)) tabIds.push(id)
      placements.set(pid, {
        kind,
        tabIds,
        extensionId: current.extensionId ?? next.extensionId,
        devtoolsForTabId: current.devtoolsForTabId ?? next.devtoolsForTabId,
        windowId: current.windowId ?? next.windowId,
        serviceName:
          kind === next.kind ? (next.serviceName ?? current.serviceName) : current.serviceName
      })
    }
    for (const c of contents) {
      const tabId = this.options.tabIdForWebContents(c.id)
      if (tabId !== undefined) {
        put(c.osProcessId, placement('tab', { tabIds: [tabId] }))
        // An out-of-process iframe's renderer is the tab's too, named for the frame's site.
        for (const frame of c.frames) {
          if (frame.osProcessId === c.osProcessId) continue
          put(
            frame.osProcessId,
            placement('renderer', { tabIds: [tabId], serviceName: subframeName(frame.url) })
          )
        }
        continue
      }
      const toolbox = toolboxes.get(c.id)
      if (toolbox !== undefined) {
        put(c.osProcessId, placement('devtools', { devtoolsForTabId: toolbox }))
        continue
      }
      const extensionId = extensionIdOf(c.url)
      if (extensionId !== null) {
        put(c.osProcessId, placement('extension', { extensionId }))
        continue
      }
      const windowId = this.options.chromeWindowId(c.id)
      if (windowId !== null) {
        put(c.osProcessId, placement('browser', { serviceName: 'Browser window', windowId }))
        continue
      }
      put(c.osProcessId, placement('renderer', { serviceName: rendererName(c.url) }))
    }
    return placements
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  /** Start counting on the first sample; returns whether a count is running. */
  private beginCounting(): boolean {
    if (!this.multiplexer) return false
    if (!this.detachNetwork) {
      this.detachNetwork = this.multiplexer.addListener(
        'onCompleted',
        (details) => {
          if (details.tabId === null) return
          const length = contentLength(details.responseHeaders)
          if (length <= 0) return
          this.bytesByTab.set(details.tabId, (this.bytesByTab.get(details.tabId) ?? 0) + length)
        },
        { registrant: 'zenium:tasks' }
      )
      this.lastSampleAt = null
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stopCounting(), NETWORK_IDLE_MS)
    this.idleTimer.unref?.()
    return true
  }

  private stopCounting(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.detachNetwork?.()
    this.detachNetwork = null
    this.bytesByTab.clear()
    this.lastSampleAt = null
  }

  private bytesOf(tabIds: readonly string[]): number {
    let total = 0
    for (const id of tabIds) total += this.bytesByTab.get(id) ?? 0
    return total
  }
}

function placement(kind: TaskKind, part: Partial<Placement>): Placement {
  return {
    kind,
    tabIds: part.tabIds ?? [],
    extensionId: part.extensionId ?? null,
    devtoolsForTabId: part.devtoolsForTabId ?? null,
    windowId: part.windowId ?? null,
    serviceName: part.serviceName ?? null
  }
}

/** The engine's process type and the placement, folded to one row's kind and words. */
export function classify(
  process: EngineProcess,
  placement: Placement | undefined,
  browserPid: number
): Placement {
  if (process.type === 'Browser' || process.pid === browserPid) return placementOf('browser', null)
  // The coined names are sentence case (§4, like the core's "GPU process"); the engine's own
  // (`utilityName`, `process.name`) stay as given.
  switch (process.type) {
    case 'Tab':
      return placement ?? placementOf('renderer', null)
    case 'GPU':
      return placementOf('gpu', null)
    case 'Utility':
      return placementOf('utility', utilityName(process))
    case 'Zygote':
      return placementOf('other', 'Zygote')
    case 'Sandbox helper':
      return placementOf('other', 'Sandbox helper')
    case 'Pepper Plugin':
      return placementOf('other', 'Plugin')
    case 'Pepper Plugin Broker':
      return placementOf('other', 'Plugin broker')
    default:
      return placement ?? placementOf('other', process.name || null)
  }
}

function placementOf(kind: TaskKind, serviceName: string | null): Placement {
  return {
    kind,
    tabIds: [],
    extensionId: null,
    devtoolsForTabId: null,
    windowId: null,
    serviceName
  }
}

/**
 * A utility process's name: the engine's human one ("Network Service", "Audio Service") when it
 * has it, else the mojo name with its prefix and suffix cut ("network.mojom.NetworkService" →
 * "Network Service").
 */
export function utilityName(process: EngineProcess): string | null {
  if (process.name) return process.name
  if (!process.serviceName) return null
  const last = process.serviceName.split('.').pop() ?? process.serviceName
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || null
}

/** The extension an extension document belongs to, from its origin. */
export function extensionIdOf(url: string): string | null {
  if (!url.startsWith('chrome-extension://')) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function subframeName(url: string): string {
  const host = hostOf(url)
  return host ? `Subframe: ${host}` : 'Subframe'
}

function rendererName(url: string): string | null {
  const host = hostOf(url)
  return host ? `Renderer: ${host}` : null
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.host || parsed.protocol.replace(/:$/, '') || null
  } catch {
    return null
  }
}

/** The response's `content-length`, case-insensitively; 0 when absent or not a number. */
export function contentLength(headers: Record<string, string[]> | undefined): number {
  if (!headers) return 0
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') continue
    const value = Number(values[0])
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  return 0
}

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------

function electronEngine(): TaskEngine {
  return {
    processes: () =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        serviceName: m.serviceName,
        name: m.name,
        cpuPercent: m.cpu.percentCPUUsage,
        workingSetKb: m.memory.workingSetSize,
        privateKb: m.memory.privateBytes
      })),
    contents: () => {
      const out: EngineContents[] = []
      for (const wc of electronWebContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        const pid = pidOf(wc)
        if (pid === null) continue
        out.push({
          id: wc.id,
          osProcessId: pid,
          url: safeUrl(wc),
          frames: framesOf(wc),
          devToolsContentsId: toolboxOf(wc),
          crash: () => wc.forcefullyCrashRenderer()
        })
      }
      return out
    },
    browserPid: () => process.pid,
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGKILL')
        return true
      } catch {
        return false
      }
    }
  }
}

function pidOf(wc: WebContents): number | null {
  try {
    const pid = wc.getOSProcessId()
    return pid > 0 ? pid : null
  } catch {
    return null
  }
}

function safeUrl(wc: WebContents): string {
  try {
    return wc.getURL()
  } catch {
    return ''
  }
}

function framesOf(wc: WebContents): EngineFrame[] {
  const out: EngineFrame[] = []
  try {
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame.detached || frame === wc.mainFrame) continue
      if (frame.osProcessId > 0) out.push({ osProcessId: frame.osProcessId, url: frame.url })
    }
  } catch {
    // Frames are being torn down.
  }
  return out
}

function toolboxOf(wc: WebContents): number | null {
  try {
    const frontend = wc.devToolsWebContents
    return frontend && !frontend.isDestroyed() ? frontend.id : null
  } catch {
    return null
  }
}

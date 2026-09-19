import type { ScreenCaptureRequest, ScreenCaptureSource, Tab } from '../shared/types'
import { newId } from '../shared/ids'
import { displayHost } from '../shared/url'
import type { Browser } from './browser'

/** What the host hands the engine once the picker answered. */
export interface ScreenCaptureAnswer {
  /** The picked source's id (`screen:…`, `window:…`, `tab:<tabId>`), or null when the user cancelled. */
  sourceId: string | null
  /** Share the system's audio too (only ever true for a screen where the OS allows it). */
  audio: boolean
}

export interface ScreenCaptureRequestInit {
  tabId: string
  /** The requesting frame's URL (its origin names the site in the picker). */
  url: string
  /** The page asked for audio (`getDisplayMedia({ audio: true })`). */
  audio: boolean
}

export interface ScreenCaptureServiceOptions {
  now?: () => number
}

interface Pending {
  request: ScreenCaptureRequest
  resolve: (answer: ScreenCaptureAnswer) => void
}

/** How a tab shows in the picker's "Zenium tab" section: this tab, as Chrome offers the caller. */
export function tabSource(tab: { id: string; title: string; favicon?: string | null }): ScreenCaptureSource {
  return {
    id: `tab:${tab.id}`,
    name: tab.title || 'This tab',
    kind: 'tab',
    thumbnail: null,
    icon: tab.favicon ?? null
  }
}

/** The tab id a `tab:` source names, or null for a screen or window. */
export function tabIdOfSource(sourceId: string): string | null {
  return sourceId.startsWith('tab:') ? sourceId.slice(4) : null
}

/**
 * Screen capture (MW-19): a page's `getDisplayMedia` becomes a request the chrome shows as
 * Chrome's picker – Entire screen, Window, Zenium tab, with the "Also share system audio" box
 * where the OS can – and the answer goes back to the host, which hands the engine the picked
 * source. The picker is the permission: no separate prompt, a cancel is a refusal for this
 * call alone (Chrome does not remember screen-share decisions either).
 *
 * The OS's list arrives after the request is up (`loading` until then); on Wayland the desktop
 * portal's own dialog shows first and the list holds the one source it granted.
 */
export class ScreenCaptureService {
  private readonly pending: Pending[] = []
  private readonly now: () => number

  constructor(
    private readonly browser: Browser,
    options: ScreenCaptureServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  list(): ScreenCaptureRequest[] {
    return this.pending.map((p) => p.request)
  }

  /**
   * A page asked to capture. Resolves with the picker's answer; a second call from the same tab
   * while its picker is up cancels the first (Chrome shows one picker per tab).
   */
  request(init: ScreenCaptureRequestInit): Promise<ScreenCaptureAnswer> {
    const tab = this.browser.tabs.tab(init.tabId)
    if (!tab) return Promise.resolve({ sourceId: null, audio: false })
    this.cancelForTab(init.tabId)
    const host = this.browser.platform.screenCapture
    const request: ScreenCaptureRequest = {
      id: newId('capture'),
      tabId: init.tabId,
      origin: displayHost(init.url) || init.url,
      audio: init.audio,
      systemAudio: init.audio && Boolean(host?.systemAudio()),
      loading: Boolean(host),
      sources: this.tabSources(tab),
      requestedAt: this.now()
    }
    const promise = new Promise<ScreenCaptureAnswer>((resolve) => {
      this.pending.push({ request, resolve })
    })
    this.browser.state.commitVolatile()
    if (host) void this.loadSources(request.id, host)
    return promise
  }

  /**
   * The picker's "Zenium tab" section: the calling tab first (Chrome's "This tab"), then the
   * other tabs of its window whose page is alive – a discarded tab has nothing to capture.
   */
  private tabSources(tab: Tab): ScreenCaptureSource[] {
    const out = [tabSource(tab)]
    const win = this.browser.tabs.ownerOf(tab.id)
    if (!win) return out
    for (const [tabId, view] of this.browser.tabs.viewsOwnedBy(win)) {
      if (tabId === tab.id || view.isDestroyed()) continue
      const other = this.browser.tabs.tab(tabId)
      if (other) out.push(tabSource(other))
    }
    return out
  }

  private async loadSources(
    id: string,
    host: NonNullable<Browser['platform']['screenCapture']>
  ): Promise<void> {
    let sources: ScreenCaptureSource[] = []
    try {
      sources = await host.sources(['screen', 'window'])
    } catch {
      /* the OS refused (no portal, no permission): the tab stays on offer */
    }
    this.setSources(id, sources)
  }

  /** The host's list arrived (screens and windows; the tab entry stays first). */
  setSources(id: string, sources: ScreenCaptureSource[]): void {
    const entry = this.pending.find((p) => p.request.id === id)
    if (!entry) return
    const tabs = entry.request.sources.filter((s) => s.kind === 'tab')
    entry.request = {
      ...entry.request,
      loading: false,
      sources: [...sources.filter((s) => s.kind !== 'tab'), ...tabs]
    }
    this.browser.state.commitVolatile()
  }

  /** The chrome's answer: a source, or null to cancel. */
  respond(id: string, sourceId: string | null, audio = false): void {
    const index = this.pending.findIndex((p) => p.request.id === id)
    if (index < 0) return
    const [entry] = this.pending.splice(index, 1)
    const source = sourceId ? entry.request.sources.find((s) => s.id === sourceId) : undefined
    const picked = source ? source.id : null
    // System audio comes with a screen only, and only where the OS offers it.
    const withAudio = Boolean(picked && audio && entry.request.systemAudio && source?.kind === 'screen')
    entry.resolve({ sourceId: picked, audio: withAudio })
    this.browser.state.commitVolatile()
  }

  /** The tab navigated or closed: its picker goes, the page gets a refusal. */
  cancelForTab(tabId: string): void {
    const gone = this.pending.filter((p) => p.request.tabId === tabId)
    if (gone.length === 0) return
    for (const entry of gone) {
      this.pending.splice(this.pending.indexOf(entry), 1)
      entry.resolve({ sourceId: null, audio: false })
    }
    this.browser.state.commitVolatile()
  }
}

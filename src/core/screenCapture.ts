import type {
  ScreenCaptureKind,
  ScreenCaptureRequest,
  ScreenCaptureSource,
  Tab
} from '../shared/types'
import { newId } from '../shared/ids'
import { displayHost } from '../shared/url'
import type { Browser } from './browser'
import { surfaceMounted } from './window'

/** What the host hands the engine once the picker answered. */
export interface ScreenCaptureAnswer {
  /** The picked source's id (`screen:…`, `window:…`, `tab:<tabId>`), or null when the user cancelled. */
  sourceId: string | null
  /** Share the system's audio too (only ever true for a screen where the OS allows it). */
  audio: boolean
}

/** The picker's panes in its order: Chrome's tab pane leads, then windows, then screens. */
export const SCREEN_CAPTURE_KINDS: readonly ScreenCaptureKind[] = ['tab', 'window', 'screen']

export interface ScreenCaptureRequestInit {
  tabId: string
  /**
   * The requesting frame's URL (its origin names the site in the picker). For an extension's
   * call, the URL of the tab it captures for, or empty when its own page consumes the stream.
   */
  url: string
  /** The page asked for audio (`getDisplayMedia({ audio: true })`). */
  audio: boolean
  /**
   * An extension asking (`chrome.desktopCapture`): the picker names it, with its icon, in the
   * site's place. A page's own call has none.
   */
  extension?: { name: string; icon: string | null }
  /** The kinds to offer; Chrome's picker shows the panes the extension asked for. All three when absent. */
  kinds?: readonly ScreenCaptureKind[]
  /** The extension asked to leave the system's audio out (`options.systemAudio: "exclude"`). */
  excludeSystemAudio?: boolean
  /** The extension asked to leave the capturing tab out of the tab pane (`selfBrowserSurface: "exclude"`). */
  excludeSelf?: boolean
}

export interface ScreenCaptureServiceOptions {
  now?: () => number
}

interface Pending {
  request: ScreenCaptureRequest
  resolve: (answer: ScreenCaptureAnswer) => void
}

/** How a tab shows in the picker's "Zenium tab" section: this tab, as Chrome offers the caller. */
export function tabSource(tab: {
  id: string
  title: string
  favicon?: string | null
}): ScreenCaptureSource {
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
 * An extension's `chrome.desktopCapture.chooseDesktopMedia` is the same picker with the
 * extension's name and icon in the site's place and the panes it asked for (`kinds`); the
 * browser layer of the extension API makes the request and hands the extension the id. It is
 * modal to the tab it names (`targetTab`, or the calling page's own tab; for a document without
 * one, the focused window's active tab) as Chrome's dialog is web-modal to that tab
 * (`DesktopMediaPickerDialogView`): a tab at the back holds its picker until it is in front.
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
   * while its picker is up cancels the first (Chrome shows one picker per tab). A window whose
   * chrome has no picker up (`ChromeSurface`) answers at once as a cancelled picker would – the
   * page hears Chrome's refusal – rather than holding the call for a picker that is not there.
   */
  request(init: ScreenCaptureRequestInit): Promise<ScreenCaptureAnswer> {
    return this.open(init).answer
  }

  /**
   * `request` with the request's id alongside its answer, for a caller that may have to take
   * the picker down itself (an extension's `cancelChooseDesktopMedia`); null when nothing was
   * put up and the answer is the refusal at once.
   */
  open(init: ScreenCaptureRequestInit): {
    id: string | null
    answer: Promise<ScreenCaptureAnswer>
  } {
    const refused = { id: null, answer: Promise.resolve({ sourceId: null, audio: false }) }
    const tab = this.browser.tabs.tab(init.tabId)
    if (!tab) return refused
    this.cancelForTab(init.tabId)
    if (!surfaceMounted(this.browser.tabs.ownerOf(init.tabId), 'screenCapture')) return refused
    // The panes, in the picker's order; a call that asks for none has nothing to pick from.
    const kinds = SCREEN_CAPTURE_KINDS.filter((k) => !init.kinds || init.kinds.includes(k))
    if (kinds.length === 0) return refused
    const osKinds = (['screen', 'window'] as const).filter((k) => kinds.includes(k))
    const host = this.browser.platform.screenCapture
    const request: ScreenCaptureRequest = {
      id: newId('capture'),
      tabId: init.tabId,
      origin: displayHost(init.url) || init.url,
      extension: init.extension ?? null,
      kinds,
      audio: init.audio,
      systemAudio:
        init.audio &&
        !init.excludeSystemAudio &&
        kinds.includes('screen') &&
        Boolean(host?.systemAudio()),
      loading: Boolean(host) && osKinds.length > 0,
      sources: kinds.includes('tab') ? this.tabSources(tab, init.excludeSelf === true) : [],
      requestedAt: this.now()
    }
    const promise = new Promise<ScreenCaptureAnswer>((resolve) => {
      this.pending.push({ request, resolve })
    })
    this.browser.state.commitVolatile()
    if (host && osKinds.length > 0) void this.loadSources(request.id, host, osKinds)
    return { id: request.id, answer: promise }
  }

  /**
   * The picker's "Zenium tab" section: the calling tab first (Chrome's "This tab"), then the
   * other tabs of its window whose page is alive – a discarded tab has nothing to capture.
   * An extension may ask to leave the calling tab out (`excludeSelf`).
   */
  private tabSources(tab: Tab, excludeSelf: boolean): ScreenCaptureSource[] {
    const out = excludeSelf ? [] : [tabSource(tab)]
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
    host: NonNullable<Browser['platform']['screenCapture']>,
    kinds: Array<'screen' | 'window'>
  ): Promise<void> {
    let sources: ScreenCaptureSource[] = []
    try {
      sources = await host.sources(kinds)
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
    const withAudio = Boolean(
      picked && audio && entry.request.systemAudio && source?.kind === 'screen'
    )
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

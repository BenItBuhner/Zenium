import type { MediaState } from '../shared/types'
import {
  pickArtwork,
  reportIsPlaying,
  type MediaReport,
  type MediaSessionAction,
  type MediaSessionHostMessage,
  type MediaSessionInfo,
  type MediaSessionSource,
  type MediaSessionSourceHandle
} from '../shared/mediaSession'
import { displayHost } from '../shared/url'
import type { Browser } from './browser'
import { permissionSite } from './permissions'
import type { ZenWindow } from './window'

/**
 * Chrome shows no media controls for a clip this short (a notification sound, a UI effect):
 * `MediaSession` waits for a duration of at least this many seconds before it takes an element.
 */
export const MIN_SESSION_DURATION_S = 5

/** The content setting the desktop's automatic picture-in-picture obeys: Chrome's row of the same name. */
export const AUTO_PIP_SETTING = 'auto-picture-in-picture'

/**
 * How long after a window's blur the desktop waits before it counts the user as gone from the
 * app: a focus that only moves to another Zenium window arrives within this and leaves the
 * video where it is, as that window is still the user's.
 */
export const AUTO_PIP_BLUR_GRACE_MS = 150

/**
 * The page side of an automatic entry: the largest video playing that does not forbid the small
 * window goes in; `'held'` when the page already has one there (the user's own, left alone).
 * With `hiddenOnly` the entry is for a document the user cannot see – Chrome's rule for its
 * automatic picture-in-picture, read where Chrome reads it: `document.visibilityState`, which
 * Chromium computes from the window's own state (minimized, or covered by another window on the
 * platforms where it tracks occlusion natively – Windows and macOS; not X11) – and a document
 * still visible answers `'visible'` and keeps its video where the user is watching it.
 */
const AUTO_PIP_HIDDEN_GUARD = "if (document.visibilityState !== 'hidden') return 'visible'"

function autoPipEnter(hiddenOnly: boolean): string {
  return `(async () => {
  ${hiddenOnly ? AUTO_PIP_HIDDEN_GUARD : ''}
  if (document.pictureInPictureElement) return 'held'
  const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture && !v.paused && !v.ended)
  const video = videos.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0]
  if (!video) return false
  await video.requestPictureInPicture()
  return true
})()`
}

const AUTO_PIP_LEAVE = `(async () => {
  if (!document.pictureInPictureElement) return false
  await document.exitPictureInPicture()
  return true
})()`

/** What the desktop put into the small window of its own accord, and whether the page confirmed it. */
interface AutoPip {
  tabId: string
  /** The page reported its picture-in-picture element (`capture-state`): a later report without one is the user closing it. */
  confirmed: boolean
}

interface TabReport {
  report: MediaReport
  /** When the report arrived (epoch ms): the reference `position` is extrapolated from. */
  at: number
  /** When this tab's media last started playing, for choosing between tabs. */
  startedAt: number
}

/** What a chrome player says about itself (`MediaSessionSource` without its `onAction`). */
type SourceState = Omit<MediaSessionSource, 'onAction'>

/** A chrome player (`registerSource`) as the resolution tracks it, next to the pages' reports. */
interface TrackedSource {
  /** The player as registered: what its actions go to. */
  source: MediaSessionSource
  /** The player as it last described itself (the engine's copy; `update` patches it). */
  state: SourceState
  /** When the source last reported (epoch ms): the reference its `position` is extrapolated from. */
  at: number
  /** When the source last started playing, for choosing between candidates. */
  startedAt: number
}

/** The candidate holding the session: a page (its tab) or a chrome player (its id). */
type SessionRef = { kind: 'page'; tabId: string } | { kind: 'source'; id: string }

/**
 * The media of the pages, as the OS controls and the in-app player see it. Every host feeds the
 * tab's `audible` flag; hosts whose page script tracks the Media Session (Android) send the
 * full report – the element playing, its position, the page's `navigator.mediaSession` metadata
 * and handlers – and this service resolves one session from them: the page playing (the most
 * recent to start when several are), or the one that played last while everything is paused,
 * as Chrome's media notification stays up in paused form until it is dismissed or its tab goes.
 * The host's controls send their actions back through `act`, which the tab's page carries out:
 * its own handler where it registered one, the element otherwise (the page script decides).
 *
 * Something of the chrome's own that plays – the read-aloud player – joins the resolution as a
 * candidate through `registerSource`, by the same rule as a page; its session reaches the OS
 * controls with `source: 'chrome'`, and their actions come back to it through `act`.
 */
export class MediaSessionService {
  private readonly reports = new Map<string, TabReport>()
  /** Tabs whose paused session the user dismissed (a swipe on the notification, `stop`): shown again once they play. */
  private readonly dismissed = new Set<string>()
  /** The chrome's players, by id. */
  private readonly sources = new Map<string, TrackedSource>()
  /** Sources whose paused session the user dismissed: shown again once they report playing. */
  private readonly dismissedSources = new Set<string>()
  /** The tab whose media the OS controls show (a source's tab when a source holds the session). */
  private sessionTabId: string | null = null
  /** Who holds the session: a page or a source; null for none. */
  private held: SessionRef | null = null
  /** The tab whose video the window is showing as picture-in-picture, as the host reported. */
  private pipTabId: string | null = null
  private lastSent: string | null = null
  /** The desktop's automatic picture-in-picture, while a video is in the small window on its account. */
  private autoPip: AutoPip | null = null
  /** The tabs each window showed at the last look (`onVisibleTabsChanged`), by window id. */
  private readonly shown = new Map<string, string[]>()
  private blurTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The page script's report (a `media` page message carrying `media`). */
  onReport(tabId: string, report: MediaReport): void {
    if (!isReport(report)) return
    const at = this.now()
    const before = this.reports.get(tabId)
    if (!hasMedia(report)) {
      this.reports.delete(tabId)
      this.dismissed.delete(tabId)
      return
    }
    const playing = reportIsPlaying(report)
    const wasPlaying = before ? reportIsPlaying(before.report) : false
    if (playing) this.dismissed.delete(tabId)
    this.reports.set(tabId, {
      report,
      at,
      startedAt: playing && !wasPlaying ? at : (before?.startedAt ?? 0)
    })
  }

  /** The tab the OS controls show right now (a source's tab when a source holds them), or null. */
  get sessionTab(): string | null {
    return this.sessionTabId
  }

  /** The id of the chrome player holding the session, or null when a page does or none. */
  get sessionSource(): string | null {
    return this.held?.kind === 'source' ? this.held.id : null
  }

  /**
   * A player of the chrome's own – the read-aloud player – as a candidate for the session next
   * to the pages: it holds the session by the same rule (playing beats paused; among the playing
   * the latest to start; while nothing plays, the last that played, until `stop` or `release`),
   * reaches the OS controls with `source: 'chrome'` and the in-app list as its tab's entry, and
   * the controls' actions come back to `source.onAction`. One source per id: a re-register
   * replaces the earlier one (whose handle goes inert). Its tab closing drops it, as it does a
   * page's report.
   */
  registerSource(source: MediaSessionSource): MediaSessionSourceHandle {
    const at = this.now()
    const before = this.sources.get(source.id)
    const wasPlaying = before?.state.playing ?? false
    const tracked: TrackedSource = {
      source,
      state: sourceState(source, {}),
      at,
      startedAt: source.playing && !wasPlaying ? at : (before?.startedAt ?? 0)
    }
    if (source.playing) this.dismissedSources.delete(source.id)
    this.sources.set(source.id, tracked)
    this.browser.updateMedia()
    return {
      update: (patch) => {
        if (this.sources.get(source.id) !== tracked) return
        const now = this.now()
        const playingBefore = tracked.state.playing
        tracked.state = sourceState(tracked.state, patch)
        tracked.at = now
        if (tracked.state.playing && !playingBefore) tracked.startedAt = now
        if (tracked.state.playing) this.dismissedSources.delete(source.id)
        this.browser.updateMedia()
      },
      release: () => {
        if (this.sources.get(source.id) !== tracked) return
        this.sources.delete(source.id)
        this.dismissedSources.delete(source.id)
        this.browser.updateMedia()
      }
    }
  }

  /**
   * The media list for the chrome (`UIState.media`), and the session for the host's controls,
   * recomputed from the live views: tabs whose view is gone drop out (their notification with
   * them), so a closed tab ends its session as Chrome's does. A chrome player is its tab's entry
   * while the tab's page has no media of its own; with both, the page's entry stays.
   */
  refresh(): MediaState[] {
    const { tabs } = this.browser
    const live = new Set<string>()
    const states: MediaState[] = []
    for (const [tabId, view] of tabs.allViews()) {
      if (view.isDestroyed()) continue
      live.add(tabId)
      const tracked = this.reports.get(tabId)
      const playing = view.isCurrentlyAudible()
      if (!tracked && !playing) continue
      const state: MediaState = { tabId, playing }
      if (tracked) {
        const { report } = tracked
        const tab = tabs.tab(tabId)
        const isPrivate = tab ? tabs.isPrivate(tab) : false
        state.title = isPrivate ? '' : report.metadata?.title || (tab?.title ?? '')
        state.artist = isPrivate ? '' : report.metadata?.artist || siteOf(tab?.url ?? '')
        state.album = isPrivate ? '' : (report.metadata?.album ?? '')
        state.artwork = isPrivate
          ? null
          : report.metadata
            ? pickArtwork(report.metadata.artwork)
            : null
        state.video = report.video
        state.position = report.position
        state.positionAt = tracked.at
        state.actions = report.actions
        state.pictureInPicture = this.pipTabId === tabId
        if (isPrivate) state.private = true
      }
      states.push(state)
    }
    for (const tabId of [...this.reports.keys()]) {
      if (!live.has(tabId)) {
        this.reports.delete(tabId)
        this.dismissed.delete(tabId)
      }
    }
    for (const [id, tracked] of [...this.sources]) {
      const { state: source } = tracked
      if (!live.has(source.tabId)) {
        this.sources.delete(id)
        this.dismissedSources.delete(id)
        continue
      }
      if (states.some((state) => state.tabId === source.tabId)) continue
      const tab = tabs.tab(source.tabId)
      const isPrivate = tab ? tabs.isPrivate(tab) : false
      states.push({
        tabId: source.tabId,
        playing: source.playing,
        title: isPrivate ? '' : source.title,
        artist: isPrivate ? '' : source.artist,
        album: '',
        artwork: isPrivate ? null : (source.artwork ?? null),
        video: false,
        position: source.position ?? null,
        positionAt: tracked.at,
        actions: [...source.actions],
        source: 'chrome'
      })
    }
    if (this.pipTabId && !live.has(this.pipTabId)) this.pipTabId = null
    if (this.autoPip && !live.has(this.autoPip.tabId)) this.autoPip = null
    this.held = this.pickSession()
    this.sessionTabId = this.tabOf(this.held)
    for (const state of states) if (state.tabId === this.sessionTabId) state.session = true
    this.push()
    return states
  }

  /** The tab a session holder's media belongs to (a source's tab for a source), or null. */
  private tabOf(ref: SessionRef | null): string | null {
    if (!ref) return null
    if (ref.kind === 'page') return ref.tabId
    return this.sources.get(ref.id)?.state.tabId ?? null
  }

  /**
   * The candidate whose media the OS controls show, among the pages' reports and the chrome's
   * sources alike: the one playing (the most recently started when several are), else the one
   * that played last – unless the user dismissed it – else none. A page that set
   * `navigator.mediaSession.metadata` but never played gets no controls, as in Chrome, where
   * the notification comes up with the first playback; a source that never played neither.
   */
  private pickSession(): SessionRef | null {
    let playing: { ref: SessionRef; startedAt: number } | null = null
    let paused: { ref: SessionRef; at: number } | null = null
    for (const [tabId, tracked] of this.reports) {
      if (!sessionWorthy(tracked.report)) continue
      const ref: SessionRef = { kind: 'page', tabId }
      if (reportIsPlaying(tracked.report)) {
        if (!playing || tracked.startedAt > playing.startedAt)
          playing = { ref, startedAt: tracked.startedAt }
      } else if (!this.dismissed.has(tabId) && tracked.startedAt > 0) {
        if (!paused || tracked.at > paused.at) paused = { ref, at: tracked.at }
      }
    }
    for (const [id, tracked] of this.sources) {
      const ref: SessionRef = { kind: 'source', id }
      if (tracked.state.playing) {
        if (!playing || tracked.startedAt > playing.startedAt)
          playing = { ref, startedAt: tracked.startedAt }
      } else if (!this.dismissedSources.has(id) && tracked.startedAt > 0) {
        if (!paused || tracked.at > paused.at) paused = { ref, at: tracked.at }
      }
    }
    if (playing) return playing.ref
    if (this.held && this.stillHolds(this.held)) return this.held
    return paused ? paused.ref : null
  }

  /** Whether the paused holder of the session keeps it: still tracked, played once, not dismissed. */
  private stillHolds(ref: SessionRef): boolean {
    if (ref.kind === 'page') {
      const current = this.reports.get(ref.tabId)
      return (
        current !== undefined &&
        !this.dismissed.has(ref.tabId) &&
        sessionWorthy(current.report) &&
        current.startedAt > 0
      )
    }
    const current = this.sources.get(ref.id)
    return current !== undefined && !this.dismissedSources.has(ref.id) && current.startedAt > 0
  }

  /** What the host's controls show for the session, or null for none. */
  session(): MediaSessionInfo | null {
    const ref = this.held
    if (!ref) return null
    if (ref.kind === 'source') return this.sourceInfo(ref.id)
    const tabId = ref.tabId
    const tracked = this.reports.get(tabId)
    if (!tracked) return null
    const { report } = tracked
    const tab = this.browser.tabs.tab(tabId)
    const isPrivate = tab ? this.browser.tabs.isPrivate(tab) : false
    return {
      tabId,
      title: isPrivate ? '' : report.metadata?.title || (tab?.title ?? ''),
      artist: isPrivate ? '' : report.metadata?.artist || siteOf(tab?.url ?? ''),
      album: isPrivate ? '' : (report.metadata?.album ?? ''),
      artwork: isPrivate ? null : report.metadata ? pickArtwork(report.metadata.artwork) : null,
      playing: reportIsPlaying(report),
      video: report.video,
      width: report.width,
      height: report.height,
      position: report.position,
      positionAt: tracked.at,
      actions: report.actions,
      fullscreen: report.fullscreen,
      private: isPrivate,
      backgroundVideo: this.backgroundVideoAllowed(tab?.url),
      autoPictureInPicture: this.autoPictureInPictureAllowed(tab?.url),
      source: 'page'
    }
  }

  /**
   * Whether the page's site may keep its video playing in the background: its `background-video`
   * content setting resolves to allow (block by default; Android-only, read by the host at its
   * background transition). Pages without a site (`zen://`, `about:blank`) never do.
   */
  private backgroundVideoAllowed(url: string | undefined): boolean {
    if (!url || permissionSite(url) === null) return false
    return this.browser.permissions.resolve('background-video', url) === 'allow'
  }

  /**
   * Whether the page's site may go into picture-in-picture of its own accord when the user leaves
   * it: its `auto-picture-in-picture` setting does not resolve to deny (allow by default; the
   * Android host reads it for its auto-enter from a fullscreen video on Home, as the desktop's
   * {@link eligibleForAuto} reads the same row). A page without a site gets the row's default.
   */
  private autoPictureInPictureAllowed(url: string | undefined): boolean {
    if (!url) return true
    return this.browser.permissions.resolve(AUTO_PIP_SETTING, url) !== 'deny'
  }

  /** A `background-video` decision changed: the session carries the site's new answer to the host. */
  followBackgroundVideoSetting(): void {
    this.push()
  }

  /** An `auto-picture-in-picture` decision changed: the session carries the site's new answer to the host. */
  followAutoPictureInPictureSetting(): void {
    this.push()
  }

  /** A chrome player's session as the host's controls see it: no video, no PiP; blank on a private tab. */
  private sourceInfo(id: string): MediaSessionInfo | null {
    const tracked = this.sources.get(id)
    if (!tracked) return null
    const { state: source } = tracked
    const tab = this.browser.tabs.tab(source.tabId)
    const isPrivate = tab ? this.browser.tabs.isPrivate(tab) : false
    return {
      tabId: source.tabId,
      title: isPrivate ? '' : source.title,
      artist: isPrivate ? '' : source.artist,
      album: '',
      artwork: isPrivate ? null : (source.artwork ?? null),
      playing: source.playing,
      video: false,
      width: 0,
      height: 0,
      position: source.position ?? null,
      positionAt: tracked.at,
      actions: [...source.actions],
      fullscreen: false,
      private: isPrivate,
      backgroundVideo: false,
      autoPictureInPicture: false,
      source: 'chrome',
      sourceId: source.id
    }
  }

  private push(): void {
    const host = this.browser.platform.mediaSession
    if (!host) return
    const info = this.session()
    const key = info ? JSON.stringify(info) : null
    if (key === this.lastSent) return
    this.lastSent = key
    host.update(info)
  }

  /**
   * An action from the OS controls (the host names the tab it showed, or none for the session's)
   * or the in-app player. The page carries it out; `stop` – Chrome's swipe on the notification –
   * also takes the paused session down until the page plays again. When the session (or the
   * named tab's) is a chrome player's, the player carries it out instead through `onAction`:
   * `toggle` resolved to `play` / `pause` from its state, `stop` dismissing its session until it
   * next reports playing.
   */
  act(
    tabId: string | null,
    action: MediaSessionAction | 'toggle',
    details: { seekTime?: number; seekOffset?: number } = {}
  ): void {
    const source = this.sourceFor(tabId)
    if (source) {
      this.actOnSource(source, action, details)
      return
    }
    const target = tabId ?? this.sessionTabId
    if (!target) return
    const view = this.browser.tabs.view(target)
    if (!view || view.isDestroyed()) return
    const message: MediaSessionHostMessage = { type: 'mediaSession', action }
    if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime))
      message.seekTime = Math.max(0, details.seekTime)
    if (typeof details.seekOffset === 'number' && Number.isFinite(details.seekOffset))
      message.seekOffset = details.seekOffset
    view.postToPage?.(message)
    if (action === 'stop') {
      this.dismissed.add(target)
      this.browser.updateMedia()
    }
  }

  /**
   * The chrome player an action is for, or null when a page is: the session's holder when no tab
   * is named or the holder sits on the named tab; else the named tab's source when its page
   * reports no media of its own (a page report and a source on one tab are both candidates, and
   * the action reaches the one that holds the session, the page otherwise).
   */
  private sourceFor(tabId: string | null): TrackedSource | null {
    const holder = this.held?.kind === 'source' ? this.sources.get(this.held.id) : undefined
    if (tabId === null) return holder ?? null
    if (holder && holder.state.tabId === tabId) return holder
    if (this.reports.has(tabId)) return null
    for (const tracked of this.sources.values()) {
      if (tracked.state.tabId === tabId) return tracked
    }
    return null
  }

  private actOnSource(
    tracked: TrackedSource,
    action: MediaSessionAction | 'toggle',
    details: { seekTime?: number; seekOffset?: number }
  ): void {
    const resolved: MediaSessionAction =
      action === 'toggle' ? (tracked.state.playing ? 'pause' : 'play') : action
    const handed: { seekTime?: number; seekOffset?: number } = {}
    if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime))
      handed.seekTime = Math.max(0, details.seekTime)
    if (typeof details.seekOffset === 'number' && Number.isFinite(details.seekOffset))
      handed.seekOffset = details.seekOffset
    tracked.source.onAction(resolved, handed)
    if (resolved === 'stop') {
      this.dismissedSources.add(tracked.state.id)
      this.browser.updateMedia()
    }
  }

  /** Whether `tabId`'s page has a video the OS could show as picture-in-picture. */
  hasVideo(tabId: string): boolean {
    return this.reports.get(tabId)?.report.video === true
  }

  /**
   * Picture-in-picture for the tab's video through the host (`capabilities.pictureInPicture` on
   * a host with `mediaSession.enterPictureInPicture`): the host puts the window into PiP and
   * reports `onPictureInPicture` once it is, when the page lays its video over the viewport.
   */
  async enterPictureInPicture(tabId: string): Promise<boolean> {
    const host = this.browser.platform.mediaSession
    if (!host?.enterPictureInPicture) return false
    const tracked = this.reports.get(tabId)
    if (!tracked || !tracked.report.video) return false
    const tab = this.browser.tabs.tab(tabId)
    const isPrivate = tab ? this.browser.tabs.isPrivate(tab) : false
    // Withheld from private tabs, as Chrome withholds it from Incognito: a window that left for
    // the small video never stops, so the private tab lock would never arm (ruled 2026-09-21).
    if (isPrivate) return false
    const { report } = tracked
    return host.enterPictureInPicture({
      tabId,
      title: isPrivate ? '' : report.metadata?.title || (tab?.title ?? ''),
      artist: isPrivate ? '' : report.metadata?.artist || siteOf(tab?.url ?? ''),
      album: isPrivate ? '' : (report.metadata?.album ?? ''),
      artwork: isPrivate ? null : report.metadata ? pickArtwork(report.metadata.artwork) : null,
      playing: reportIsPlaying(report),
      video: true,
      width: report.width,
      height: report.height,
      position: report.position,
      positionAt: tracked.at,
      actions: report.actions,
      fullscreen: report.fullscreen,
      private: isPrivate,
      backgroundVideo: this.backgroundVideoAllowed(tab?.url),
      autoPictureInPicture: this.autoPictureInPictureAllowed(tab?.url),
      source: 'page'
    })
  }

  /**
   * The media hub's and the media sheet's Picture-in-picture button (`media.pictureInPicture`).
   * A host whose window goes into picture-in-picture (Android) takes the tab's video the OS way
   * through {@link enterPictureInPicture}, refusing quietly what it cannot show. Every other host
   * – the desktop, whose `mediaSession` host is MPRIS on Linux and nothing elsewhere – has no
   * such window: the page's own video goes into its floating window, as `page.pip` puts it there
   * ({@link togglePictureInPicture}), and the user is told why when it cannot.
   */
  pictureInPicture(tabId: string, win: ZenWindow): Promise<boolean> {
    if (this.browser.platform.mediaSession?.enterPictureInPicture) {
      return this.enterPictureInPicture(tabId)
    }
    return this.togglePictureInPicture(tabId, win)
  }

  /**
   * Picture-in-picture for the tab's video, the way this host has it (`page.pip`: the shortcut,
   * the toolbar, the video menu's item; the media hub's button on the desktop). Says why when it
   * cannot; resolves whether a video went into (or left) its small window.
   */
  async togglePictureInPicture(tabId: string, win: ZenWindow): Promise<boolean> {
    const view = this.browser.tabs.view(tabId)
    if (!view) return false
    const tab = this.browser.tabs.tab(tabId)
    if (tab && this.browser.tabs.isPrivate(tab)) {
      // Withheld from private tabs, as Chrome withholds it from Incognito (ruled 2026-09-21).
      this.browser.toast("Picture-in-Picture isn't available in private tabs.", 'info', win)
      return false
    }
    if (!this.browser.state.capabilities.pictureInPicture) {
      this.browser.toast('Picture-in-Picture is not available on this device.', 'info', win)
      return false
    }
    // A host whose window itself goes into PiP (Android): the OS shows the page's video.
    const entered = this.browser.platform.mediaSession?.enterPictureInPicture
      ? await this.enterPictureInPicture(tabId)
      : await this.toggleInPage(tabId)
    if (!entered) this.browser.toast('No video available for Picture-in-Picture', 'info', win)
    return entered
  }

  /**
   * The page's own picture-in-picture (the desktop): a video in the small window leaves it; else
   * the largest video with a frame to show that does not forbid it goes in. False when the page
   * has no such video or refuses (a page without a user gesture, a document that is gone).
   */
  private async toggleInPage(tabId: string): Promise<boolean> {
    const view = this.browser.tabs.view(tabId)
    if (!view) return false
    try {
      const result: unknown = await view.executeJavaScript(
        `(async () => {
          if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return true }
          const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture)
          const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]
          if (!video) return false
          await video.requestPictureInPicture()
          return true
        })()`
      )
      return result === true
    } catch {
      return false
    }
  }

  /**
   * The host's window entered (or left) picture-in-picture showing `tabId`'s page: the page lays
   * its video over the whole viewport for the small window (`fill`), and back afterwards.
   */
  onPictureInPicture(tabId: string, active: boolean): void {
    const previous = this.pipTabId
    this.pipTabId = active ? tabId : previous === tabId ? null : previous
    if (previous && previous !== tabId) this.fill(previous, false)
    this.fill(tabId, active)
    this.browser.updateMedia()
  }

  private fill(tabId: string, on: boolean): void {
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return
    view.postToPage?.({ type: 'mediaSession', action: 'fill', on })
  }

  /** The tab in picture-in-picture, if any. */
  get pictureInPictureTab(): string | null {
    return this.pipTabId
  }

  // ---------------------------------------------------------------------------
  // Automatic picture-in-picture (MW-28): the desktop's mirror of Android's hook (#223)
  // ---------------------------------------------------------------------------

  /**
   * The tab whose video the desktop put into the small window of its own accord, or null: a
   * video the user put there themselves is never this service's to take back.
   */
  get autoPictureInPictureTab(): string | null {
    return this.autoPip?.tabId ?? null
  }

  /**
   * `win` shows other tabs than a moment ago (the active tab changed, the space switched, a
   * split formed or a tab moved windows: `TabManager` says so after every such change). A tab
   * that left the screen everywhere while an eligible video played goes into the small window
   * without a click, as Chrome's automatic picture-in-picture does when the tab is hidden; the
   * tab in front again, its video comes back to the page. Eligibility is Chrome's rule as the
   * hub sees it ({@link eligibleForAuto}): a video playing with a media session, on a page the
   * user interacted with, not private, the site's `auto-picture-in-picture` setting allowing.
   */
  onVisibleTabsChanged(win: ZenWindow): void {
    const { tabs } = this.browser
    const before = this.shown.get(win.id) ?? []
    const visible = tabs.visibleTabIds(win)
    this.shown.set(win.id, visible)
    if (!this.autoPipSupported()) return
    if (this.autoPip && visible.includes(this.autoPip.tabId)) {
      void this.leaveAuto()
      return
    }
    for (const tabId of before) {
      if (visible.includes(tabId) || tabs.windowsShowing(tabId).length > 0) continue
      if (!this.eligibleForAuto(tabId)) continue
      void this.enterAuto(tabId)
      return
    }
  }

  /**
   * `win` gained or lost the focus (the desktop's `focus` / `blur` window events, through
   * `ZenWindow.onWindowStateChanged`). Losing it to something outside Zenium – no window of
   * ours focused once the grace period is over – puts the window's eligible playing video into
   * the small window when the page went out of sight with the window, as leaving the app does
   * on Android; gaining it back with that video's tab in front returns the video to the page.
   * The trigger is Electron's blur, the rule the page's own visibility (Chrome's: its automatic
   * picture-in-picture fires for a hidden document, never for one the user can still see – two
   * windows side by side, a second monitor, a video watched while typing elsewhere): the entry
   * script asks `document.visibilityState` and a visible document stays ({@link autoPipEnter}).
   * That reads as Chromium computes it: a minimized window is hidden everywhere; a window
   * another application covers is hidden where Chromium tracks occlusion natively (Windows,
   * macOS) and visible on Linux/X11, where an app switch therefore leaves the video on the page
   * and minimizing moves it – as Chrome on Linux behaves. An occlusion that arrives after the
   * grace, with no new blur, is not heard.
   *
   * What this host gives the rule today (the pass 10 probe, Electron 44.4.5 under Xvfb): a tab
   * page's `visibilityState` stayed `visible` behind another tab, on blur and with the window
   * hidden outright – the host does not forward the window's state to a child
   * `WebContentsView`'s page – so until it tells a tab page it is hidden with the window, this
   * path enters nothing and the tab trigger above carries the feature.
   */
  onWindowFocusChanged(win: ZenWindow, focused: boolean): void {
    if (this.blurTimer !== null) {
      clearTimeout(this.blurTimer)
      this.blurTimer = null
    }
    if (!this.autoPipSupported()) return
    if (focused) {
      if (this.autoPip && this.browser.tabs.visibleTabIds(win).includes(this.autoPip.tabId)) {
        void this.leaveAuto()
      }
      return
    }
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null
      if (!win.alive) return
      if (this.browser.allWindows().some((w) => w.host.isFocused())) return
      for (const tabId of this.browser.tabs.visibleTabIds(win)) {
        if (!this.eligibleForAuto(tabId)) continue
        void this.enterAuto(tabId, true)
        return
      }
    }, AUTO_PIP_BLUR_GRACE_MS)
  }

  /**
   * `tabId`'s page has (or no longer has) a picture-in-picture element, as its capture-state
   * reporter says: the automatic entry is confirmed by the first, and the user closing the
   * small window (the second, after it) ends the desktop's claim – the video stays on the page
   * until the tab leaves the screen again.
   */
  onPagePictureInPicture(tabId: string, active: boolean): void {
    const auto = this.autoPip
    if (!auto || auto.tabId !== tabId) return
    if (active) auto.confirmed = true
    else if (auto.confirmed) this.autoPip = null
  }

  /**
   * Whether this host's pages go into their own small window on the desktop's terms: a host
   * whose window itself goes into picture-in-picture (Android) has its own automatic entry.
   */
  private autoPipSupported(): boolean {
    return (
      !this.browser.platform.mediaSession?.enterPictureInPicture &&
      this.browser.state.capabilities.pictureInPicture
    )
  }

  /**
   * Chrome's eligibility for automatic picture-in-picture, read from what the hub knows: the
   * tab's page reports a video playing (audible, so it holds a media session) long enough for
   * the OS controls; the user has interacted with the page (Chromium's sticky activation, as
   * the pop-up blocker tracks it); the tab is not private (PiP is withheld there); the site's
   * `auto-picture-in-picture` setting allows; and no video is in the small window already,
   * the desktop's own or the user's.
   */
  private eligibleForAuto(tabId: string): boolean {
    if (this.autoPip) return false
    const tracked = this.reports.get(tabId)
    if (!tracked) return false
    const { report } = tracked
    if (!report.video || !reportIsPlaying(report) || !sessionWorthy(report)) return false
    const { tabs } = this.browser
    const view = tabs.view(tabId)
    if (!view || view.isDestroyed()) return false
    const tab = tabs.tab(tabId)
    if (!tab || tabs.isPrivate(tab)) return false
    if (!this.browser.popups.activation(tabId).hasBeenActive()) return false
    if (!this.browser.permissions.check(AUTO_PIP_SETTING, tab.url)) return false
    for (const [id] of tabs.allViews()) if (tabs.tab(id)?.alert === 'pip') return false
    return true
  }

  /**
   * The video of `tabId` into the small window; `hiddenOnly` (the window trigger) for a document
   * out of the user's sight alone – a visible one answers `'visible'` and the claim is dropped
   * as for any refusal: no `autoPip`, no toast, the tab's alert never set.
   */
  private async enterAuto(tabId: string, hiddenOnly = false): Promise<void> {
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return
    // Claimed before the page answers, so a second trigger in the meantime does not double up.
    this.autoPip = { tabId, confirmed: false }
    let entered = false
    try {
      entered = (await view.executeJavaScript(autoPipEnter(hiddenOnly))) === true
    } catch {
      entered = false
    }
    if (!entered && this.autoPip?.tabId === tabId && !this.autoPip.confirmed) this.autoPip = null
    if (entered && this.autoPip?.tabId === tabId) this.noticeAuto(tabId)
  }

  /**
   * The first automatic entry for a site says so (the design lead's ruling on MW-28): a toast
   * in the tab's own window – "Video from <site> opened in a small window", `<site>` the host
   * without `www.` as the site card names it (`displayHost`) – with the one action "Turn off
   * for this site" (`media.autoPipOptOut`, §9.33's action clock). Once per site: the memory is
   * the permission answers' own (`permissions.noticed`, device-local, gone with the site's
   * reset), so every later entry is silent and the setting stands in Additional permissions.
   * The tab's window is the right one both ways: on a tab or space switch the user is still in
   * it; on a blur to another application it is the only Zenium window (none has the focus once
   * the grace is over), what the user sees on return. The user's own toggle and Android's hook
   * (#223) never come this way.
   */
  private noticeAuto(tabId: string): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const { permissions } = this.browser
    if (permissions.noticed(AUTO_PIP_SETTING, tab.url)) return
    permissions.markNoticed(AUTO_PIP_SETTING, tab.url)
    let win: ZenWindow | undefined
    try {
      win = this.browser.tabs.windowFor(tabId)
    } catch {
      win = undefined
    }
    this.browser.toast(`Video from ${displayHost(tab.url)} opened in a small window`, 'info', win, {
      label: 'Turn off for this site',
      command: 'media.autoPipOptOut',
      args: { tabId }
    })
  }

  /**
   * "Turn off for this site", the toast's action: the site of `tabId`'s page gets
   * `auto-picture-in-picture` = deny through the permissions service – the same write the site
   * card's row makes, so the row shows it and resets it – and the video the desktop just put in
   * the small window comes back to its tab, playing on (a video the user meant as sound alone
   * is stopped in one tap). The user's own picture-in-picture is not this service's to take back.
   */
  async optOutAuto(tabId: string): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    if (tab) this.browser.permissions.set(AUTO_PIP_SETTING, tab.url, 'deny')
    if (this.autoPip?.tabId === tabId) await this.leaveAuto()
  }

  private async leaveAuto(): Promise<void> {
    const auto = this.autoPip
    if (!auto) return
    this.autoPip = null
    const view = this.browser.tabs.view(auto.tabId)
    if (!view || view.isDestroyed()) return
    try {
      await view.executeJavaScript(AUTO_PIP_LEAVE)
    } catch {
      // The document is gone with its small window.
    }
  }
}

/**
 * A source's state from `base` with `patch` laid over it: the fields the patch names and sets
 * (an `undefined` leaves the field as it was), `actions` copied so the player's own array can
 * change without moving the engine's.
 */
function sourceState(
  base: SourceState,
  patch: Partial<Omit<MediaSessionSource, 'id' | 'onAction'>>
): SourceState {
  return {
    id: base.id,
    tabId: patch.tabId ?? base.tabId,
    title: patch.title ?? base.title,
    artist: patch.artist ?? base.artist,
    artwork: patch.artwork !== undefined ? patch.artwork : (base.artwork ?? null),
    playing: patch.playing ?? base.playing,
    actions: [...(patch.actions ?? base.actions)],
    position: patch.position !== undefined ? patch.position : (base.position ?? null)
  }
}

function isReport(value: unknown): value is MediaReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MediaReport).playing === 'boolean' &&
    Array.isArray((value as MediaReport).actions)
  )
}

/** A report that describes media at all: an element with a position, or session metadata. */
function hasMedia(report: MediaReport): boolean {
  return (
    report.position !== null ||
    report.metadata !== null ||
    report.playbackState !== 'none' ||
    report.playing
  )
}

/** Whether the report's media deserves the OS controls (Chrome's rules: no short clips). */
function sessionWorthy(report: MediaReport): boolean {
  if (report.metadata !== null || report.playbackState !== 'none') return true
  if (!report.position) return report.playing
  if (report.position.duration > 0 && report.position.duration < MIN_SESSION_DURATION_S)
    return false
  return true
}

/** The site a page's URL names, as Chrome's notification shows it under the title. */
export function siteOf(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.host
    return ''
  } catch {
    return ''
  }
}

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
import type { Browser } from './browser'

/**
 * Chrome shows no media controls for a clip this short (a notification sound, a UI effect):
 * `MediaSession` waits for a duration of at least this many seconds before it takes an element.
 */
export const MIN_SESSION_DURATION_S = 5

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
      source: 'page'
    }
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
      source: 'page'
    })
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

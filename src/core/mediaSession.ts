import type { MediaState } from '../shared/types'
import {
  pickArtwork,
  reportIsPlaying,
  type MediaReport,
  type MediaSessionAction,
  type MediaSessionHostMessage,
  type MediaSessionInfo
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

/**
 * The media of the pages, as the OS controls and the in-app player see it. Every host feeds the
 * tab's `audible` flag; hosts whose page script tracks the Media Session (Android) send the
 * full report – the element playing, its position, the page's `navigator.mediaSession` metadata
 * and handlers – and this service resolves one session from them: the page playing (the most
 * recent to start when several are), or the one that played last while everything is paused,
 * as Chrome's media notification stays up in paused form until it is dismissed or its tab goes.
 * The host's controls send their actions back through `act`, which the tab's page carries out:
 * its own handler where it registered one, the element otherwise (the page script decides).
 */
export class MediaSessionService {
  private readonly reports = new Map<string, TabReport>()
  /** Tabs whose paused session the user dismissed (a swipe on the notification, `stop`): shown again once they play. */
  private readonly dismissed = new Set<string>()
  private sessionTabId: string | null = null
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

  /** The tab the OS controls show right now, or null. */
  get sessionTab(): string | null {
    return this.sessionTabId
  }

  /**
   * The media list for the chrome (`UIState.media`), and the session for the host's controls,
   * recomputed from the live views: tabs whose view is gone drop out (their notification with
   * them), so a closed tab ends its session as Chrome's does.
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
      }
      states.push(state)
    }
    for (const tabId of [...this.reports.keys()]) {
      if (!live.has(tabId)) {
        this.reports.delete(tabId)
        this.dismissed.delete(tabId)
      }
    }
    if (this.pipTabId && !live.has(this.pipTabId)) this.pipTabId = null
    this.sessionTabId = this.pickSession()
    for (const state of states) if (state.tabId === this.sessionTabId) state.session = true
    this.push()
    return states
  }

  /**
   * The tab whose media the OS controls show: the one playing (the most recently started when
   * several are), else the one that played last – unless the user dismissed it – else none. A
   * page that set `navigator.mediaSession.metadata` but never played gets no controls, as in
   * Chrome, where the notification comes up with the first playback.
   */
  private pickSession(): string | null {
    let playing: [string, TabReport] | null = null
    let paused: [string, TabReport] | null = null
    for (const entry of this.reports) {
      const [tabId, tracked] = entry
      if (!sessionWorthy(tracked.report)) continue
      if (reportIsPlaying(tracked.report)) {
        if (!playing || tracked.startedAt > playing[1].startedAt) playing = entry
      } else if (!this.dismissed.has(tabId) && tracked.startedAt > 0) {
        if (!paused || tracked.at > paused[1].at) paused = entry
      }
    }
    if (playing) return playing[0]
    if (
      this.sessionTabId &&
      this.reports.has(this.sessionTabId) &&
      !this.dismissed.has(this.sessionTabId)
    ) {
      const current = this.reports.get(this.sessionTabId)!
      if (sessionWorthy(current.report) && current.startedAt > 0) return this.sessionTabId
    }
    return paused ? paused[0] : null
  }

  /** What the host's controls show for the session tab, or null for none. */
  session(): MediaSessionInfo | null {
    const tabId = this.sessionTabId
    if (!tabId) return null
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
      private: isPrivate
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
   * also takes the paused session down until the page plays again.
   */
  act(
    tabId: string | null,
    action: MediaSessionAction | 'toggle',
    details: { seekTime?: number; seekOffset?: number } = {}
  ): void {
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
      private: isPrivate
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

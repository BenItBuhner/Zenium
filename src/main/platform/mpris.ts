import type { Browser } from '../../core/browser'
import type { MediaSessionHost } from '../../core/platform'
import {
  extrapolatePosition,
  type MediaSessionAction,
  type MediaSessionInfo
} from '../../shared/mediaSession'
import { LINUX_DESKTOP_ID } from './defaultBrowser'

/** `org.mpris.MediaPlayer2.zenium` (a second running copy gets `.instanceNNN`, the lib's rule). */
export const MPRIS_BUS_NAME = 'zenium'
export const MPRIS_IDENTITY = 'Zenium'
/** The MPRIS spec's "no track" path, what `Metadata` names while nothing plays. */
export const MPRIS_NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack'
const TRACK_PATH_PREFIX = '/org/zenium/track/'
/** A reported position this far from where playback should stand is a seek (`Seeked` signal). */
const SEEK_THRESHOLD_S = 1

export type MprisPlaybackStatus = 'Playing' | 'Paused' | 'Stopped'

/** What the D-Bus player says about the current entry. */
export interface MprisState {
  playbackStatus: MprisPlaybackStatus
  metadata: Record<string, string | string[] | number>
  canPlay: boolean
  canPause: boolean
  canSeek: boolean
  canGoNext: boolean
  canGoPrevious: boolean
}

/** The tab fields the metadata falls back to when the page named nothing. */
export interface MprisTabInfo {
  url: string
  favicon?: string | null
}

/**
 * The slice of mpris-service's `Player` this host uses (an `EventEmitter` whose evented
 * properties emit `PropertiesChanged` when set; tests pass a plain object).
 */
export interface MprisPlayer {
  playbackStatus: string
  metadata: Record<string, unknown>
  canControl: boolean
  canPlay: boolean
  canPause: boolean
  canSeek: boolean
  canGoNext: boolean
  canGoPrevious: boolean
  canQuit: boolean
  canRaise: boolean
  /** The lib calls this for the `Position` property; the host overrides it (microseconds). */
  getPosition: () => number
  /** Emits the `Seeked` signal (microseconds). */
  seeked(position: number): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Creates the D-Bus player; separated so the tests can hand in a fake and the app can lazy-load the lib. */
export type MprisPlayerFactory = () => MprisPlayer

/**
 * The state MPRIS shows for the session: the core's words (the page's Media Session metadata,
 * else the tab's title and site; blank for a private tab), the tab's favicon where the page
 * named no artwork – Chrome's own MPRIS instance fills its metadata the same way. `null` is the
 * idle player.
 */
export function mprisStateFor(
  session: MediaSessionInfo | null,
  tab: MprisTabInfo | undefined
): MprisState {
  if (!session) {
    return {
      playbackStatus: 'Stopped',
      metadata: { 'mpris:trackid': MPRIS_NO_TRACK },
      canPlay: false,
      canPause: false,
      canSeek: false,
      canGoNext: false,
      canGoPrevious: false
    }
  }
  const actions = new Set(session.actions)
  const metadata: MprisState['metadata'] = { 'mpris:trackid': trackPath(session.tabId) }
  const title = session.title.trim()
  if (title) metadata['xesam:title'] = title
  const artist = session.artist.trim()
  if (artist) metadata['xesam:artist'] = [artist]
  const album = session.album.trim()
  if (album) metadata['xesam:album'] = album
  const art = artUrl(session.artwork) ?? (session.private ? null : artUrl(tab?.favicon))
  if (art) metadata['mpris:artUrl'] = art
  const duration = session.position?.duration
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0)
    metadata['mpris:length'] = Math.round(duration * 1_000_000)
  if (!session.private && tab && /^https?:\/\//i.test(tab.url)) metadata['xesam:url'] = tab.url
  return {
    playbackStatus: session.playing ? 'Playing' : 'Paused',
    metadata,
    canPlay: true,
    canPause: true,
    // A seek bar makes sense with a duration; the page's own `seekto` handler counts too.
    canSeek: actions.has('seekto') || (session.position?.duration ?? 0) > 0,
    canGoNext: actions.has('nexttrack'),
    canGoPrevious: actions.has('previoustrack')
  }
}

/** A D-Bus object path for a tab: `/org/zenium/track/<id>` with the id reduced to `[A-Za-z0-9_]`. */
export function trackPath(tabId: string): string {
  const safe = tabId.replace(/[^A-Za-z0-9_]/g, '_')
  return `${TRACK_PATH_PREFIX}${safe === '' ? '_' : safe}`
}

/** Only URLs a desktop widget can load: http(s), file and data. */
function artUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return /^(https?|file|data):/i.test(url) ? url : null
}

/**
 * Linux MPRIS (MW-18): Zenium as a `org.mpris.MediaPlayer2` player on the session bus, so the
 * desktop's media widgets, the lock screen, media keys and `playerctl` see and drive what plays
 * in a tab – the session the core resolves from the pages' reports (`MediaSessionService`),
 * the one the OS controls show. The player is exported on the first session (a run without
 * media puts nothing on the bus) and stays registered afterwards, `Stopped` while there is
 * nothing to play, as Chrome's instance does. Chromium's own MPRIS instance is switched off
 * for it (`HardwareMediaKeyHandling` in `core/resources/switches.ts`), or the desktop would
 * list two players.
 *
 * Controls come back as Media Session actions for the session's page
 * (`browser.mediaSession.act`): Play, Pause, PlayPause, Stop, Next, Previous, Seek (an
 * offset), SetPosition; Raise brings the tab's window forward.
 */
export class ElectronMpris implements MediaSessionHost {
  private player: MprisPlayer | null = null
  /** The lib failed (no session bus, name refused): stay quiet for the rest of the run. */
  private failed = false
  private current: MediaSessionInfo | null = null
  private now: () => number

  constructor(
    private readonly browser: () => Browser,
    private readonly createPlayer: MprisPlayerFactory = defaultPlayerFactory,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  update(session: MediaSessionInfo | null): void {
    if (!session && !this.player) return
    const player = this.ensurePlayer()
    if (!player) return
    const previous = this.current
    this.current = session
    const tab = session ? this.browser().tabs.tab(session.tabId) : undefined
    const state = mprisStateFor(session, tab)
    try {
      player.playbackStatus = state.playbackStatus
      player.metadata = state.metadata
      player.canPlay = state.canPlay
      player.canPause = state.canPause
      player.canSeek = state.canSeek
      player.canGoNext = state.canGoNext
      player.canGoPrevious = state.canGoPrevious
      if (session && previous && previous.tabId === session.tabId && jumped(previous, session))
        player.seeked(Math.round(this.position(session) * 1e6))
    } catch (error) {
      console.warn('[zen] mpris:', (error as Error).message)
    }
  }

  /** The current session's tab id, for the controls (tests). */
  currentTabId(): string | null {
    return this.current?.tabId ?? null
  }

  /** Where the session's playback stands now, in seconds. */
  private position(session: MediaSessionInfo | null): number {
    if (!session?.position) return 0
    return extrapolatePosition(session.position, session.playing, session.positionAt, this.now())
  }

  private ensurePlayer(): MprisPlayer | null {
    if (this.player || this.failed) return this.player
    try {
      const player = this.createPlayer()
      player.canQuit = false
      player.canRaise = true
      player.canControl = true
      player.getPosition = () => Math.round(this.position(this.current) * 1e6)
      player.on('error', (error) => {
        console.warn('[zen] mpris:', error instanceof Error ? error.message : String(error))
        this.failed = true
        this.player = null
      })
      player.on('raise', () => {
        if (this.current) this.browser().revealTab(this.current.tabId)
      })
      player.on('play', () => this.send('play'))
      player.on('pause', () => this.send('pause'))
      player.on('stop', () => this.send('stop'))
      player.on('playpause', () => this.send('toggle'))
      player.on('next', () => this.send('nexttrack'))
      player.on('previous', () => this.send('previoustrack'))
      player.on('seek', (offset) => {
        const seconds = microsToSeconds(offset)
        if (seconds === null || seconds === 0) return
        this.send(seconds > 0 ? 'seekforward' : 'seekbackward', { seekOffset: Math.abs(seconds) })
      })
      player.on('position', (event) => {
        const e = event as { trackId?: unknown; position?: unknown } | undefined
        const seconds = microsToSeconds(e?.position)
        if (seconds === null || !this.current) return
        // A stale SetPosition (for the track before) is ignored, as the spec asks.
        if (typeof e?.trackId === 'string' && e.trackId !== trackPath(this.current.tabId)) return
        this.send('seekto', { seekTime: Math.max(0, seconds) })
      })
      this.player = player
      return player
    } catch (error) {
      console.warn('[zen] mpris unavailable:', (error as Error).message)
      this.failed = true
      return null
    }
  }

  private send(
    action: MediaSessionAction | 'toggle',
    details: { seekTime?: number; seekOffset?: number } = {}
  ): void {
    if (!this.current) return
    this.browser().mediaSession.act(this.current.tabId, action, details)
  }
}

/** Whether a new report of the same tab's position is a jump rather than playback moving on. */
function jumped(previous: MediaSessionInfo, next: MediaSessionInfo): boolean {
  if (!previous.position || !next.position) return false
  const expected = extrapolatePosition(
    previous.position,
    previous.playing,
    previous.positionAt,
    next.positionAt
  )
  return Math.abs(expected - next.position.position) > SEEK_THRESHOLD_S
}

function microsToSeconds(value: unknown): number | null {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n / 1e6 : null
}

/** mpris-service (MIT, on dbus-next), loaded when the first media plays; Linux only. */
function defaultPlayerFactory(): MprisPlayer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Player = require('mpris-service') as new (options: {
    name: string
    identity: string
    desktopEntry: string
    supportedInterfaces: string[]
    supportedUriSchemes: string[]
    supportedMimeTypes: string[]
  }) => MprisPlayer
  return new Player({
    name: MPRIS_BUS_NAME,
    identity: MPRIS_IDENTITY,
    desktopEntry: LINUX_DESKTOP_ID.replace(/\.desktop$/, ''),
    supportedInterfaces: ['player'],
    supportedUriSchemes: [],
    supportedMimeTypes: []
  })
}

/**
 * The Media Session API as the page script, the core and the hosts agree on it: what a page
 * reports about its media (the element playing and whatever `navigator.mediaSession` it set), and
 * the actions the OS controls send back. Chromium exposes the API to pages on the desktop and
 * feeds the OS controls itself; the Android WebView hides it (crbug 925997), so there the page
 * script polyfills `navigator.mediaSession` and the browser carries the session to
 * `MediaSessionCompat` (the media notification, the lock screen, headset buttons).
 */

/** `MediaSessionAction` of the spec, plus the ones Chromium added. */
export type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'previoustrack'
  | 'nexttrack'
  | 'skipad'
  | 'togglemicrophone'
  | 'togglecamera'
  | 'hangup'
  | 'previousslide'
  | 'nextslide'
  | 'enterpictureinpicture'

export const MEDIA_SESSION_ACTIONS: readonly MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'seekbackward',
  'seekforward',
  'seekto',
  'previoustrack',
  'nexttrack',
  'skipad',
  'togglemicrophone',
  'togglecamera',
  'hangup',
  'previousslide',
  'nextslide',
  'enterpictureinpicture'
]

export function isMediaSessionAction(value: unknown): value is MediaSessionAction {
  return typeof value === 'string' && (MEDIA_SESSION_ACTIONS as readonly string[]).includes(value)
}

export type MediaPlaybackState = 'none' | 'playing' | 'paused'

export interface MediaArtwork {
  src: string
  sizes: string
  type: string
}

/** `MediaMetadata`, resolved: artwork URLs absolute, every field a string. */
export interface MediaMetadataInfo {
  title: string
  artist: string
  album: string
  artwork: MediaArtwork[]
}

/**
 * Where playback stands, from the page's `setPositionState` or the element itself. `duration`
 * is 0 for a stream without one (a live stream reports `Infinity` in the DOM). The receiver
 * extrapolates from `position` at `playbackRate` from the moment the report arrived.
 */
export interface MediaPositionInfo {
  duration: number
  position: number
  playbackRate: number
}

/**
 * One report of a page's media, sent by the page script whenever any of it changes. The element
 * the report describes is the one playing (the last to start when several are), or the last one
 * that played once everything is paused.
 */
export interface MediaReport {
  /** An element is playing and not muted (what the tab's speaker glyph shows). */
  playing: boolean
  /** The described element is a `<video>` with picture (dimensions known). */
  video: boolean
  /** Intrinsic size of the video, 0 for audio. */
  width: number
  height: number
  muted: boolean
  /** Null when the element has no duration yet. */
  position: MediaPositionInfo | null
  /** `navigator.mediaSession.metadata`, null when the page set none. */
  metadata: MediaMetadataInfo | null
  /** `navigator.mediaSession.playbackState` (`none` leaves the element's state to decide). */
  playbackState: MediaPlaybackState
  /** Actions the page registered handlers for. */
  actions: MediaSessionAction[]
  /** The described element (or an ancestor) is the document's fullscreen element. */
  fullscreen: boolean
}

export const EMPTY_MEDIA_REPORT: MediaReport = {
  playing: false,
  video: false,
  width: 0,
  height: 0,
  muted: false,
  position: null,
  metadata: null,
  playbackState: 'none',
  actions: [],
  fullscreen: false
}

/**
 * Browser → page: an action from the OS controls, the in-app player or a host policy. `toggle`
 * plays or pauses whichever applies; `duck` lowers the volume (or restores it) while another app
 * speaks over the media – for a host whose engine leaves audio focus to it (the WebView's and
 * Electron's Chromium answer focus changes themselves, so neither sends it); `fill` lays the
 * playing video over the whole viewport (or puts it back) while the host shows the page's window
 * as a picture-in-picture of that video.
 */
export interface MediaSessionHostMessage {
  type: 'mediaSession'
  action: MediaSessionAction | 'toggle' | 'duck' | 'fill'
  /** `seekto`: the absolute time in seconds. */
  seekTime?: number
  /** `seekbackward` / `seekforward`: the offset in seconds the control asked for. */
  seekOffset?: number
  /** `duck` / `fill`: on or off. */
  on?: boolean
}

/**
 * The session the core hands the host for its OS controls (the media notification, the lock
 * screen, PiP): one page's media, resolved – the metadata the page set or the tab's title and
 * site, the artwork picked, the position as of `positionAt` (epoch ms). Null takes it down.
 */
export interface MediaSessionInfo {
  tabId: string
  title: string
  artist: string
  album: string
  /** The artwork's URL (the largest the page offered), or null for none. */
  artwork: string | null
  playing: boolean
  video: boolean
  width: number
  height: number
  position: MediaPositionInfo | null
  positionAt: number
  /** Actions the page handles itself; the host shows the controls for those plus the defaults. */
  actions: MediaSessionAction[]
  /** The element is fullscreen in its page (a host may enter PiP for it when the user leaves). */
  fullscreen: boolean
  /** A private tab: the controls show no title, artist or artwork (Chrome's incognito notification). */
  private: boolean
}

/** The stylesheet id / attribute the page script uses for `fill` (a test hook as much as a marker). */
export const PIP_FILL_ATTRIBUTE = 'data-zenium-pip'

/** Chrome's seek buttons move by this much when the page gives no offset. */
export const DEFAULT_SEEK_OFFSET_S = 10

/** Volume while ducked (another app's short sound over the media). */
export const DUCK_VOLUME = 0.2

/** Whether a media report says the page is playing something (`playing` or a session that says so). */
export function reportIsPlaying(report: MediaReport): boolean {
  if (report.playbackState === 'playing') return true
  if (report.playbackState === 'paused') return false
  return report.playing
}

/**
 * Where playback stands `now`, from a report taken at `reportedAt`: the position moves with the
 * playback rate while playing, and stays put while paused. Never past the duration.
 */
export function extrapolatePosition(
  position: MediaPositionInfo,
  playing: boolean,
  reportedAt: number,
  now: number
): number {
  if (!playing) return position.position
  const elapsed = Math.max(0, now - reportedAt) / 1000
  const moved = position.position + elapsed * position.playbackRate
  const capped = position.duration > 0 ? Math.min(moved, position.duration) : moved
  return Math.max(0, capped)
}

/**
 * The picture the OS controls show for a session: the largest artwork the page listed (Chrome
 * picks by declared size; the first one when none says), or nothing.
 */
export function pickArtwork(artwork: readonly MediaArtwork[]): string | null {
  let best: MediaArtwork | null = null
  let bestSize = -1
  for (const item of artwork) {
    if (!/^(https?:|data:|blob:)/i.test(item.src)) continue
    const match = /(\d+)x(\d+)/i.exec(item.sizes)
    const size = match ? Number(match[1]) * Number(match[2]) : 0
    if (size > bestSize) {
      best = item
      bestSize = size
    }
  }
  return best?.src ?? null
}

/** Clamp a video's aspect ratio to what Android's picture-in-picture window accepts (1:2.39 … 2.39:1). */
export function pictureInPictureRatio(
  width: number,
  height: number
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 16, height: 9 }
  const ratio = width / height
  if (ratio > 2.39) return { width: 239, height: 100 }
  if (ratio < 1 / 2.39) return { width: 100, height: 239 }
  return { width: Math.round(width), height: Math.round(height) }
}

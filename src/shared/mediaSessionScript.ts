import {
  DEFAULT_SEEK_OFFSET_S,
  DUCK_VOLUME,
  EMPTY_MEDIA_REPORT,
  isMediaSessionAction,
  type MediaArtwork,
  type MediaMetadataInfo,
  type MediaPlaybackState,
  type MediaPositionInfo,
  type MediaReport,
  type MediaSessionAction,
  type MediaSessionHostMessage,
  PIP_FILL_ATTRIBUTE
} from './mediaSession'
import type { PageScriptMessage } from './pageScript'

/**
 * Runs inside pages on hosts whose engine feeds no OS media controls of its own (the Android
 * WebView): follows the page's `<audio>` / `<video>` elements and reports the one that matters,
 * and polyfills `navigator.mediaSession` (`MediaMetadata`, `setActionHandler`, `playbackState`,
 * `setPositionState`) so a page's metadata and handlers reach the same controls Chrome would show
 * them on. The browser sends the controls' actions back; a registered handler takes them, the
 * element itself takes the rest (Chrome's defaults for play, pause, stop and seeking).
 */
export interface MediaTrackingTransport {
  send(message: PageScriptMessage): void
  onMediaSession?(listener: (message: MediaSessionHostMessage) => void): void
}

const ACTIVE_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied'] as const
const CHANGE_EVENTS = [
  'volumechange',
  'durationchange',
  'seeked',
  'ratechange',
  'loadedmetadata',
  'resize'
] as const

/** Consecutive reports closer than this fold into one (a burst of events on a single change). */
const REPORT_DELAY_MS = 40

/** Detached players remembered at most (sound effects come and go by the dozen). */
const MAX_DETACHED = 32

interface PageWithSession {
  navigator: Navigator & { mediaSession?: unknown; userActivation?: { isActive: boolean } }
  MediaMetadata?: unknown
  MediaSession?: unknown
}

export function installMediaTracking(transport: MediaTrackingTransport): void {
  let active: HTMLMediaElement | null = null
  let last: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let volumeBeforeDuck: number | null = null

  const session = installMediaSessionPolyfill(() => schedule())

  const isMedia = (target: EventTarget | null): target is HTMLMediaElement =>
    typeof HTMLMediaElement !== 'undefined' && target instanceof HTMLMediaElement

  /**
   * Elements seen playing that are not in the document (`new Audio(src).play()`, the usual shape
   * of a music player or a sound effect): their events reach no document listener, so they are
   * listened to directly, from the `play()` call that started them.
   */
  const detached = new Set<HTMLMediaElement>()

  const playingElements = (): HTMLMediaElement[] => {
    const playing = (m: HTMLMediaElement): boolean => !m.paused && !m.ended && m.readyState > 0
    const inDocument = [...document.querySelectorAll('video,audio')].filter(
      (m) => isMedia(m) && playing(m)
    ) as HTMLMediaElement[]
    for (const m of detached) if (!m.isConnected && playing(m)) inDocument.push(m)
    return inDocument
  }

  const audible = (m: HTMLMediaElement): boolean =>
    !m.paused && !m.ended && !m.muted && m.volume > 0

  const describe = (): MediaReport => {
    const element = active
    const state = session.snapshot()
    if (!element) {
      return {
        ...EMPTY_MEDIA_REPORT,
        metadata: state.metadata,
        playbackState: state.playbackState,
        actions: state.actions
      }
    }
    const video = element instanceof HTMLVideoElement && element.videoWidth > 0
    const duration = Number.isFinite(element.duration) ? element.duration : 0
    const position: MediaPositionInfo | null = state.position ?? {
      duration,
      position: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      playbackRate: element.playbackRate
    }
    const fullscreenElement =
      document.fullscreenElement ??
      (document as Document & { webkitFullscreenElement?: Element | null })
        .webkitFullscreenElement ??
      null
    return {
      playing: audible(element),
      video,
      width: video ? (element as HTMLVideoElement).videoWidth : 0,
      height: video ? (element as HTMLVideoElement).videoHeight : 0,
      muted: element.muted || element.volume === 0,
      position: element.readyState > 0 ? position : null,
      metadata: state.metadata,
      playbackState: state.playbackState,
      actions: state.actions,
      fullscreen:
        fullscreenElement !== null &&
        (fullscreenElement === element || fullscreenElement.contains(element))
    }
  }

  const report = (): void => {
    timer = null
    const media = describe()
    const key = JSON.stringify(media)
    if (key === last) return
    last = key
    transport.send({ type: 'media', playing: media.playing, media })
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(report, REPORT_DELAY_MS)
  }

  const onActive = (e: Event): void => {
    const target = e.target
    if (!isMedia(target)) return
    if (e.type === 'play' || e.type === 'playing') active = target
    else if (active === null) active = target
    // The element that stopped hands the report to one still playing, when there is one.
    else if (active === target) active = playingElements()[0] ?? target
    schedule()
  }

  const onChange = (e: Event): void => {
    if (!isMedia(e.target)) return
    if (active === null) active = e.target
    if (e.target === active) schedule()
  }

  for (const type of ACTIVE_EVENTS) document.addEventListener(type, onActive, true)
  for (const type of CHANGE_EVENTS) document.addEventListener(type, onChange, true)
  document.addEventListener('fullscreenchange', schedule, true)
  document.addEventListener('webkitfullscreenchange', schedule, true)

  const listenDirectly = (element: HTMLMediaElement): void => {
    if (detached.has(element)) return
    if (detached.size >= MAX_DETACHED) {
      for (const m of detached) {
        if (m.paused && !m.isConnected) detached.delete(m)
        if (detached.size < MAX_DETACHED) break
      }
    }
    detached.add(element)
    for (const type of ACTIVE_EVENTS) element.addEventListener(type, onActive)
    for (const type of CHANGE_EVENTS) element.addEventListener(type, onChange)
  }
  try {
    const proto = HTMLMediaElement.prototype
    const nativePlay = proto.play
    proto.play = function play(this: HTMLMediaElement): Promise<void> {
      if (!this.isConnected) listenDirectly(this)
      return nativePlay.call(this)
    }
  } catch {
    /* a page that froze the prototype keeps its detached players unlisted */
  }
  window.addEventListener('pagehide', () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (last !== null && last !== JSON.stringify(EMPTY_MEDIA_REPORT)) {
      last = JSON.stringify(EMPTY_MEDIA_REPORT)
      transport.send({ type: 'media', playing: false, media: EMPTY_MEDIA_REPORT })
    }
  })

  const seek = (element: HTMLMediaElement, to: number): void => {
    const duration = Number.isFinite(element.duration) ? element.duration : Infinity
    const target = Math.max(0, Math.min(to, duration))
    try {
      if (typeof element.fastSeek === 'function') element.fastSeek(target)
      else element.currentTime = target
    } catch {
      element.currentTime = target
    }
  }

  /** Chrome's defaults for the actions a page left unhandled: the element does what they say. */
  const applyDefault = (message: MediaSessionHostMessage): void => {
    const element = active ?? playingElements()[0] ?? document.querySelector('video,audio')
    if (!isMedia(element)) return
    switch (message.action) {
      case 'play':
        void element.play().catch(() => undefined)
        return
      case 'pause':
        element.pause()
        return
      case 'toggle':
        if (element.paused) void element.play().catch(() => undefined)
        else element.pause()
        return
      case 'stop':
        element.pause()
        return
      case 'seekbackward':
        seek(element, element.currentTime - (message.seekOffset ?? DEFAULT_SEEK_OFFSET_S))
        return
      case 'seekforward':
        seek(element, element.currentTime + (message.seekOffset ?? DEFAULT_SEEK_OFFSET_S))
        return
      case 'seekto':
        if (typeof message.seekTime === 'number') seek(element, message.seekTime)
        return
      case 'duck':
        if (message.on) {
          if (volumeBeforeDuck === null) volumeBeforeDuck = element.volume
          element.volume = Math.min(element.volume, DUCK_VOLUME)
        } else if (volumeBeforeDuck !== null) {
          element.volume = volumeBeforeDuck
          volumeBeforeDuck = null
        }
        return
      case 'fill':
        setFill(element, Boolean(message.on))
        return
      default:
        return
    }
  }

  /**
   * `fill`: the host is showing the page's window as a picture-in-picture of its video, so the
   * video alone is laid over the viewport, the page's own layout untouched underneath (Chrome's
   * PiP shows the video surface alone; a WebView can only show the page, so the page shows the
   * video). Off puts the page back as it was.
   */
  const setFill = (element: HTMLMediaElement, on: boolean): void => {
    const marked = document.querySelectorAll(`[${PIP_FILL_ATTRIBUTE}]`)
    for (const m of marked) m.removeAttribute(PIP_FILL_ATTRIBUTE)
    document.getElementById(PIP_FILL_ATTRIBUTE)?.remove()
    if (!on || !(element instanceof HTMLVideoElement)) return
    element.setAttribute(PIP_FILL_ATTRIBUTE, '')
    const style = document.createElement('style')
    style.id = PIP_FILL_ATTRIBUTE
    style.textContent =
      `[${PIP_FILL_ATTRIBUTE}]{position:fixed!important;inset:0!important;width:100vw!important;` +
      `height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;` +
      `transform:none!important;object-fit:contain!important;background:#000!important;` +
      `z-index:2147483647!important;border-radius:0!important}` +
      `html,body{overflow:hidden!important;background:#000!important}`
    ;(document.head ?? document.documentElement).appendChild(style)
  }

  transport.onMediaSession?.((message) => {
    if (message.action === 'toggle') {
      const playing = active ? audible(active) || !active.paused : false
      const handled = session.dispatch(playing ? 'pause' : 'play', {})
      if (!handled) applyDefault(message)
      return
    }
    if (message.action === 'duck' || message.action === 'fill') {
      applyDefault(message)
      return
    }
    const details: MediaSessionActionDetails = { action: message.action }
    if (typeof message.seekTime === 'number') details.seekTime = message.seekTime
    if (typeof message.seekOffset === 'number') details.seekOffset = message.seekOffset
    if (session.dispatch(message.action, details)) return
    applyDefault(message)
  })
}

// ---------------------------------------------------------------------------
// The navigator.mediaSession polyfill
// ---------------------------------------------------------------------------

interface MediaSessionActionDetails {
  action: MediaSessionAction
  seekTime?: number
  seekOffset?: number
  fastSeek?: boolean
}

interface SessionSnapshot {
  metadata: MediaMetadataInfo | null
  playbackState: MediaPlaybackState
  actions: MediaSessionAction[]
  /** The page's own position state, when it set one. */
  position: MediaPositionInfo | null
}

interface SessionPolyfill {
  snapshot(): SessionSnapshot
  /** Run the page's handler for `action`; false when it registered none. */
  dispatch(action: MediaSessionAction, details: Omit<MediaSessionActionDetails, 'action'>): boolean
}

const PLAYBACK_STATES: readonly MediaPlaybackState[] = ['none', 'playing', 'paused']

/**
 * Define `navigator.mediaSession` and `MediaMetadata` when the engine has none; with a native
 * session the page's metadata never reaches this script (the engine's own controls take it), and
 * the polyfill stays out of the way.
 */
export function installMediaSessionPolyfill(changed: () => void): SessionPolyfill {
  const w = window as unknown as PageWithSession
  const handlers = new Map<MediaSessionAction, (details: MediaSessionActionDetails) => void>()
  let metadata: MediaMetadataLike | null = null
  let playbackState: MediaPlaybackState = 'none'
  let position: MediaPositionInfo | null = null

  const snapshot = (): SessionSnapshot => ({
    metadata: metadata ? metadata.__zenInfo() : null,
    playbackState,
    actions: [...handlers.keys()],
    position
  })

  const dispatch: SessionPolyfill['dispatch'] = (action, details) => {
    const handler = handlers.get(action)
    if (!handler) return false
    try {
      handler({ action, ...details })
    } catch {
      /* the page's handler failed; the control did what it could */
    }
    return true
  }

  if (w.navigator.mediaSession !== undefined) return { snapshot, dispatch }

  const resolveUrl = (src: unknown): string => {
    const text = String(src ?? '')
    try {
      return new URL(text, document.baseURI).href
    } catch {
      throw new TypeError(`Failed to construct 'MediaMetadata': '${text}' is not a valid URL.`)
    }
  }

  /** `MediaMetadata` of the spec: strings for the texts, resolved URLs for the artwork. */
  class MediaMetadata implements MediaMetadataLike {
    private _title = ''
    private _artist = ''
    private _album = ''
    private _artwork: MediaArtwork[] = []

    constructor(
      init?: Partial<Record<'title' | 'artist' | 'album', unknown>> & { artwork?: unknown }
    ) {
      if (init !== undefined && (typeof init !== 'object' || init === null))
        throw new TypeError("Failed to construct 'MediaMetadata': parameter 1 is not an object.")
      const source = init ?? {}
      this._title = String(source.title ?? '')
      this._artist = String(source.artist ?? '')
      this._album = String(source.album ?? '')
      this._artwork = MediaMetadata.artworkFrom(source.artwork)
    }

    static artworkFrom(value: unknown): MediaArtwork[] {
      if (value === undefined || value === null) return []
      if (!Array.isArray(value))
        throw new TypeError(
          "Failed to construct 'MediaMetadata': The provided value cannot be converted to a sequence."
        )
      return value.map((item: unknown) => {
        const image = (item ?? {}) as { src?: unknown; sizes?: unknown; type?: unknown }
        if (image.src === undefined)
          throw new TypeError(
            "Failed to construct 'MediaMetadata': required member src is undefined."
          )
        return Object.freeze({
          src: resolveUrl(image.src),
          sizes: String(image.sizes ?? ''),
          type: String(image.type ?? '')
        })
      })
    }

    get title(): string {
      return this._title
    }
    set title(value: unknown) {
      this._title = String(value ?? '')
      this.__zenChanged()
    }
    get artist(): string {
      return this._artist
    }
    set artist(value: unknown) {
      this._artist = String(value ?? '')
      this.__zenChanged()
    }
    get album(): string {
      return this._album
    }
    set album(value: unknown) {
      this._album = String(value ?? '')
      this.__zenChanged()
    }
    get artwork(): ReadonlyArray<MediaArtwork> {
      return Object.freeze([...this._artwork])
    }
    set artwork(value: unknown) {
      this._artwork = MediaMetadata.artworkFrom(value)
      this.__zenChanged()
    }

    __zenInfo(): MediaMetadataInfo {
      return {
        title: this._title,
        artist: this._artist,
        album: this._album,
        artwork: this._artwork.map((a) => ({ ...a }))
      }
    }

    __zenChanged(): void {
      if (metadata === this) changed()
    }
  }

  const mediaSession = {
    get metadata(): MediaMetadataLike | null {
      return metadata
    },
    set metadata(value: MediaMetadataLike | null) {
      if (value !== null && !(value instanceof MediaMetadata))
        throw new TypeError(
          "Failed to set the 'metadata' property on 'MediaSession': Failed to convert value to 'MediaMetadata'."
        )
      metadata = value
      changed()
    },
    get playbackState(): MediaPlaybackState {
      return playbackState
    },
    set playbackState(value: MediaPlaybackState) {
      if (!PLAYBACK_STATES.includes(value))
        throw new TypeError(
          `Failed to set the 'playbackState' property on 'MediaSession': The provided value '${String(value)}' is not a valid enum value of type MediaSessionPlaybackState.`
        )
      playbackState = value
      changed()
    },
    setActionHandler(action: unknown, handler: unknown): void {
      if (!isMediaSessionAction(action))
        throw new TypeError(
          `Failed to execute 'setActionHandler' on 'MediaSession': The provided value '${String(action)}' is not a valid enum value of type MediaSessionAction.`
        )
      if (typeof handler === 'function')
        handlers.set(action, handler as (d: MediaSessionActionDetails) => void)
      else if (handler === null || handler === undefined) handlers.delete(action)
      else
        throw new TypeError(
          "Failed to execute 'setActionHandler' on 'MediaSession': The callback provided as parameter 2 is not a function."
        )
      changed()
    },
    setPositionState(state?: {
      duration?: number
      playbackRate?: number
      position?: number
    }): void {
      if (state === undefined || state === null || Object.keys(state).length === 0) {
        position = null
        changed()
        return
      }
      const duration = state.duration === undefined ? Infinity : Number(state.duration)
      const rate = state.playbackRate === undefined ? 1 : Number(state.playbackRate)
      const at = state.position === undefined ? 0 : Number(state.position)
      if (Number.isNaN(duration) || duration < 0)
        throw new TypeError(
          "Failed to execute 'setPositionState' on 'MediaSession': The provided duration cannot be less than zero."
        )
      if (Number.isNaN(at) || at < 0 || at > duration)
        throw new TypeError(
          "Failed to execute 'setPositionState' on 'MediaSession': The provided position cannot be greater than the duration."
        )
      if (Number.isNaN(rate) || rate === 0)
        throw new TypeError(
          "Failed to execute 'setPositionState' on 'MediaSession': The provided playbackRate cannot be equal to zero."
        )
      position = {
        duration: Number.isFinite(duration) ? duration : 0,
        position: at,
        playbackRate: rate
      }
      changed()
    },
    setMicrophoneActive(): void {
      /* no capture indicator on this host */
    },
    setCameraActive(): void {
      /* no capture indicator on this host */
    }
  }

  const define = (target: object, name: string, value: unknown): void => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value
      })
    } catch {
      /* a page that froze the object keeps it as it is */
    }
  }
  define(w.navigator, 'mediaSession', mediaSession)
  define(w, 'MediaMetadata', MediaMetadata)
  return { snapshot, dispatch }
}

interface MediaMetadataLike {
  title: string
  artist: string
  album: string
  artwork: ReadonlyArray<MediaArtwork>
  __zenInfo(): MediaMetadataInfo
}

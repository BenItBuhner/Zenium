/**
 * The Media Session on a desktop engine (Electron, MW-16 / MW-18): Chromium exposes
 * `navigator.mediaSession` to pages and feeds the OS controls itself, but keeps what a page set
 * (metadata, handlers, position) in the browser process, out of an embedder's reach – and the
 * media hub, the MPRIS player and the in-app controls need it. So Zenium reads it in the page:
 * `installMediaSessionShim` runs in the page's main world, wraps the engine's own `MediaSession`
 * (the page's calls still reach the engine, so hardware keys keep working where the OS routes
 * them) and follows the media elements, and reports one `MediaReport` at a time – the same
 * report Android's page script sends (`mediaSessionScript`) – through a DOM event; the isolated
 * world's `installMediaSessionBridge` validates and forwards it to the browser, and hands the
 * browser's actions (`MediaSessionHostMessage`) back: to the page's own handler when it
 * registered one, else to the element, as Chrome's defaults do.
 */

import {
  isMediaSessionAction,
  MEDIA_SESSION_ACTIONS,
  type MediaReport,
  type MediaSessionAction,
  type MediaSessionHostMessage
} from './mediaSession'

/** Names of the DOM events the two worlds of the page talk over. */
export interface MediaSessionShimEvents {
  /** Main world → isolated world: a `MediaReport`, JSON in `detail`. */
  update: string
  /** Isolated world → main world: an action (`{ action, seekTime?, seekOffset? }`), JSON in `detail`. */
  control: string
}

export const MEDIA_SESSION_EVENTS: MediaSessionShimEvents = {
  update: 'zen-media-session-update',
  control: 'zen-media-session-control'
}

/** The isolated world's transport to the browser. */
export interface MediaSessionBridgeTransport {
  /** A report for the browser (a `media` page message). */
  send(report: MediaReport): void
  /** The browser sends an action for the page. */
  onControl(listener: (message: MediaSessionHostMessage) => void): void
  /** Run `installMediaSessionShim` in the main world. */
  installShim(events: MediaSessionShimEvents, actions: readonly MediaSessionAction[]): void
}

const PLAYBACK_STATES = ['none', 'playing', 'paused']

/** Whether a value has the shape of a `MediaReport` (the page's world is not trusted). */
export function isMediaReport(value: unknown): value is MediaReport {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (
    typeof r.playing !== 'boolean' ||
    typeof r.video !== 'boolean' ||
    typeof r.muted !== 'boolean' ||
    typeof r.fullscreen !== 'boolean'
  )
    return false
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height)) return false
  if (!PLAYBACK_STATES.includes(r.playbackState as string)) return false
  if (!Array.isArray(r.actions) || !r.actions.every(isMediaSessionAction)) return false
  if (r.position !== null) {
    if (!r.position || typeof r.position !== 'object') return false
    const p = r.position as Record<string, unknown>
    if (!isFiniteNumber(p.duration) || !isFiniteNumber(p.position) || !isFiniteNumber(p.playbackRate))
      return false
  }
  if (r.metadata === null) return true
  if (!r.metadata || typeof r.metadata !== 'object') return false
  const m = r.metadata as Record<string, unknown>
  if (typeof m.title !== 'string' || typeof m.artist !== 'string' || typeof m.album !== 'string')
    return false
  return (
    Array.isArray(m.artwork) &&
    m.artwork.every(
      (art: unknown) =>
        !!art &&
        typeof art === 'object' &&
        typeof (art as Record<string, unknown>).src === 'string' &&
        typeof (art as Record<string, unknown>).sizes === 'string' &&
        typeof (art as Record<string, unknown>).type === 'string'
    )
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`: the function is
 * serialised, so it is one self-contained function taking everything it needs as arguments
 * (`actions` is the list of action names the browser accepts). Never throws into the page.
 */
export function installMediaSessionShim(
  events: MediaSessionShimEvents,
  actions: readonly string[]
): void {
  type Handler = (details: {
    action: string
    seekTime?: number
    seekOffset?: number
    fastSeek?: boolean
  }) => void
  interface Position {
    duration: number
    position: number
    playbackRate: number
  }
  interface Artwork {
    src: string
    sizes: string
    type: string
  }
  const win = globalThis as Window & typeof globalThis
  const doc = win.document
  const define = (target: object, name: string, descriptor: PropertyDescriptor): void => {
    try {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor })
    } catch {
      /* a frozen object keeps the engine's own */
    }
  }

  const handlers = new Map<string, Handler>()
  let metadata: MediaMetadata | null = null
  let sessionState: 'none' | 'paused' | 'playing' = 'none'
  let pagePosition: Position | null = null
  /** The element that played last (the controls act on it while nothing else plays). */
  let current: HTMLMediaElement | null = null
  let reported: string | null = null
  let scheduled = false
  let ticker: ReturnType<typeof setInterval> | null = null

  const elements = (): HTMLMediaElement[] => {
    try {
      return [...doc.querySelectorAll('video,audio')] as HTMLMediaElement[]
    } catch {
      return []
    }
  }
  const primary = (): HTMLMediaElement | null => {
    const all = elements()
    const playing = all.find((m) => !m.paused && !m.ended)
    if (playing) return playing
    if (current && current.isConnected) return current
    return null
  }

  /** The metadata's artwork, absolute; a blob of this page's world cannot be reached from the chrome. */
  const artworkList = (): Artwork[] => {
    const list = metadata?.artwork
    if (!list || list.length === 0) return []
    const out: Artwork[] = []
    for (const art of list) {
      if (!art || typeof art.src !== 'string' || !art.src) continue
      try {
        const url = new URL(art.src, doc.baseURI)
        if (url.protocol === 'blob:') continue
        out.push({ src: url.href, sizes: String(art.sizes ?? ''), type: String(art.type ?? '') })
      } catch {
        /* not a URL */
      }
    }
    return out
  }

  const empty = (): string =>
    JSON.stringify({
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
    })

  const snapshot = (): string => {
    const el = primary()
    // Media worth a control: an element has played here, or the page set session data.
    if (current === null && metadata === null && sessionState === 'none') return empty()
    const elementPlaying = Boolean(el && !el.paused && !el.ended)
    let position: Position | null = pagePosition
    if (!position && el && el.readyState > 0) {
      position = {
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        position: Number.isFinite(el.currentTime) ? el.currentTime : 0,
        playbackRate: Number.isFinite(el.playbackRate) ? el.playbackRate : 1
      }
    }
    const video = Boolean(el && el instanceof HTMLVideoElement && el.videoWidth > 0)
    const fullscreenElement =
      doc.fullscreenElement ??
      (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
      null
    return JSON.stringify({
      playing: Boolean(el && elementPlaying && !el.muted && el.volume > 0),
      video,
      width: video ? (el as HTMLVideoElement).videoWidth : 0,
      height: video ? (el as HTMLVideoElement).videoHeight : 0,
      muted: Boolean(el && (el.muted || el.volume === 0)),
      position,
      metadata: metadata
        ? {
            title: String(metadata.title ?? ''),
            artist: String(metadata.artist ?? ''),
            album: String(metadata.album ?? ''),
            artwork: artworkList()
          }
        : null,
      playbackState: sessionState,
      actions: [...handlers.keys()],
      fullscreen:
        el !== null &&
        fullscreenElement !== null &&
        (fullscreenElement === el || fullscreenElement.contains(el))
    })
  }

  const report = (force = false): void => {
    scheduled = false
    let next: string
    try {
      next = snapshot()
    } catch {
      return
    }
    if (!force && next === reported) return
    reported = next
    doc.dispatchEvent(new CustomEvent(events.update, { detail: next }))
    // While playing, the position moves: a report every so often keeps a seek bar honest even
    // when the page never touches the session (the browser extrapolates in between).
    const playing =
      next.includes('"playing":true') || next.includes('"playbackState":"playing"')
    if (playing && ticker === null) ticker = setInterval(() => report(true), 10_000)
    if (!playing && ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => report(), 50)
  }

  // --- navigator.mediaSession -------------------------------------------------------------------
  const MS = (win as unknown as { MediaSession?: { prototype: MediaSession } }).MediaSession
  const proto = MS?.prototype
  if (proto) {
    const meta = Object.getOwnPropertyDescriptor(proto, 'metadata')
    if (meta?.get && meta.set) {
      const get = meta.get
      const set = meta.set
      define(proto, 'metadata', {
        get(this: MediaSession) {
          return get.call(this)
        },
        set(this: MediaSession, value: MediaMetadata | null) {
          set.call(this, value)
          metadata = value ?? null
          schedule()
        }
      })
    }
    const state = Object.getOwnPropertyDescriptor(proto, 'playbackState')
    if (state?.get && state.set) {
      const get = state.get
      const set = state.set
      define(proto, 'playbackState', {
        get(this: MediaSession) {
          return get.call(this)
        },
        set(this: MediaSession, value: MediaSessionPlaybackState) {
          set.call(this, value)
          sessionState = value === 'playing' || value === 'paused' ? value : 'none'
          schedule()
        }
      })
    }
    const setActionHandler = proto.setActionHandler
    if (typeof setActionHandler === 'function') {
      define(proto, 'setActionHandler', {
        writable: true,
        value: function (this: MediaSession, action: string, handler: Handler | null): void {
          // The engine still learns the handler (and refuses a name it does not know).
          ;(setActionHandler as (a: string, h: Handler | null) => void).call(this, action, handler)
          if (typeof handler === 'function') handlers.set(action, handler)
          else handlers.delete(action)
          schedule()
        }
      })
    }
    const setPositionState = proto.setPositionState
    if (typeof setPositionState === 'function') {
      define(proto, 'setPositionState', {
        writable: true,
        value: function (this: MediaSession, state?: MediaPositionState): void {
          setPositionState.call(this, state)
          // An empty dictionary clears the state (the standard's way); anything with a duration sets it.
          if (state && typeof state === 'object' && state.duration !== undefined) {
            pagePosition = {
              duration:
                state.duration !== undefined && Number.isFinite(state.duration)
                  ? Math.max(0, state.duration)
                  : 0,
              position:
                state.position !== undefined && Number.isFinite(state.position)
                  ? Math.max(0, state.position)
                  : 0,
              playbackRate:
                state.playbackRate !== undefined && Number.isFinite(state.playbackRate)
                  ? state.playbackRate
                  : 1
            }
          } else pagePosition = null
          schedule()
        }
      })
    }
  }

  // --- media elements ---------------------------------------------------------------------------
  const onMediaEvent = (e: Event): void => {
    const target = e.target
    if (!(target instanceof HTMLMediaElement)) return
    if (e.type === 'play' || e.type === 'playing') current = target
    if ((e.type === 'emptied' || e.type === 'ended') && pagePosition && target === current)
      pagePosition = null
    schedule()
  }
  for (const type of [
    'play',
    'playing',
    'pause',
    'ended',
    'emptied',
    'seeked',
    'ratechange',
    'durationchange',
    'loadedmetadata',
    'volumechange',
    'resize'
  ])
    doc.addEventListener(type, onMediaEvent, true)
  doc.addEventListener('fullscreenchange', () => schedule(), true)
  doc.addEventListener('webkitfullscreenchange', () => schedule(), true)
  win.addEventListener('pagehide', () => {
    current = null
    metadata = null
    sessionState = 'none'
    pagePosition = null
    handlers.clear()
    report(true)
  })

  // --- actions from the browser -----------------------------------------------------------------
  const isAction = (value: unknown): value is string =>
    typeof value === 'string' && actions.includes(value)
  /** An exact seek (Chrome's default handlers set `currentTime`; `fastSeek` lands on a keyframe). */
  const seek = (el: HTMLMediaElement, to: number): void => {
    const duration = Number.isFinite(el.duration) ? el.duration : Infinity
    try {
      el.currentTime = Math.max(0, Math.min(to, duration))
    } catch {
      /* nothing loaded yet: the seek is dropped, as Chrome drops it */
    }
  }
  doc.addEventListener(events.control, (e) => {
    let control: { action?: unknown; seekTime?: unknown; seekOffset?: unknown }
    try {
      const detail = (e as CustomEvent<unknown>).detail
      control = typeof detail === 'string' ? JSON.parse(detail) : (detail as typeof control)
    } catch {
      return
    }
    if (!control) return
    let action = control.action
    if (action === 'toggle') {
      // The page's declared state first, the element's otherwise (as Chrome's play/pause button).
      const el = primary()
      const elementPlaying = Boolean(el && !el.paused && !el.ended)
      const playing = sessionState !== 'none' ? sessionState === 'playing' : elementPlaying
      action = playing ? 'pause' : 'play'
    }
    if (!isAction(action)) return
    const seekTime = typeof control.seekTime === 'number' ? control.seekTime : undefined
    const seekOffset = typeof control.seekOffset === 'number' ? control.seekOffset : undefined
    const handler = handlers.get(action)
    try {
      if (handler) {
        handler.call(win.navigator.mediaSession, {
          action,
          ...(seekTime !== undefined ? { seekTime } : {}),
          ...(seekOffset !== undefined ? { seekOffset } : {}),
          fastSeek: false
        })
        // A page that paused or seeked through its handler usually updates the session itself;
        // ask again shortly in case it only touched the element.
        setTimeout(() => report(true), 250)
        return
      }
      const el = primary()
      if (!el) return
      const step = seekOffset ?? 10
      switch (action) {
        case 'play':
          el.play().catch(() => undefined)
          break
        case 'pause':
          el.pause()
          break
        case 'stop':
          el.pause()
          break
        case 'seekto':
          if (seekTime !== undefined) seek(el, seekTime)
          break
        case 'seekbackward':
          seek(el, el.currentTime - step)
          break
        case 'seekforward':
          seek(el, el.currentTime + step)
          break
        default:
          /* next / previous mean nothing to a lone element */
          break
      }
      schedule()
    } catch {
      /* a page's handler threw; nothing to do */
    }
  })
}

/**
 * The isolated-world half: forwards the shim's reports to the browser, hands the browser's
 * actions to the shim. `duck` and `fill` (Android's) never reach a desktop page: Electron's
 * Chromium answers audio focus itself, and its picture-in-picture is the page's own.
 */
export function installMediaSessionBridge(
  transport: MediaSessionBridgeTransport,
  events: MediaSessionShimEvents = MEDIA_SESSION_EVENTS
): void {
  document.addEventListener(events.update, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    let value: unknown = detail
    if (typeof detail === 'string') {
      try {
        value = JSON.parse(detail)
      } catch {
        return
      }
    }
    if (isMediaReport(value)) transport.send(value)
  })
  transport.onControl((message) => {
    if (!message || typeof message.action !== 'string') return
    if (message.action !== 'toggle' && !isMediaSessionAction(message.action)) return
    document.dispatchEvent(
      new CustomEvent(events.control, {
        detail: JSON.stringify({
          action: message.action,
          ...(typeof message.seekTime === 'number' ? { seekTime: message.seekTime } : {}),
          ...(typeof message.seekOffset === 'number' ? { seekOffset: message.seekOffset } : {})
        })
      })
    )
  })
  transport.installShim(events, MEDIA_SESSION_ACTIONS)
}

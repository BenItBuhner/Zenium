// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEDIA_SESSION_EVENTS,
  installMediaSessionBridge,
  installMediaSessionShim,
  isMediaReport,
  type MediaSessionBridgeTransport,
  type MediaSessionShimEvents
} from '../mediaSessionShim'
import {
  EMPTY_MEDIA_REPORT,
  type MediaReport,
  type MediaSessionAction,
  type MediaSessionHostMessage
} from '../mediaSession'

const T0 = 1_700_000_000_000

interface NativeSession {
  /** `setActionHandler` calls the engine saw. */
  handlers: Array<[string, unknown]>
  /** `setPositionState` calls the engine saw. */
  positions: unknown[]
}

/** Stand-ins for the engine's `MediaSession` and `MediaMetadata`, which happy-dom lacks. */
function fakeMediaSession(): NativeSession {
  const native: NativeSession = { handlers: [], positions: [] }
  class MediaMetadata {
    title: string
    artist: string
    album: string
    artwork: Array<{ src: string; sizes?: string; type?: string }>
    constructor(init: Partial<MediaMetadata> = {}) {
      this.title = init.title ?? ''
      this.artist = init.artist ?? ''
      this.album = init.album ?? ''
      this.artwork = init.artwork ?? []
    }
  }
  class MediaSession {
    private stored: MediaMetadata | null = null
    private state = 'none'
    get metadata(): MediaMetadata | null {
      return this.stored
    }
    set metadata(value: MediaMetadata | null) {
      this.stored = value
    }
    get playbackState(): string {
      return this.state
    }
    set playbackState(value: string) {
      this.state = value
    }
    setActionHandler(action: string, handler: unknown): void {
      native.handlers.push([action, handler])
    }
    setPositionState(state?: unknown): void {
      native.positions.push(state)
    }
  }
  Object.defineProperty(globalThis, 'MediaMetadata', { value: MediaMetadata, configurable: true })
  Object.defineProperty(globalThis, 'MediaSession', { value: MediaSession, configurable: true })
  Object.defineProperty(navigator, 'mediaSession', {
    value: new MediaSession(),
    configurable: true
  })
  return native
}

interface ScriptedBridge {
  events: MediaSessionShimEvents
  /** Reports the isolated world handed the browser. */
  sent: MediaReport[]
  /** An action from the browser. */
  control: (message: MediaSessionHostMessage) => void
}

let installs = 0

/** The isolated-world half with the browser scripted; its own event names per install. */
function bridge(): ScriptedBridge {
  installs++
  const events: MediaSessionShimEvents = {
    update: `${MEDIA_SESSION_EVENTS.update}-${installs}`,
    control: `${MEDIA_SESSION_EVENTS.control}-${installs}`
  }
  let push: (message: MediaSessionHostMessage) => void = () => undefined
  const state: ScriptedBridge = { events, sent: [], control: (c) => push(c) }
  const transport: MediaSessionBridgeTransport = {
    send: (report) => {
      state.sent.push(report)
    },
    onControl: (listener) => {
      push = listener
    },
    installShim: (e, actions) => installMediaSessionShim(e, actions)
  }
  installMediaSessionBridge(transport, events)
  return state
}

/** A `<video>` with metadata loaded (happy-dom's has none): a duration, or Infinity for a live stream. */
function video(duration: number): HTMLVideoElement {
  const el = document.createElement('video')
  Object.defineProperty(el, 'duration', { value: duration, configurable: true })
  Object.defineProperty(el, 'readyState', { value: 4, configurable: true })
  document.body.appendChild(el)
  return el
}

/** The shim reports 50 ms after the last change. */
const settle = (): void => {
  vi.advanceTimersByTime(50)
}

/** The browser's word for a control (`MediaSessionService.act`). */
const act = (
  action: MediaSessionAction | 'toggle' | 'duck' | 'fill',
  details: Partial<MediaSessionHostMessage> = {}
): MediaSessionHostMessage => ({ type: 'mediaSession', action, ...details })

describe('Media Session shim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    Reflect.deleteProperty(globalThis, 'MediaSession')
    Reflect.deleteProperty(globalThis, 'MediaMetadata')
  })

  it('reports a playing element, then its pause, and nothing while the state stands', () => {
    fakeMediaSession()
    const b = bridge()
    const el = video(120)
    expect(b.sent).toEqual([])
    void el.play()
    settle()
    expect(b.sent).toEqual([
      {
        playing: true,
        video: false,
        width: 0,
        height: 0,
        muted: false,
        // The element's position is read when the report is made.
        position: { duration: 120, position: 0, playbackRate: 1 },
        metadata: null,
        playbackState: 'none',
        actions: [],
        fullscreen: false
      }
    ])
    el.pause()
    settle()
    expect(b.sent).toHaveLength(2)
    expect(b.sent[1]).toMatchObject({ playing: false, position: { duration: 120 } })
    el.pause()
    settle()
    expect(b.sent).toHaveLength(2)
  })

  it('a muted element plays for the tab but not for the controls, as in Chrome', () => {
    fakeMediaSession()
    const b = bridge()
    const el = video(120)
    el.muted = true
    void el.play()
    settle()
    expect(b.sent.at(-1)).toMatchObject({ playing: false, muted: true })
    // The engine fires volumechange on the change (happy-dom's setter does not).
    el.muted = false
    el.dispatchEvent(new Event('volumechange'))
    settle()
    expect(b.sent.at(-1)).toMatchObject({ playing: true, muted: false })
  })

  it('reports the page’s Media Session: metadata with its artwork, state and handlers', () => {
    const native = fakeMediaSession()
    const b = bridge()
    const session = navigator.mediaSession
    session.metadata = new MediaMetadata({
      title: 'Song',
      artist: 'Band',
      album: 'Record',
      artwork: [
        { src: '/small.png', sizes: '96x96' },
        { src: '/big.png', sizes: '256x256 512x512', type: 'image/png' },
        { src: '/nosize.png' }
      ]
    })
    session.playbackState = 'playing'
    session.setActionHandler('nexttrack', () => undefined)
    session.setActionHandler('play', () => undefined)
    settle()
    expect(b.sent).toEqual([
      {
        playing: false,
        video: false,
        width: 0,
        height: 0,
        muted: false,
        position: null,
        metadata: {
          title: 'Song',
          artist: 'Band',
          album: 'Record',
          artwork: [
            { src: 'http://localhost:3000/small.png', sizes: '96x96', type: '' },
            { src: 'http://localhost:3000/big.png', sizes: '256x256 512x512', type: 'image/png' },
            { src: 'http://localhost:3000/nosize.png', sizes: '', type: '' }
          ]
        },
        playbackState: 'playing',
        actions: ['nexttrack', 'play'],
        fullscreen: false
      }
    ])
    // The engine still learns everything (hardware keys on Windows and macOS go through it).
    expect(session.metadata?.title).toBe('Song')
    expect(session.playbackState).toBe('playing')
    expect(native.handlers.map(([action]) => action)).toEqual(['nexttrack', 'play'])
    // Taking a handler and the metadata away is reported too.
    session.setActionHandler('nexttrack', null)
    session.metadata = null
    session.playbackState = 'paused'
    settle()
    expect(b.sent[1]).toMatchObject({
      playbackState: 'paused',
      metadata: null,
      actions: ['play']
    })
  })

  it('names no artwork the chrome cannot load', () => {
    fakeMediaSession()
    const b = bridge()
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'x',
      artwork: [{ src: 'blob:http://localhost:3000/abc', sizes: 'any' }, { src: 'http://[::1' }]
    })
    settle()
    expect(b.sent[0].metadata?.artwork).toEqual([])
  })

  it('prefers setPositionState over the element and clears it with an empty dictionary', () => {
    const native = fakeMediaSession()
    const b = bridge()
    const el = video(120)
    void el.play()
    el.currentTime = 7
    navigator.mediaSession.setPositionState({ duration: 300, position: 12, playbackRate: 1.5 })
    settle()
    expect(b.sent.at(-1)?.position).toEqual({ duration: 300, position: 12, playbackRate: 1.5 })
    expect(native.positions).toHaveLength(1)
    navigator.mediaSession.setPositionState({})
    settle()
    // Back to the element, read at report time.
    expect(b.sent.at(-1)?.position).toEqual({ duration: 120, position: 7, playbackRate: 1 })
    // Infinity is a live stream: no length (0, the report's word for none).
    navigator.mediaSession.setPositionState({ duration: Infinity, position: 3 })
    settle()
    expect(b.sent.at(-1)?.position).toEqual({ duration: 0, position: 3, playbackRate: 1 })
  })

  it('drives the element when the page has no handler, and the handler when it has one', () => {
    fakeMediaSession()
    const b = bridge()
    const el = video(100)
    void el.play()
    el.currentTime = 50
    settle()
    b.control(act('seekforward'))
    expect(el.currentTime).toBe(60)
    b.control(act('seekbackward', { seekOffset: 25 }))
    expect(el.currentTime).toBe(35)
    b.control(act('seekforward', { seekOffset: 500 }))
    expect(el.currentTime).toBe(100)
    b.control(act('seekto', { seekTime: 42 }))
    expect(el.currentTime).toBe(42)
    b.control(act('pause'))
    expect(el.paused).toBe(true)
    b.control(act('play'))
    expect(el.paused).toBe(false)
    b.control(act('stop'))
    expect(el.paused).toBe(true)
    // `toggle` plays a paused element and pauses a playing one (the hub's one button).
    b.control(act('toggle'))
    expect(el.paused).toBe(false)
    b.control(act('toggle'))
    expect(el.paused).toBe(true)
    // Next / previous mean nothing to a lone element; Android's duck and fill, and an action
    // nobody knows, are dropped.
    b.control(act('nexttrack'))
    b.control(act('duck', { on: true }))
    b.control(act('fill', { on: true }))
    b.control(act('dance' as MediaSessionAction))
    expect(el.currentTime).toBe(42)
    expect(el.volume).toBe(1)
    // The page's handler takes over, with Chrome's details.
    const pause = vi.fn()
    navigator.mediaSession.setActionHandler('pause', pause)
    void el.play()
    b.control(act('pause'))
    expect(pause).toHaveBeenCalledWith({ action: 'pause', fastSeek: false })
    expect(el.paused).toBe(false)
    // `toggle` on a playing element goes to the page's pause handler too.
    b.control(act('toggle'))
    expect(pause).toHaveBeenCalledTimes(2)
    const seek = vi.fn()
    navigator.mediaSession.setActionHandler('seekto', seek)
    b.control(act('seekto', { seekTime: 9 }))
    expect(seek).toHaveBeenCalledWith({ action: 'seekto', seekTime: 9, fastSeek: false })
    expect(el.currentTime).toBe(42)
  })

  it('toggle follows the page’s declared state before the element’s', () => {
    fakeMediaSession()
    const b = bridge()
    const el = video(100)
    const play = vi.fn()
    const pause = vi.fn()
    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', pause)
    // The element plays, but the page says paused (its own player state rules).
    void el.play()
    navigator.mediaSession.playbackState = 'paused'
    b.control(act('toggle'))
    expect(play).toHaveBeenCalledTimes(1)
    expect(pause).not.toHaveBeenCalled()
  })

  it('keeps the position fresh every ten seconds while playing and takes the entry down on pagehide', () => {
    fakeMediaSession()
    const b = bridge()
    const el = video(Infinity)
    void el.play()
    settle()
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0].position).toEqual({ duration: 0, position: 0, playbackRate: 1 })
    vi.advanceTimersByTime(10_000)
    expect(b.sent).toHaveLength(2)
    el.pause()
    settle()
    expect(b.sent).toHaveLength(3)
    vi.advanceTimersByTime(30_000)
    expect(b.sent).toHaveLength(3)
    window.dispatchEvent(new Event('pagehide'))
    expect(b.sent).toHaveLength(4)
    expect(b.sent[3]).toEqual(EMPTY_MEDIA_REPORT)
  })

  it('the bridge forwards only well-formed reports', () => {
    fakeMediaSession()
    const b = bridge()
    const update = (detail: string): boolean =>
      document.dispatchEvent(new CustomEvent(b.events.update, { detail }))
    update(JSON.stringify({ playing: true, playbackState: 'loud' }))
    update(JSON.stringify({ ...EMPTY_MEDIA_REPORT, actions: ['dance'] }))
    update(JSON.stringify({ ...EMPTY_MEDIA_REPORT, position: { duration: 'long' } }))
    update('{bad')
    expect(b.sent).toEqual([])
    update(JSON.stringify(EMPTY_MEDIA_REPORT))
    expect(b.sent).toEqual([EMPTY_MEDIA_REPORT])
    expect(isMediaReport({ ...EMPTY_MEDIA_REPORT, metadata: { title: 'x' } })).toBe(false)
    expect(
      isMediaReport({
        ...EMPTY_MEDIA_REPORT,
        metadata: {
          title: 'x',
          artist: '',
          album: '',
          artwork: [{ src: 'a', sizes: '', type: '' }]
        }
      })
    ).toBe(true)
  })

  it('watches the elements alone on a page whose engine has no MediaSession', () => {
    const b = bridge()
    const el = video(10)
    void el.play()
    settle()
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]).toMatchObject({ playing: true, playbackState: 'none', actions: [] })
  })
})

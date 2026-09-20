// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMediaTracking } from '../mediaSessionScript'
import {
  DEFAULT_SEEK_OFFSET_S,
  DUCK_VOLUME,
  EMPTY_MEDIA_REPORT,
  PIP_FILL_ATTRIBUTE,
  type MediaReport,
  type MediaSessionHostMessage
} from '../mediaSession'
import type { PageScriptMessage } from '../pageScript'

interface Harness {
  sent: PageScriptMessage[]
  reports(): MediaReport[]
  last(): MediaReport
  host(message: Omit<MediaSessionHostMessage, 'type'>): void
  /** Let the debounced report go out. */
  flush(): void
}

interface PageSession {
  metadata: unknown
  playbackState: string
  setActionHandler(action: unknown, handler: unknown): void
  setPositionState(state?: unknown): void
}

type MediaMetadataCtor = new (init?: unknown) => {
  title: string
  artist: string
  album: string
  artwork: ReadonlyArray<{ src: string; sizes: string; type: string }>
}

const page = (): { session: PageSession; MediaMetadata: MediaMetadataCtor } => ({
  session: (navigator as unknown as { mediaSession: PageSession }).mediaSession,
  MediaMetadata: (window as unknown as { MediaMetadata: MediaMetadataCtor }).MediaMetadata
})

function install(): Harness {
  const sent: PageScriptMessage[] = []
  let listener: ((message: MediaSessionHostMessage) => void) | null = null
  installMediaTracking({
    send: (message) => sent.push(message),
    onMediaSession: (l) => {
      listener = l
    }
  })
  const reports = (): MediaReport[] =>
    sent.filter((m) => m.type === 'media').map((m) => m.media as MediaReport)
  return {
    sent,
    reports,
    last: () => {
      const all = reports()
      expect(all.length).toBeGreaterThan(0)
      return all[all.length - 1]
    },
    host: (message) => listener?.({ type: 'mediaSession', ...message } as MediaSessionHostMessage),
    flush: () => {
      vi.advanceTimersByTime(100)
    }
  }
}

const define = (target: object, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { configurable: true, writable: true, value })
}

/** A `<video>` with a picture and a duration (happy-dom loads nothing on its own). */
function video(
  options: { width?: number; height?: number; duration?: number; ready?: number } = {}
): HTMLVideoElement {
  const v = document.createElement('video')
  define(v, 'readyState', options.ready ?? 4)
  define(v, 'videoWidth', options.width ?? 1280)
  define(v, 'videoHeight', options.height ?? 720)
  define(v, 'duration', options.duration ?? 100)
  document.body.appendChild(v)
  return v
}

function audio(options: { duration?: number; attach?: boolean } = {}): HTMLAudioElement {
  const a = document.createElement('audio')
  define(a, 'readyState', 4)
  define(a, 'duration', options.duration ?? 200)
  if (options.attach !== false) document.body.appendChild(a)
  return a
}

async function play(element: HTMLMediaElement): Promise<void> {
  await element.play()
  element.dispatchEvent(new Event('play'))
  element.dispatchEvent(new Event('playing'))
}

function pause(element: HTMLMediaElement): void {
  element.pause()
  element.dispatchEvent(new Event('pause'))
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  // Each test installs afresh: the polyfill stays out when a session is already defined.
  delete (navigator as unknown as { mediaSession?: unknown }).mediaSession
  delete (window as unknown as { MediaMetadata?: unknown }).MediaMetadata
})

describe('installMediaTracking: following the media of the page', () => {
  it('defines navigator.mediaSession and MediaMetadata on a host without them', () => {
    expect((navigator as unknown as { mediaSession?: unknown }).mediaSession).toBeUndefined()
    install()
    const { session, MediaMetadata } = page()
    expect(session).toBeDefined()
    expect(typeof session.setActionHandler).toBe('function')
    expect(typeof MediaMetadata).toBe('function')
    expect(session.playbackState).toBe('none')
    expect(session.metadata).toBeNull()
  })

  it('reports a playing video with its picture size and position', async () => {
    const h = install()
    const v = video({ width: 1920, height: 1080, duration: 60 })
    v.currentTime = 12
    await play(v)
    h.flush()
    const report = h.last()
    expect(report.playing).toBe(true)
    expect(report.video).toBe(true)
    expect(report.width).toBe(1920)
    expect(report.height).toBe(1080)
    expect(report.muted).toBe(false)
    expect(report.position).toEqual({ duration: 60, position: 12, playbackRate: 1 })
    expect(report.fullscreen).toBe(false)
    expect(h.sent.at(-1)).toMatchObject({ type: 'media', playing: true })
  })

  it('folds a burst of events into one report and skips unchanged ones', async () => {
    const h = install()
    const v = video()
    await play(v)
    v.dispatchEvent(new Event('volumechange'))
    v.dispatchEvent(new Event('durationchange'))
    h.flush()
    expect(h.reports()).toHaveLength(1)
    v.dispatchEvent(new Event('seeked'))
    h.flush()
    expect(h.reports()).toHaveLength(1)
  })

  it('a muted or silent element is not playing for the report', async () => {
    const h = install()
    const v = video()
    v.muted = true
    await play(v)
    h.flush()
    expect(h.last().playing).toBe(false)
    expect(h.last().muted).toBe(true)
    v.muted = false
    v.volume = 0
    v.dispatchEvent(new Event('volumechange'))
    h.flush()
    expect(h.last().playing).toBe(false)
    expect(h.last().muted).toBe(true)
  })

  it('an audio element reports no picture', async () => {
    const h = install()
    const a = audio({ duration: 200 })
    await play(a)
    h.flush()
    const report = h.last()
    expect(report.playing).toBe(true)
    expect(report.video).toBe(false)
    expect(report.width).toBe(0)
    expect(report.position?.duration).toBe(200)
  })

  it('the element that stopped hands the report to one still playing', async () => {
    const h = install()
    const a = audio()
    const v = video()
    await play(a)
    h.flush()
    await play(v)
    h.flush()
    expect(h.last().video).toBe(true)
    pause(v)
    h.flush()
    // `a` is still playing: the report follows it.
    expect(h.last().playing).toBe(true)
    expect(h.last().video).toBe(false)
  })

  it('a detached player (new Audio().play()) is listened to directly', async () => {
    const h = install()
    const a = audio({ attach: false })
    expect(a.isConnected).toBe(false)
    await play(a)
    h.flush()
    expect(h.last().playing).toBe(true)
    pause(a)
    h.flush()
    expect(h.last().playing).toBe(false)
  })

  it('pagehide sends the empty report once media was reported', async () => {
    const h = install()
    const v = video()
    await play(v)
    h.flush()
    window.dispatchEvent(new Event('pagehide'))
    expect(h.last()).toEqual(EMPTY_MEDIA_REPORT)
    expect(h.sent.at(-1)).toMatchObject({ type: 'media', playing: false })
  })

  it('pagehide with nothing reported sends nothing', () => {
    const h = install()
    window.dispatchEvent(new Event('pagehide'))
    expect(h.reports()).toHaveLength(0)
  })

  it('a fullscreen video reports fullscreen', async () => {
    const h = install()
    const v = video()
    define(document, 'fullscreenElement', v)
    await play(v)
    document.dispatchEvent(new Event('fullscreenchange'))
    h.flush()
    expect(h.last().fullscreen).toBe(true)
    define(document, 'fullscreenElement', null)
  })
})

describe('the navigator.mediaSession polyfill', () => {
  it('carries the metadata into the report with artwork resolved against the document', async () => {
    const h = install()
    const { session, MediaMetadata } = page()
    const v = video()
    await play(v)
    h.flush()
    session.metadata = new MediaMetadata({
      title: 'Song',
      artist: 'Band',
      album: 'Album',
      artwork: [{ src: '/cover.png', sizes: '512x512', type: 'image/png' }]
    })
    h.flush()
    expect(h.last().metadata).toEqual({
      title: 'Song',
      artist: 'Band',
      album: 'Album',
      artwork: [{ src: 'http://localhost:3000/cover.png', sizes: '512x512', type: 'image/png' }]
    })
  })

  it('MediaMetadata coerces its fields and validates the artwork like Chrome', () => {
    install()
    const { MediaMetadata } = page()
    const m = new MediaMetadata({ title: 42, artist: undefined, artwork: [{ src: 'a.jpg' }] })
    expect(m.title).toBe('42')
    expect(m.artist).toBe('')
    expect(m.artwork).toEqual([{ src: 'http://localhost:3000/a.jpg', sizes: '', type: '' }])
    expect(Object.isFrozen(m.artwork)).toBe(true)
    expect(() => new MediaMetadata({ artwork: 'nope' })).toThrow(TypeError)
    expect(() => new MediaMetadata({ artwork: [{ sizes: '1x1' }] })).toThrow(/required member src/)
    expect(() => new MediaMetadata({ artwork: [{ src: 'http://[bad' }] })).toThrow(
      /not a valid URL/
    )
    expect(() => new MediaMetadata(5)).toThrow(/not an object/)
    expect(new MediaMetadata().title).toBe('')
  })

  it('setting a field on the live metadata re-reports; a foreign object is refused', async () => {
    const h = install()
    const { session, MediaMetadata } = page()
    const m = new MediaMetadata({ title: 'One' })
    session.metadata = m
    h.flush()
    expect(h.last().metadata?.title).toBe('One')
    m.title = 'Two'
    h.flush()
    expect(h.last().metadata?.title).toBe('Two')
    expect(() => {
      session.metadata = { title: 'x' }
    }).toThrow(TypeError)
    session.metadata = null
    h.flush()
    expect(h.last().metadata).toBeNull()
  })

  it('playbackState accepts the enum only', () => {
    const h = install()
    const { session } = page()
    session.playbackState = 'playing'
    h.flush()
    expect(h.last().playbackState).toBe('playing')
    expect(() => {
      session.playbackState = 'stopped'
    }).toThrow(/not a valid enum value/)
    expect(session.playbackState).toBe('playing')
  })

  it('setActionHandler registers, replaces and clears handlers and reports the set', () => {
    const h = install()
    const { session } = page()
    const next = vi.fn()
    session.setActionHandler('nexttrack', next)
    session.setActionHandler('previoustrack', () => undefined)
    h.flush()
    expect(h.last().actions).toEqual(['nexttrack', 'previoustrack'])
    session.setActionHandler('previoustrack', null)
    h.flush()
    expect(h.last().actions).toEqual(['nexttrack'])
    expect(() => session.setActionHandler('rewind', next)).toThrow(/not a valid enum value/)
    expect(() => session.setActionHandler('play', 'nope')).toThrow(/not a function/)
  })

  it('a handled action reaches the page handler with the spec details', async () => {
    const h = install()
    const { session } = page()
    const v = video()
    await play(v)
    const seekto = vi.fn()
    const next = vi.fn()
    session.setActionHandler('seekto', seekto)
    session.setActionHandler('nexttrack', next)
    h.host({ action: 'seekto', seekTime: 42 })
    h.host({ action: 'nexttrack' })
    expect(seekto).toHaveBeenCalledWith({ action: 'seekto', seekTime: 42 })
    expect(next).toHaveBeenCalledWith({ action: 'nexttrack' })
    // The element itself was left alone: the page's handler owns the action.
    expect(v.currentTime).toBe(0)
  })

  it('a throwing page handler still counts as handled', async () => {
    const h = install()
    const { session } = page()
    const v = video()
    await play(v)
    session.setActionHandler('pause', () => {
      throw new Error('page bug')
    })
    expect(() => h.host({ action: 'pause' })).not.toThrow()
    expect(v.paused).toBe(false)
  })

  it('setPositionState validates and feeds the report position', async () => {
    const h = install()
    const { session } = page()
    const v = video({ duration: 100 })
    await play(v)
    session.setPositionState({ duration: 300, position: 30, playbackRate: 2 })
    h.flush()
    expect(h.last().position).toEqual({ duration: 300, position: 30, playbackRate: 2 })
    expect(() => session.setPositionState({ duration: -1 })).toThrow(/less than zero/)
    expect(() => session.setPositionState({ duration: 10, position: 11 })).toThrow(
      /greater than the duration/
    )
    expect(() => session.setPositionState({ duration: 10, playbackRate: 0 })).toThrow(
      /equal to zero/
    )
    session.setPositionState()
    h.flush()
    // Back to the element's own position.
    expect(h.last().position).toEqual({ duration: 100, position: 0, playbackRate: 1 })
  })
})

describe('the default actions (what Chrome does with actions a page left unhandled)', () => {
  it('play, pause and stop drive the active element', async () => {
    const h = install()
    const v = video()
    await play(v)
    h.host({ action: 'pause' })
    expect(v.paused).toBe(true)
    h.host({ action: 'play' })
    expect(v.paused).toBe(false)
    h.host({ action: 'stop' })
    expect(v.paused).toBe(true)
  })

  it('toggle pauses a playing element and plays a paused one, preferring page handlers', async () => {
    const h = install()
    const { session } = page()
    const v = video()
    await play(v)
    h.host({ action: 'toggle' })
    expect(v.paused).toBe(true)
    pause(v)
    h.flush()
    h.host({ action: 'toggle' })
    expect(v.paused).toBe(false)
    const pauseHandler = vi.fn()
    session.setActionHandler('pause', pauseHandler)
    h.host({ action: 'toggle' })
    expect(pauseHandler).toHaveBeenCalledWith({ action: 'pause' })
    expect(v.paused).toBe(false)
  })

  it('seeking uses the given offset or the 10 s default, clamped to the duration', async () => {
    const h = install()
    const v = video({ duration: 100 })
    v.currentTime = 50
    await play(v)
    h.host({ action: 'seekforward' })
    expect(v.currentTime).toBe(50 + DEFAULT_SEEK_OFFSET_S)
    h.host({ action: 'seekbackward', seekOffset: 5 })
    expect(v.currentTime).toBe(50 + DEFAULT_SEEK_OFFSET_S - 5)
    h.host({ action: 'seekto', seekTime: 30 })
    expect(v.currentTime).toBe(30)
    h.host({ action: 'seekto', seekTime: 500 })
    expect(v.currentTime).toBe(100)
    h.host({ action: 'seekbackward', seekOffset: 1000 })
    expect(v.currentTime).toBe(0)
  })

  it('ducking lowers the volume while another app speaks and restores it after', async () => {
    const h = install()
    const v = video()
    v.volume = 0.8
    await play(v)
    h.host({ action: 'duck', on: true })
    expect(v.volume).toBe(DUCK_VOLUME)
    h.host({ action: 'duck', on: true })
    expect(v.volume).toBe(DUCK_VOLUME)
    h.host({ action: 'duck', on: false })
    expect(v.volume).toBe(0.8)
    h.host({ action: 'duck', on: false })
    expect(v.volume).toBe(0.8)
  })

  it('a quiet element is not turned up by ducking', async () => {
    const h = install()
    const v = video()
    v.volume = 0.1
    await play(v)
    h.host({ action: 'duck', on: true })
    expect(v.volume).toBe(0.1)
    h.host({ action: 'duck', on: false })
    expect(v.volume).toBe(0.1)
  })

  it('fill lays the video over the viewport and off puts the page back', async () => {
    const h = install()
    const v = video()
    await play(v)
    h.host({ action: 'fill', on: true })
    expect(v.hasAttribute(PIP_FILL_ATTRIBUTE)).toBe(true)
    const style = document.getElementById(PIP_FILL_ATTRIBUTE)
    expect(style?.tagName.toLowerCase()).toBe('style')
    expect(style?.textContent).toContain('position:fixed')
    expect(style?.textContent).toContain(`[${PIP_FILL_ATTRIBUTE}]`)
    h.host({ action: 'fill', on: false })
    expect(v.hasAttribute(PIP_FILL_ATTRIBUTE)).toBe(false)
    expect(document.getElementById(PIP_FILL_ATTRIBUTE)).toBeNull()
  })

  it('fill ignores an audio element', async () => {
    const h = install()
    const a = audio()
    await play(a)
    h.host({ action: 'fill', on: true })
    expect(a.hasAttribute(PIP_FILL_ATTRIBUTE)).toBe(false)
    expect(document.getElementById(PIP_FILL_ATTRIBUTE)).toBeNull()
  })

  it('an action with no media in the page does nothing', () => {
    const h = install()
    expect(() => h.host({ action: 'pause' })).not.toThrow()
    expect(() => h.host({ action: 'toggle' })).not.toThrow()
    expect(() => h.host({ action: 'fill', on: true })).not.toThrow()
  })

  it('a paused element still takes actions before any play was seen', () => {
    const h = install()
    const v = video()
    v.currentTime = 20
    h.host({ action: 'seekforward' })
    expect(v.currentTime).toBe(20 + DEFAULT_SEEK_OFFSET_S)
  })
})

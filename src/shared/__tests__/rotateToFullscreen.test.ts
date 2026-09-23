// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installRotateToFullscreen,
  MIN_VIDEO_SIZE,
  rotateDecision,
  screenOrientationOf,
  videoOrientationOf,
  VISIBILITY_THRESHOLD,
  type RotateVideo
} from '../rotateToFullscreen'

/*
 * Rotate-to-fullscreen (MED-02), Chrome's rule in the page's script: a playing video with the
 * native controls goes fullscreen as the screen turns to its orientation, the fullscreen video
 * leaves as the screen turns away; never a paused video, a player with its own controls, one that
 * bars fullscreen, one in picture-in-picture, one out of view, a thumbnail, or a flip of 180°.
 * The request is made inside `screen.orientation`'s `change` event – the one dispatch Blink lets
 * a page ask for fullscreen in without a touch.
 */

const landscape: RotateVideo = {
  playing: true,
  controls: true,
  fullscreenBlocked: false,
  pictureInPicture: false,
  visible: true,
  width: 1280,
  height: 720
}

describe('what the screen and a video say', () => {
  it('reads the screen off screen.orientation.type', () => {
    expect(screenOrientationOf('portrait-primary')).toBe('portrait')
    expect(screenOrientationOf('portrait-secondary')).toBe('portrait')
    expect(screenOrientationOf('landscape-primary')).toBe('landscape')
    expect(screenOrientationOf('landscape-secondary')).toBe('landscape')
    expect(screenOrientationOf(undefined)).toBe('unknown')
    expect(screenOrientationOf('')).toBe('unknown')
  })

  it('reads a video off its natural size: as wide as tall is landscape, a thumbnail is nothing', () => {
    expect(videoOrientationOf(1920, 1080)).toBe('landscape')
    expect(videoOrientationOf(720, 720)).toBe('landscape')
    expect(videoOrientationOf(1080, 1920)).toBe('portrait')
    expect(videoOrientationOf(0, 0)).toBe('unknown')
    expect(videoOrientationOf(1280, 0)).toBe('unknown')
    expect(videoOrientationOf(MIN_VIDEO_SIZE - 1, MIN_VIDEO_SIZE - 1)).toBe('unknown')
    // Small one way only is still a player (a 320 x 180 clip).
    expect(videoOrientationOf(320, 180)).toBe('landscape')
    expect(MIN_VIDEO_SIZE).toBe(200)
    expect(VISIBILITY_THRESHOLD).toBe(0.75)
  })
})

describe('the decision at a turn of the screen', () => {
  it('takes a playing, visible, natively controlled video fullscreen as the screen turns to its orientation', () => {
    expect(rotateDecision(landscape, 'portrait', 'landscape', 'none')).toBe('enter')
    const portrait = { ...landscape, width: 720, height: 1280 }
    expect(rotateDecision(portrait, 'landscape', 'portrait', 'none')).toBe('enter')
  })

  it('never a paused video, a player with its own controls, one barring fullscreen, one in picture-in-picture, or one out of view', () => {
    expect(rotateDecision({ ...landscape, playing: false }, 'portrait', 'landscape', 'none')).toBe(
      'stay'
    )
    expect(rotateDecision({ ...landscape, controls: false }, 'portrait', 'landscape', 'none')).toBe(
      'stay'
    )
    expect(
      rotateDecision({ ...landscape, fullscreenBlocked: true }, 'portrait', 'landscape', 'none')
    ).toBe('stay')
    expect(
      rotateDecision({ ...landscape, pictureInPicture: true }, 'portrait', 'landscape', 'none')
    ).toBe('stay')
    expect(rotateDecision({ ...landscape, visible: false }, 'portrait', 'landscape', 'none')).toBe(
      'stay'
    )
  })

  it('never a thumbnail or a video without a size, and never while something else is fullscreen', () => {
    expect(
      rotateDecision({ ...landscape, width: 0, height: 0 }, 'portrait', 'landscape', 'none')
    ).toBe('stay')
    expect(
      rotateDecision({ ...landscape, width: 160, height: 90 }, 'portrait', 'landscape', 'none')
    ).toBe('stay')
    expect(rotateDecision(landscape, 'portrait', 'landscape', 'other')).toBe('stay')
    expect(rotateDecision(landscape, 'portrait', 'landscape', 'this')).toBe('stay')
  })

  it('a turn to the other orientation is no turn to the video’s: a portrait video stays inline as the screen goes landscape', () => {
    const portrait = { ...landscape, width: 720, height: 1280 }
    expect(rotateDecision(portrait, 'portrait', 'landscape', 'none')).toBe('stay')
  })

  it('leaves the fullscreen video as the screen turns away from its orientation, playing or paused', () => {
    expect(rotateDecision(landscape, 'landscape', 'portrait', 'this')).toBe('exit')
    expect(rotateDecision({ ...landscape, playing: false }, 'landscape', 'portrait', 'this')).toBe(
      'exit'
    )
    // A video kept fullscreen by a player's wrapper is the player's.
    expect(rotateDecision(landscape, 'landscape', 'portrait', 'other')).toBe('stay')
    expect(rotateDecision(landscape, 'landscape', 'portrait', 'none')).toBe('stay')
    // A portrait fullscreen video leaves as the screen goes landscape.
    const portrait = { ...landscape, width: 720, height: 1280 }
    expect(rotateDecision(portrait, 'portrait', 'landscape', 'this')).toBe('exit')
  })

  it('a 180° flip, or a screen that says nothing, does nothing either way', () => {
    expect(rotateDecision(landscape, 'landscape', 'landscape', 'none')).toBe('stay')
    expect(rotateDecision(landscape, 'landscape', 'landscape', 'this')).toBe('stay')
    expect(rotateDecision(landscape, 'unknown', 'landscape', 'none')).toBe('stay')
    expect(rotateDecision(landscape, 'portrait', 'unknown', 'this')).toBe('stay')
  })
})

describe('in the document', () => {
  type Observed = { target: Element; ratio: number }
  let orientation: EventTarget & { type: string }
  let observed: Element[]
  let report: ((entries: Observed[]) => void) | null
  const requested: HTMLVideoElement[] = []
  const exits = vi.fn(async () => undefined)

  function video(width: number, height: number, controls = true): HTMLVideoElement {
    const v = document.createElement('video')
    if (controls) v.setAttribute('controls', '')
    Object.defineProperty(v, 'videoWidth', { value: width, configurable: true })
    Object.defineProperty(v, 'videoHeight', { value: height, configurable: true })
    let paused = true
    Object.defineProperty(v, 'paused', { get: () => paused, configurable: true })
    Object.defineProperty(v, 'ended', { value: false, configurable: true })
    Object.defineProperty(v, 'requestFullscreen', {
      value: () => {
        requested.push(v)
        return Promise.resolve()
      },
      configurable: true
    })
    Object.assign(v, {
      __play: () => {
        paused = false
        v.dispatchEvent(new Event('play'))
      },
      __pause: () => {
        paused = true
        v.dispatchEvent(new Event('pause'))
      }
    })
    document.body.appendChild(v)
    return v
  }
  const play = (v: HTMLVideoElement): void => (v as unknown as { __play: () => void }).__play()
  const pause = (v: HTMLVideoElement): void => (v as unknown as { __pause: () => void }).__pause()

  function turn(type: string): void {
    orientation.type = type
    orientation.dispatchEvent(new Event('change'))
  }

  function fullscreen(element: Element | null): void {
    Object.defineProperty(document, 'fullscreenElement', { value: element, configurable: true })
  }

  /** The videos under watch (every install in this document keeps its own observer; one word for all). */
  const watched = (): Element[] => [...new Set(observed)]

  /** The observer's word on a video: in view by `ratio`. */
  function seen(target: Element, ratio: number): void {
    report?.([{ target, ratio }])
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    requested.length = 0
    exits.mockClear()
    observed = []
    report = null
    orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' })
    Object.defineProperty(window, 'screen', {
      value: { orientation },
      configurable: true
    })
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Observed[]) => void) {
          report = (entries) =>
            cb(
              entries.map((e) => ({
                target: e.target,
                intersectionRatio: e.ratio,
                isIntersecting: e.ratio > 0
              })) as unknown as Observed[]
            )
        }
        observe(el: Element): void {
          observed.push(el)
        }
        unobserve(el: Element): void {
          observed = observed.filter((o) => o !== el)
        }
      }
    )
    Object.defineProperty(document, 'exitFullscreen', { value: exits, configurable: true })
    fullscreen(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows playing videos alone, asks for fullscreen inside the turn for the one in view, and leaves at the turn back', () => {
    installRotateToFullscreen(window)
    const v = video(1280, 720)
    expect(watched()).toEqual([])
    play(v)
    expect(watched()).toEqual([v])
    seen(v, 1)
    turn('landscape-primary')
    expect(requested).toEqual([v])
    // The engine put it fullscreen; the screen turns back: the way out, paused or not.
    fullscreen(v)
    pause(v)
    turn('portrait-primary')
    expect(exits).toHaveBeenCalledTimes(1)
  })

  it('a paused video, one out of view, or one with its own controls stays inline', () => {
    installRotateToFullscreen(window)
    const paused = video(1280, 720)
    const hidden = video(1280, 720)
    const custom = video(1280, 720, false)
    play(hidden)
    play(custom)
    seen(hidden, 0.4)
    seen(custom, 1)
    turn('landscape-primary')
    expect(requested).toEqual([])
    expect(paused.paused).toBe(true)
    // The hidden one scrolled into view: the next turn takes it.
    seen(hidden, 0.9)
    turn('portrait-primary')
    turn('landscape-primary')
    expect(requested).toEqual([hidden])
  })

  it('a video playing before the script came is followed from the start', () => {
    const v = video(1280, 720)
    play(v)
    installRotateToFullscreen(window)
    expect(watched()).toEqual([v])
  })

  it('a pause drops the video from the watch; a wrapper’s fullscreen is left to the player', () => {
    installRotateToFullscreen(window)
    const v = video(1280, 720)
    play(v)
    seen(v, 1)
    pause(v)
    expect(watched()).toEqual([])
    turn('landscape-primary')
    expect(requested).toEqual([])
    const wrapper = document.createElement('div')
    wrapper.appendChild(v)
    document.body.appendChild(wrapper)
    fullscreen(wrapper)
    turn('portrait-primary')
    expect(exits).not.toHaveBeenCalled()
  })

  it('does nothing without a screen.orientation that speaks', () => {
    Object.defineProperty(window, 'screen', { value: {}, configurable: true })
    expect(() => installRotateToFullscreen(window)).not.toThrow()
  })
})

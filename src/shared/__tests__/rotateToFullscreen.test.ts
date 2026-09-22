// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROTATE_ARM_TIMEOUT_MS,
  installRotateToFullscreen,
  rotateCandidate,
  rotateEligible,
  rotateManaged,
  videoLandscape,
  visibleFraction
} from '../rotateToFullscreen'
import { installActivationReporter, type PageScriptMessage } from '../pageScript'

const VIEWPORT = { width: 800, height: 400 }

function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true, configurable: true })
  return e
}

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true })
}

/** A `<video>` as the page has it playing in view: the properties happy-dom's video leaves at rest. */
function playingVideo(
  width = 1920,
  height = 1080,
  rect = { left: 0, top: 0, right: 800, bottom: 400 }
): HTMLVideoElement {
  const v = document.createElement('video')
  v.setAttribute('controls', '')
  define(v, 'videoWidth', width)
  define(v, 'videoHeight', height)
  define(v, 'paused', false)
  define(v, 'readyState', 4)
  define(v, 'getBoundingClientRect', () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top
  }))
  document.body.appendChild(v)
  return v
}

function setViewport(width: number, height: number): void {
  define(window, 'innerWidth', width)
  define(window, 'innerHeight', height)
}

function fullscreenElement(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { value: element, configurable: true })
}

beforeEach(() => {
  document.body.innerHTML = ''
  fullscreenElement(null)
  define(document, 'hidden', false)
  setViewport(VIEWPORT.width, VIEWPORT.height)
})

describe("the video's orientation and its share of the viewport", () => {
  it("is Chrome's: landscape when at least as wide as tall, squares included; too small or unknown is nothing", () => {
    expect(videoLandscape(1920, 1080)).toBe(true)
    expect(videoLandscape(1080, 1920)).toBe(false)
    expect(videoLandscape(500, 500)).toBe(true)
    expect(videoLandscape(199, 1080)).toBeNull()
    expect(videoLandscape(1080, 199)).toBeNull()
    expect(videoLandscape(0, 0)).toBeNull()
  })

  it('measures the share of a box inside the viewport', () => {
    expect(visibleFraction({ left: 0, top: 0, right: 800, bottom: 400 }, 800, 400)).toBe(1)
    expect(visibleFraction({ left: 0, top: 200, right: 800, bottom: 600 }, 800, 400)).toBe(0.5)
    expect(visibleFraction({ left: -400, top: 0, right: 400, bottom: 400 }, 800, 400)).toBe(0.5)
    expect(visibleFraction({ left: 0, top: 500, right: 800, bottom: 900 }, 800, 400)).toBe(0)
    expect(visibleFraction({ left: 10, top: 10, right: 10, bottom: 10 }, 800, 400)).toBe(0)
  })
})

describe('rotateManaged: the fullscreen element a turn of the screen leaves', () => {
  it("is a <video> itself, controls or not, but not a player's wrapper nor one hiding fullscreen", () => {
    const bare = document.createElement('video')
    expect(rotateManaged(bare)).toBe(true)
    const wrapper = document.createElement('div')
    wrapper.appendChild(document.createElement('video'))
    expect(rotateManaged(wrapper)).toBe(false)
    expect(rotateManaged(document.createElement('canvas'))).toBe(false)
    const noFullscreen = document.createElement('video')
    define(noFullscreen, 'controlsList', { contains: (token: string) => token === 'nofullscreen' })
    expect(rotateManaged(noFullscreen)).toBe(false)
  })
})

describe("rotateCandidate: the video a turn takes fullscreen (Chrome's conditions)", () => {
  it('takes a controlled video playing in view whose orientation the screen turned to', () => {
    const v = playingVideo()
    expect(rotateEligible(v, true, VIEWPORT)).toBe(true)
    expect(rotateCandidate(document, true, VIEWPORT)).toBe(v)
    // A turn to portrait is not this video's.
    expect(rotateCandidate(document, false, VIEWPORT)).toBeNull()
  })

  it("takes a portrait video on the turn to portrait, and never a small one's", () => {
    const portrait = playingVideo(1080, 1920)
    expect(rotateCandidate(document, false, VIEWPORT)).toBe(portrait)
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
    document.body.innerHTML = ''
    playingVideo(320, 180)
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
  })

  it("leaves a paused video, one before its metadata, one without the browser's controls or hiding fullscreen", () => {
    const paused = playingVideo()
    define(paused, 'paused', true)
    expect(rotateEligible(paused, true, VIEWPORT)).toBe(false)
    const nothing = playingVideo()
    define(nothing, 'readyState', 0)
    expect(rotateEligible(nothing, true, VIEWPORT)).toBe(false)
    const custom = playingVideo()
    custom.removeAttribute('controls')
    expect(rotateEligible(custom, true, VIEWPORT)).toBe(false)
    const noFullscreen = playingVideo()
    define(noFullscreen, 'controlsList', { contains: (token: string) => token === 'nofullscreen' })
    expect(rotateEligible(noFullscreen, true, VIEWPORT)).toBe(false)
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
  })

  it('wants three quarters of the video in the viewport', () => {
    const mostly = playingVideo(1920, 1080, { left: 0, top: 100, right: 800, bottom: 500 })
    expect(rotateEligible(mostly, true, VIEWPORT)).toBe(true)
    const half = playingVideo(1920, 1080, { left: 0, top: 200, right: 800, bottom: 600 })
    expect(rotateEligible(half, true, VIEWPORT)).toBe(false)
  })

  it('leaves a video in picture-in-picture, a document with a fullscreen element, a hidden one and one that may not go fullscreen', () => {
    const v = playingVideo()
    define(document, 'pictureInPictureElement', v)
    expect(rotateEligible(v, true, VIEWPORT)).toBe(false)
    define(document, 'pictureInPictureElement', null)
    expect(rotateCandidate(document, true, VIEWPORT)).toBe(v)
    fullscreenElement(document.createElement('div'))
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
    fullscreenElement(null)
    define(document, 'hidden', true)
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
    define(document, 'hidden', false)
    define(document, 'fullscreenEnabled', false)
    expect(rotateCandidate(document, true, VIEWPORT)).toBeNull()
    define(document, 'fullscreenEnabled', true)
    expect(rotateCandidate(document, true, VIEWPORT)).toBe(v)
  })
})

describe("installRotateToFullscreen: the host's ask, the arm and the key", () => {
  let sent: PageScriptMessage[]
  let turned: ((landscape: boolean) => void) | null

  function install(): void {
    sent = []
    turned = null
    installRotateToFullscreen({
      send: (m) => {
        sent.push(m)
      },
      onRotateFullscreen: (listener) => {
        turned = listener
      }
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it("arms for a playing video and takes the host's key for its requestFullscreen, before the activation reporter", async () => {
    install()
    // The reporter installed after (installPageScript's order): the key is not the user's.
    installActivationReporter({
      send: (m) => {
        sent.push(m)
      }
    })
    const v = playingVideo()
    const requested: string[] = []
    define(v, 'requestFullscreen', () => {
      requested.push(v.tagName)
      return Promise.resolve()
    })
    turned!(true)
    expect(sent).toEqual([{ type: 'rotateFullscreen', armed: true }])
    // A page's own script-made key earns nothing.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified' }))
    expect(requested).toEqual([])
    const down = trusted(new KeyboardEvent('keydown', { key: 'Unidentified', cancelable: true }))
    window.dispatchEvent(down)
    expect(requested).toEqual(['VIDEO'])
    expect(down.defaultPrevented).toBe(true)
    const up = trusted(new KeyboardEvent('keyup', { key: 'Unidentified', cancelable: true }))
    window.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(sent).toEqual([
      { type: 'rotateFullscreen', armed: true },
      { type: 'rotateFullscreen', result: 'entered' }
    ])
    // The key was taken once: a second trusted key is the user's again, and the reporter's.
    window.dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'a' })))
    expect(requested).toEqual(['VIDEO'])
    expect(sent[2]).toEqual({ type: 'activation' })
  })

  it('reports a request the engine refused, and arms for nothing without a video to take', async () => {
    install()
    const v = playingVideo()
    define(v, 'requestFullscreen', () => Promise.reject(new TypeError('no activation')))
    turned!(true)
    window.dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Unidentified' })))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent[1]).toEqual({ type: 'rotateFullscreen', result: 'failed' })
    document.body.innerHTML = ''
    sent.length = 0
    turned!(true)
    expect(sent).toEqual([])
  })

  it("disarms when the host's key never comes", () => {
    vi.useFakeTimers()
    install()
    const v = playingVideo()
    const requested: string[] = []
    define(v, 'requestFullscreen', () => {
      requested.push(v.tagName)
      return Promise.resolve()
    })
    turned!(true)
    vi.advanceTimersByTime(ROTATE_ARM_TIMEOUT_MS + 1)
    window.dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Unidentified' })))
    expect(requested).toEqual([])
  })

  it("judges once the viewport has taken the screen's new orientation", async () => {
    install()
    const v = playingVideo()
    define(v, 'requestFullscreen', () => Promise.resolve())
    // The host's word comes before the page's layout: still the portrait viewport.
    setViewport(400, 800)
    turned!(true)
    expect(sent).toEqual([])
    setViewport(800, 400)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(sent).toEqual([{ type: 'rotateFullscreen', armed: true }])
  })
})

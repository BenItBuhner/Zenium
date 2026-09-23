// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Rotate-to-fullscreen is the phone's alone (MED-02; design language v2 §9.36, Chrome's
 * `device_is_phone`): the Android page script switches its half of the rule on by the host's
 * word at document start (`window.__zenRotateToFullscreen`, `PageHost.rotateToFullscreen` –
 * the window under Android's 600 dp tablet line, the same class the tablet layout is picked on),
 * and a host that says nothing turns nothing. The script is an IIFE that installs on import, so
 * each word is a fresh evaluation of the module (`vi.resetModules`), as each document's is in
 * the WebView; apart from `pageScript.test.ts` for that reason.
 */

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Preamble = Window & {
  __zenPageBridge?: Bridge
  __zenPageInstalled?: boolean
  __zenRotateToFullscreen?: boolean
}

const w = window as unknown as Preamble
const requested: HTMLVideoElement[] = []
let orientation: EventTarget & { type: string }
/** The last observer the script built, told what it sees (the shared test drives the ratio itself). */
let report: ((target: Element, ratio: number) => void) | null = null
/** The videos the script's observer follows: the playing ones, in a phone's window alone. */
let watched: Element[] = []

/** A landscape video with the native controls, playing and wholly in view: what the turn takes fullscreen. */
function playingVideo(): HTMLVideoElement {
  const v = document.createElement('video')
  v.setAttribute('controls', '')
  Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true })
  Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true })
  Object.defineProperty(v, 'paused', { value: false, configurable: true })
  Object.defineProperty(v, 'ended', { value: false, configurable: true })
  Object.defineProperty(v, 'requestFullscreen', {
    value: () => {
      requested.push(v)
      return Promise.resolve()
    },
    configurable: true
  })
  document.body.appendChild(v)
  v.dispatchEvent(new Event('play'))
  report?.(v, 1)
  return v
}

/** The screen turns to landscape (`screen.orientation`'s `change`). */
function turnToLandscape(): void {
  orientation.type = 'landscape-primary'
  orientation.dispatchEvent(new Event('change'))
}

/** Kotlin's document-start preamble with the host's word, then the script. */
async function evaluateScript(word: boolean | undefined): Promise<void> {
  vi.resetModules()
  delete w.__zenPageInstalled
  w.__zenPageBridge = { postMessage: () => undefined, onmessage: null }
  if (word === undefined) delete w.__zenRotateToFullscreen
  else w.__zenRotateToFullscreen = word
  await import('../pageScript')
}

beforeEach(() => {
  requested.length = 0
  report = null
  watched = []
  orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' })
  Object.defineProperty(window.screen, 'orientation', { value: orientation, configurable: true })
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
  // Each evaluation of the script builds its own observer (and leaves its `play` listener on the
  // document behind); `report` and `watched` are the latest one's, so an earlier evaluation's
  // following of a later test's video is not read as this test's.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly following: Element[] = []
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
        report = (target, ratio) =>
          cb([
            { target, intersectionRatio: ratio, isIntersecting: ratio > 0 }
          ] as unknown as IntersectionObserverEntry[])
        watched = this.following
      }
      observe(el: Element): void {
        this.following.push(el)
      }
      unobserve(el: Element): void {
        const at = this.following.indexOf(el)
        if (at >= 0) this.following.splice(at, 1)
      }
    }
  )
})

afterEach(() => {
  // The script's media tracking (`installMediaTracking`) answers the `play` above with a report on
  // a 40 ms timer. The file's last test can end inside that window, and the timer then runs against
  // a document vitest has already taken down (`HTMLVideoElement is not defined`, an unhandled error
  // that fails the whole run: CI run 35841597547 on #383, whose one change was a Kotlin file).
  // `pagehide` is the script's own end of a page: every evaluation's listener clears its report.
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the Android page script and rotate-to-fullscreen’s form-factor gate (MED-02, §9.36)', () => {
  it('in a phone’s window (the host’s word true) the turn takes the playing video fullscreen', async () => {
    await evaluateScript(true)
    const video = playingVideo()
    expect(watched).toEqual([video])
    turnToLandscape()
    expect(requested).toEqual([video])
  })

  it('in a tablet’s window (the host’s word false) the same turn leaves the video inline', async () => {
    await evaluateScript(false)
    playingVideo()
    // The rule is not installed at all: no video is followed, no turn is heard.
    expect(watched).toEqual([])
    turnToLandscape()
    expect(requested).toEqual([])
  })

  it('a host that says nothing turns nothing, and no word is left on the page', async () => {
    await evaluateScript(undefined)
    playingVideo()
    turnToLandscape()
    expect(requested).toEqual([])
    await evaluateScript(true)
    expect(w.__zenRotateToFullscreen).toBeUndefined()
  })
})

/**
 * Rotate-to-fullscreen's page side (MED-02), Chrome for Android's rule to the degree
 * (`MediaControlsRotateToFullscreenDelegate`): a `<video>` with the browser's own controls,
 * playing in view, goes fullscreen when the screen turns to the video's orientation. The host
 * sees the screen turn (`Host.onScreenOrientationChanged`) and asks the page; the page judges
 * its videos once its viewport has taken the new orientation, arms itself and answers; the host
 * answers with a press of no key – the engine counts a key down as the user's activation, which
 * `requestFullscreen()` needs, as Chrome's own delegate grants one – which the listener here
 * takes before the page sees it, and the video's `requestFullscreen()` runs in it. The way back
 * (turning away exits, paused or not) is the host's alone, from the `fullscreen` report's
 * `rotate` (`rotateManaged`).
 */
import type { PageScriptMessage } from './pageScript'

/** A video smaller than this either way is not one to turn the screen for (Chrome's `kMinVideoSize`). */
export const ROTATE_MIN_VIDEO_SIZE = 200
/** How much of the video must be in the viewport for a turn to take it fullscreen (Chrome's intersection threshold). */
export const ROTATE_VISIBLE_FRACTION = 0.75
/** How long the page waits for its viewport to take the screen's new orientation before it judges. */
export const ROTATE_LAYOUT_WAIT_MS = 1000
/** How long the armed page waits for the host's key. */
export const ROTATE_ARM_TIMEOUT_MS = 1500

export interface RotateViewport {
  width: number
  height: number
}

export interface RotateTransport {
  send(message: PageScriptMessage): void
  /** The host's word that the screen turned, to `landscape` or from it. */
  onRotateFullscreen(listener: (landscape: boolean) => void): void
}

/**
 * The video's orientation by its natural size, as Chrome has it: landscape when at least as
 * wide as tall (a square one included), portrait otherwise; null for one too small or with no
 * size known, which rotate-to-fullscreen leaves alone.
 */
export function videoLandscape(width: number, height: number): boolean | null {
  if (width < ROTATE_MIN_VIDEO_SIZE || height < ROTATE_MIN_VIDEO_SIZE) return null
  return width >= height
}

/** The share of a box inside the viewport, 0..1 (an empty box shows nothing). */
export function visibleFraction(
  rect: { left: number; top: number; right: number; bottom: number },
  viewportWidth: number,
  viewportHeight: number
): number {
  const area = (rect.right - rect.left) * (rect.bottom - rect.top)
  if (area <= 0) return 0
  const width = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
  const height = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
  if (width <= 0 || height <= 0) return 0
  return (width * height) / area
}

function hidesFullscreen(video: HTMLVideoElement): boolean {
  const list = (video as HTMLVideoElement & { controlsList?: DOMTokenList }).controlsList
  return list?.contains('nofullscreen') ?? false
}

/**
 * Whether a fullscreen element is a `<video>` of the browser's own – the element itself, not a
 * player's wrapper around one, and without `controlslist="nofullscreen"`: the kind whose
 * fullscreen Chrome's media controls manage (a fullscreen video shows them, `controls` or not),
 * so that turning the screen away exits and the screen's lock gives way to the device's turn.
 * The `fullscreen` report's `rotate`.
 */
export function rotateManaged(element: Element): boolean {
  if (typeof HTMLVideoElement === 'undefined' || !(element instanceof HTMLVideoElement))
    return false
  return !hidesFullscreen(element)
}

function fullscreenElementOf(doc: Document): Element | null {
  return (
    doc.fullscreenElement ??
    (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
    null
  )
}

/**
 * Whether a turn of the screen to `landscape` takes this video fullscreen: the browser's
 * controls (`controls`, without `nofullscreen`), playing, its size known and not too small, of
 * the screen's new orientation, at least three quarters in the viewport, and not in
 * picture-in-picture – Chrome's conditions, each.
 */
export function rotateEligible(
  video: HTMLVideoElement,
  landscape: boolean,
  viewport: RotateViewport,
  doc: Document = video.ownerDocument
): boolean {
  if (!video.controls || hidesFullscreen(video)) return false
  if (video.paused) return false
  if (video.readyState === 0) return false
  if (videoLandscape(video.videoWidth, video.videoHeight) !== landscape) return false
  const pip = (doc as Document & { pictureInPictureElement?: Element | null })
    .pictureInPictureElement
  if (pip === video) return false
  return (
    visibleFraction(video.getBoundingClientRect(), viewport.width, viewport.height) >=
    ROTATE_VISIBLE_FRACTION
  )
}

/**
 * The first `<video>` in the document a turn to `landscape` takes fullscreen, or null: none
 * while the document is hidden, has a fullscreen element already (Chrome leaves another
 * element's fullscreen alone) or may not go fullscreen at all.
 */
export function rotateCandidate(
  doc: Document,
  landscape: boolean,
  viewport: RotateViewport
): HTMLVideoElement | null {
  if (typeof HTMLVideoElement === 'undefined') return null
  if (doc.hidden || fullscreenElementOf(doc) || doc.fullscreenEnabled === false) return null
  for (const video of doc.querySelectorAll('video')) {
    if (video instanceof HTMLVideoElement && rotateEligible(video, landscape, viewport, doc))
      return video
  }
  return null
}

/**
 * Answers the host's asks. The viewport takes the screen's new orientation a layout or two
 * after the host's word, so the page judges once it has (its `resize`), or at
 * `ROTATE_LAYOUT_WAIT_MS` in the viewport it has – Chrome judges on the visibility it last
 * observed, which is the old layout's – and with a video to take arms itself for the key: the
 * next trusted `keydown` – the host's press of no key – is stopped before any other listener
 * (this one is installed ahead of the activation reporter's, so the pop-up blocker never
 * counts it) and the video's `requestFullscreen()` runs in it, its outcome reported (`result`).
 */
export function installRotateToFullscreen(transport: RotateTransport): void {
  let armed: HTMLVideoElement | null = null
  let armTimer: ReturnType<typeof setTimeout> | null = null
  let stopWaiting: (() => void) | null = null
  let swallowKeyUp = false

  const disarm = (): void => {
    armed = null
    if (armTimer !== null) {
      clearTimeout(armTimer)
      armTimer = null
    }
  }

  const settle = (result: 'entered' | 'failed'): void =>
    transport.send({ type: 'rotateFullscreen', result })

  const request = (video: HTMLVideoElement): void => {
    try {
      const outcome = video.requestFullscreen() as Promise<void> | undefined
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(
          () => settle('entered'),
          () => settle('failed')
        )
      } else {
        settle('entered')
      }
    } catch {
      settle('failed')
    }
  }

  window.addEventListener(
    'keydown',
    (e) => {
      const video = armed
      if (!video || !e.isTrusted) return
      disarm()
      e.stopImmediatePropagation()
      e.preventDefault()
      swallowKeyUp = true
      request(video)
    },
    true
  )
  window.addEventListener(
    'keyup',
    (e) => {
      if (!swallowKeyUp || !e.isTrusted) return
      swallowKeyUp = false
      e.stopImmediatePropagation()
      e.preventDefault()
    },
    true
  )

  const viewportTurned = (landscape: boolean): boolean =>
    window.innerWidth > window.innerHeight === landscape

  transport.onRotateFullscreen((landscape) => {
    disarm()
    stopWaiting?.()
    stopWaiting = null
    const judge = (): void => {
      stopWaiting?.()
      stopWaiting = null
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const video = rotateCandidate(document, landscape, viewport)
      if (!video) return
      armed = video
      armTimer = setTimeout(disarm, ROTATE_ARM_TIMEOUT_MS)
      transport.send({ type: 'rotateFullscreen', armed: true })
    }
    if (viewportTurned(landscape)) {
      judge()
      return
    }
    const onResize = (): void => {
      if (viewportTurned(landscape)) judge()
    }
    window.addEventListener('resize', onResize)
    const deadline = setTimeout(judge, ROTATE_LAYOUT_WAIT_MS)
    stopWaiting = () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(deadline)
    }
  })
}

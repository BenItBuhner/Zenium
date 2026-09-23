/**
 * Rotate-to-fullscreen (MED-02): a video playing inline goes fullscreen when the device turns to
 * its orientation, and a fullscreen video leaves when the device turns away from it – Chrome for
 * Android's rule (its `MediaControlsRotateToFullscreenDelegate`), run here in the page's own
 * script because of where Blink lets a page ask: `requestFullscreen()` needs a user activation
 * save inside the dispatch of `screen.orientation`'s `change` event, the one allowance Blink
 * makes for exactly this (its `ScopedAllowFullscreen::kOrientationChange`). A message from the
 * host, handled later, has no such standing: the request is made synchronously in the handler.
 *
 * The screen's turn is what is heard, not the sensor's: with the device's rotation locked the
 * screen does not turn and nothing here runs, as in Chrome. A 180° flip (landscape to the other
 * landscape) is no turn. The way in takes a video that
 *  - is playing (never a paused or ended one: a turn while paused is the page's business),
 *  - shows the native controls (`controls`; a player with its own controls handles fullscreen
 *    itself, YouTube's way) and does not list `nofullscreen` in `controlslist`,
 *  - is not in picture-in-picture,
 *  - is in view – three quarters of it at least, by the intersection observer that follows each
 *    playing video – while nothing else is fullscreen,
 *  - has a known natural size, not a thumbnail's (under `MIN_VIDEO_SIZE` both ways), that is the
 *    screen's new orientation: as wide as tall or wider is landscape, taller is portrait.
 * The way out takes the video that is the fullscreen element, playing or paused: the fullscreen
 * is a state of the screen the turn away ends. A wrapper's fullscreen (a player around its video)
 * is left to the player.
 *
 * The host keeps its half of Chrome's rule (`FullscreenRotation.kt`): the screen a landscape
 * video's fullscreen turned is held there until the device has itself turned to landscape, then
 * follows the device again, so the turn back is a turn of the screen that this exits on.
 *
 * Blink's own delegate runs in a phone's WebView too (content turns
 * `video_rotate_to_fullscreen_enabled` on for the phone form factor, and nothing in the WebView
 * layer turns it off), so on a phone that reports device orientation there are two requesters
 * per turn – Blink's and this script's, the same gates, the same `change` event. They are
 * idempotent: a second `requestFullscreen()` on the video already fullscreen is a no-op, and the
 * two exits are one `exitFullscreen()`; one transition either way. This script stays because
 * Blink's delegate is gated on the `deviceorientation` sensor as well, which a device without
 * one (the recipe's emulator among them) never satisfies, and because the decision is then
 * readable and testable here. Chrome runs neither on a tablet (`device_is_phone`), and nor does
 * this: the rule is the phone's alone (design language v2 §9.36 – a phone turned on its side with
 * a video playing has one plausible intent, a tablet turned has many; the tablet keeps its layout
 * through the turn and its video goes fullscreen by the player's own control). The host says
 * which the screen is at document start (`PageHost.rotateToFullscreen`: under 600 dp on the short
 * side of `smallestScreenWidthDp` – the display's through split screen, as Chrome's own `sw600dp`
 * gate reads it – the same number the tablet layout is picked on, `PHONE_MAX_WIDTH` in
 * `formFactor.ts`) and holds its own half back on a tablet too (`FullscreenRotation`'s hand-over).
 */

export type SimpleOrientation = 'portrait' | 'landscape' | 'unknown'

/** A video smaller than this both ways is a thumbnail, not a player: no turn takes it fullscreen. */
export const MIN_VIDEO_SIZE = 200
/** How much of a playing video must be in view for the turn to take it fullscreen. */
export const VISIBILITY_THRESHOLD = 0.75

/** The screen's orientation by `screen.orientation.type`; unknown for a screen that says nothing. */
export function screenOrientationOf(type: string | undefined | null): SimpleOrientation {
  if (!type) return 'unknown'
  if (type.startsWith('portrait')) return 'portrait'
  if (type.startsWith('landscape')) return 'landscape'
  return 'unknown'
}

/** The orientation a video of this natural size asks the screen for; unknown for no size, or a thumbnail's. */
export function videoOrientationOf(width: number, height: number): SimpleOrientation {
  if (!(width > 0) || !(height > 0)) return 'unknown'
  if (width < MIN_VIDEO_SIZE && height < MIN_VIDEO_SIZE) return 'unknown'
  return width >= height ? 'landscape' : 'portrait'
}

/** What the decision reads off a video. */
export interface RotateVideo {
  /** Not paused and not ended. */
  playing: boolean
  /** The native controls (`controls`). */
  controls: boolean
  /** `controlslist` names `nofullscreen`. */
  fullscreenBlocked: boolean
  pictureInPicture: boolean
  /** In view by `VISIBILITY_THRESHOLD` at the last observation. */
  visible: boolean
  width: number
  height: number
}

/** The fullscreen element as it stands: none, this video, or something else. */
export type FullscreenStanding = 'none' | 'this' | 'other'

export type RotateDecision = 'enter' | 'exit' | 'stay'

/**
 * What a turn of the screen from `previous` to `current` does with `video`: the way in for a
 * playing video whose orientation the screen now has, the way out for the fullscreen video whose
 * orientation it no longer has, nothing for anything else.
 */
export function rotateDecision(
  video: RotateVideo,
  previous: SimpleOrientation,
  current: SimpleOrientation,
  fullscreen: FullscreenStanding
): RotateDecision {
  // No turn, an unknown screen, or a 180° flip within the one orientation.
  if (previous === 'unknown' || current === 'unknown' || previous === current) return 'stay'
  const wanted = videoOrientationOf(video.width, video.height)
  if (wanted === 'unknown') return 'stay'
  if (current === wanted) {
    if (fullscreen !== 'none') return 'stay'
    if (!video.playing || !video.controls || video.fullscreenBlocked) return 'stay'
    if (video.pictureInPicture || !video.visible) return 'stay'
    return 'enter'
  }
  return fullscreen === 'this' ? 'exit' : 'stay'
}

/** The document's fullscreen element, under either name the engines have given it. */
export function fullscreenElementOf(doc: Document): Element | null {
  return (
    doc.fullscreenElement ??
    (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
    null
  )
}

type ScreenOrientationLike = EventTarget & { type?: string }

function orientationOf(win: Window): ScreenOrientationLike | null {
  const screen = (win as Window & { screen?: { orientation?: unknown } }).screen
  const orientation = screen?.orientation
  if (!orientation || typeof (orientation as EventTarget).addEventListener !== 'function')
    return null
  return orientation as ScreenOrientationLike
}

function isVideo(target: EventTarget | null): target is HTMLVideoElement {
  return typeof HTMLVideoElement !== 'undefined' && target instanceof HTMLVideoElement
}

function playing(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended
}

function readVideo(
  doc: Document,
  video: HTMLVideoElement,
  visible: WeakMap<HTMLVideoElement, boolean>
): RotateVideo {
  const list = (video.getAttribute('controlslist') ?? '').toLowerCase().split(/\s+/)
  const pip = (doc as Document & { pictureInPictureElement?: Element | null })
    .pictureInPictureElement
  return {
    playing: playing(video),
    controls: video.hasAttribute('controls'),
    fullscreenBlocked: list.includes('nofullscreen'),
    pictureInPicture: pip === video,
    visible: visible.get(video) ?? false,
    width: video.videoWidth,
    height: video.videoHeight
  }
}

/**
 * Run Chrome's rule in this document: follow the playing videos' visibility, hear the screen turn,
 * and ask for or leave fullscreen inside the turn's own event (the request's standing, above).
 * Nothing without a `screen.orientation` that speaks (a document in a frame without one, a host
 * whose engine has none).
 */
export function installRotateToFullscreen(win: Window = window): void {
  const orientation = orientationOf(win)
  if (!orientation) return
  const doc = win.document
  const visible = new WeakMap<HTMLVideoElement, boolean>()
  const Observer = (win as Window & { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver
  const observer =
    typeof Observer === 'function'
      ? new Observer(
          (entries) => {
            for (const entry of entries) {
              if (!isVideo(entry.target)) continue
              visible.set(
                entry.target,
                entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_THRESHOLD
              )
            }
          },
          { threshold: [VISIBILITY_THRESHOLD] }
        )
      : null
  const follow = (video: HTMLVideoElement): void => {
    if (observer) observer.observe(video)
    // Without an observer (an engine short of one) a playing video counts as in view.
    else visible.set(video, true)
  }
  const drop = (video: HTMLVideoElement): void => {
    observer?.unobserve(video)
    visible.delete(video)
  }
  // Media events do not bubble; the capture phase at the document hears every video's.
  doc.addEventListener(
    'play',
    (e) => {
      if (isVideo(e.target)) follow(e.target)
    },
    true
  )
  const stopped = (e: Event): void => {
    if (isVideo(e.target)) drop(e.target)
  }
  doc.addEventListener('pause', stopped, true)
  doc.addEventListener('ended', stopped, true)
  doc.addEventListener('emptied', stopped, true)
  // A video playing before the script came (the Android script runs at the page's finish).
  for (const video of doc.querySelectorAll('video')) if (playing(video)) follow(video)

  let previous = screenOrientationOf(orientation.type)
  orientation.addEventListener('change', () => {
    const current = screenOrientationOf(orientation.type)
    const was = previous
    previous = current
    const element = fullscreenElementOf(doc)
    if (element) {
      if (!isVideo(element)) return
      if (rotateDecision(readVideo(doc, element, visible), was, current, 'this') === 'exit')
        void doc.exitFullscreen?.().catch(() => undefined)
      return
    }
    for (const video of doc.querySelectorAll('video')) {
      if (rotateDecision(readVideo(doc, video, visible), was, current, 'none') !== 'enter') continue
      const request =
        video.requestFullscreen ??
        (video as HTMLVideoElement & { webkitRequestFullscreen?: () => Promise<void> | void })
          .webkitRequestFullscreen
      if (!request) return
      try {
        const result = request.call(video) as Promise<void> | void
        if (result && typeof result.catch === 'function') void result.catch(() => undefined)
      } catch {
        /* the engine refused: a request without standing, or one already under way */
      }
      return
    }
  })
}

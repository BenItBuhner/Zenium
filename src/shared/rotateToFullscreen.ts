/**
 * Rotate-to-fullscreen's page side (MED-02). The turn itself is the engine's: Chrome's
 * `MediaControlsRotateToFullscreenDelegate` runs in WebView too – content's web preference
 * `video_rotate_to_fullscreen_enabled` is on for the phone form factor, every embedder's – so
 * a `<video>` with the browser's controls, playing three quarters in view, goes fullscreen
 * when the screen turns to its orientation and leaves when the screen turns away, on Chrome's
 * own gates (a `deviceorientation` reading with beta and gamma among them). What the page
 * tells the host is which fullscreen elements are that kind (`rotateManaged`, the `fullscreen`
 * report's `rotate`): for those the host's orientation lock (MED-01) gives way to the device's
 * turn (Chrome's lock-to-any, `RotateUnlock`), so that the turn back can exit at all.
 */

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

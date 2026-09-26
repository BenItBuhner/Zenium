/**
 * The pointer in use, as the last pointer event said it (`pointerType`): the root's
 * `data-hover` (`formFactor.ts`'s `refresh`) is `hover` when the `(hover: hover)` media query
 * says so – a desktop – OR when this says the pointer that last moved over the chrome was a
 * mouse or a pen, and `none` otherwise (a finger, or nothing yet on a touch screen). Every hover
 * fill and hover reveal in the stylesheets is gated on it (main.css, the note beside the
 * `data-pointer` rules) in place of `@media (hover: hover)`.
 *
 * Why the media query alone could not gate hover on Android: the WebView answers `(hover: hover)`
 * from the primary pointer, and with a touch screen present that is the touch screen – a mouse
 * on a tablet or a Samsung DeX desktop never flips it – so the tablet chrome's hover fills
 * were dead under a mouse (OS-12), while an ungated `:hover` sticks on a tapped element until
 * the next touch (Chromium's sticky hover). The pointer events know which device is moving:
 * a mouse hovers, a pen in range hovers (S Pen air view), a finger cannot.
 *
 * `pointerover` (the pointer entered an element) and `pointerdown` are enough for the flip in
 * either direction – a mouse that begins to move enters an element at once, a finger's tap
 * is a `pointerover` then a `pointerdown` – with `pointermove` beside them for a mouse resting
 * inside one element after a touch; the listener compares a string and writes nothing when the
 * kind is unchanged. Only pointer events from the window itself: a synthetic mouse event
 * Chromium sends for a tap (`mousemove`, `mouseover`) is not a pointer event and says nothing.
 */

export type PointerHover = 'hover' | 'none'

/** What `pointerover`, `pointermove` and `pointerdown` carry that decides the hover ability. */
export interface PointerEventLike {
  type: string
  pointerType?: string
}

const POINTER_EVENTS = ['pointerover', 'pointermove', 'pointerdown'] as const

/**
 * The hover ability a pointer event stands for: a mouse or a pen hovers, a finger does not;
 * any other event, or an unknown pointer type, says nothing (`null`).
 */
export function hoverOf(event: PointerEventLike): PointerHover | null {
  if (!(POINTER_EVENTS as readonly string[]).includes(event.type)) return null
  switch (event.pointerType) {
    case 'mouse':
    case 'pen':
      return 'hover'
    case 'touch':
      return 'none'
    default:
      return null
  }
}

let live: PointerHover | null = null
const listeners = new Set<() => void>()

/** The last pointer's hover ability, or null before any pointer event (the media query decides). */
export function livePointerHover(): PointerHover | null {
  return live
}

/** Hear the live pointer change kind (a mouse after fingers, a finger after a mouse). */
export function onLivePointerChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Record a pointer event's kind; a repeat of the current kind changes nothing and tells nobody. */
export function notePointer(event: PointerEventLike): void {
  const next = hoverOf(event)
  if (next === null || next === live) return
  live = next
  for (const listener of listeners) listener()
}

/** Forget the live pointer (tests). */
export function resetLivePointer(): void {
  live = null
}

/** Watch the window's pointer events (capture, so a handler that stops them still counts). */
export function watchLivePointer(target: Window = window): () => void {
  const listener = (event: Event): void => notePointer(event as unknown as PointerEventLike)
  for (const type of POINTER_EVENTS) target.addEventListener(type, listener, true)
  return () => {
    for (const type of POINTER_EVENTS) target.removeEventListener(type, listener, true)
  }
}

const flags = globalThis as unknown as { __zenLivePointerWatched?: boolean }
if (
  !flags.__zenLivePointerWatched &&
  typeof window !== 'undefined' &&
  typeof document !== 'undefined'
) {
  flags.__zenLivePointerWatched = true
  watchLivePointer()
}

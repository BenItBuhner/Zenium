/**
 * A touch that begins on the hint bubble ends on it (TB-19; Chrome's popup consumes a touch on
 * itself and lets one outside it through to the control, `AnchoredPopupWindow.onTouch`). The
 * first touch anywhere takes the bubble down, and the bubble stays the touch's target through
 * its fade (`pointer-events: auto` kept under `[data-leaving]`, main.css), but the `click` a
 * tap becomes is hit-tested when the gesture is recognised, after the finger lifts – and on a
 * slow frame that came after the fade had swept the bubble's node away, so the click landed on
 * what the bubble stood over (the emulator's fourth run: the New Tab card beneath opened a
 * tab). So a touch down on the bubble arms `holdTouch`: a one-shot swallow of the next `click`,
 * heard at the document's capture phase – React's root never sees it, nothing under the bubble
 * runs – that outlives the bubble's node on purpose, and stands down on that click, on the
 * touch's cancel (a scroll took it: no click follows), on the next touch (its own click is its
 * own), or `HINT_TAP_SETTLE_MS` after the finger lifts. Both bubbles share it: the bar's
 * (#641) stands over the page's cover, the overview's over a card.
 */
export const HINT_TAP_SETTLE_MS = 1500

let disarm: (() => void) | null = null

export function holdTouch(pointerId: number): void {
  disarm?.()
  let settle: ReturnType<typeof setTimeout> | null = null
  const off = (): void => {
    disarm = null
    if (settle !== null) clearTimeout(settle)
    document.removeEventListener('click', swallow, true)
    document.removeEventListener('pointerdown', off, true)
    document.removeEventListener('pointerup', lifted, true)
    document.removeEventListener('pointercancel', lifted, true)
  }
  const swallow = (e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    off()
  }
  const lifted = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    if (e.type === 'pointercancel') off()
    else settle = setTimeout(off, HINT_TAP_SETTLE_MS)
  }
  document.addEventListener('click', swallow, true)
  document.addEventListener('pointerdown', off, true)
  document.addEventListener('pointerup', lifted, true)
  document.addEventListener('pointercancel', lifted, true)
  disarm = off
}

/** Test seam: stand the held touch down between cases. */
export function releaseHeldTouch(): void {
  disarm?.()
}

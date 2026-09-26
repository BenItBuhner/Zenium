/**
 * The smoke's reading of a page view's place in its window (`Session.keyboardFacts`: each
 * `WebContentsView`'s `visible` and `bounds`, the window's `content`).
 *
 * A page under a chrome cover – the URL bar's dropdown, a menu, a bubble, the Web capture
 * overlay – is PARKED, not hidden (W6-F5, `src/main/platform/views.ts` `ElectronTabView.park`):
 * its view keeps its size and stays shown, moved so that one corner pixel of it is inside the
 * window's content and the rest outside. Chromium counts the page VISIBLE then and keeps
 * running its speculation-rules prefetches, which a hidden view stopped for good. So "the view
 * out of the way behind its picture" is either of two shapes: hidden, or parked in a corner.
 */

/**
 * Whether `bounds` (the view's box, DIP of the window's content) stands parked: exactly one
 * pixel of it inside the content `{ width, height }`, in one of its corners.
 */
export function parkedInCorner(bounds, content) {
  if (!bounds || !content) return false
  const insideX = Math.min(bounds.x + bounds.width, content.width) - Math.max(bounds.x, 0)
  const insideY = Math.min(bounds.y + bounds.height, content.height) - Math.max(bounds.y, 0)
  return insideX === 1 && insideY === 1
}

/**
 * Whether the view stands shown in its box: visible to the engine and not parked. False for a
 * hidden view and for a parked one alike – the page is behind its picture either way.
 */
export function viewInBox(view, content) {
  if (!view) return null
  return view.visible === true && !parkedInCorner(view.bounds, content)
}

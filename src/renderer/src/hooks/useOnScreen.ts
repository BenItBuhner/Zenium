import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether the element is within the box of the nearest scroller above it (the viewport when
 * there is none) – or within `margin` of that box, as an `IntersectionObserver` with the
 * scroller for its root sees it: a card scrolled out of the overview's grid is off screen though
 * the grid's box is not, and a card a row below the grid's edge is on it when `margin` says so.
 * The margin is the scroller's to measure (a percentage is of its height), which is why the
 * root is the scroller and not the viewport: an observer rooted at the viewport clips the
 * element by the scroller first, and no margin brings back what the scroller has clipped. True
 * from the first observation on until the element leaves again; true throughout where the
 * platform has no observer (the tests' DOM).
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, margin = '0px'): boolean {
  const observed = typeof IntersectionObserver !== 'undefined'
  const [visible, setVisible] = useState(!observed)
  useEffect(() => {
    const el = ref.current
    if (!el || !observed) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting)
      },
      { root: scrollParent(el), rootMargin: margin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, margin, observed])
  return visible
}

/** The nearest ancestor that scrolls vertically, or null for the viewport. */
function scrollParent(el: HTMLElement): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

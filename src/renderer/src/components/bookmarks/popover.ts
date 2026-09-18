import { useEffect, useState, type RefObject } from 'react'

/*
 * Keyboard and scroll helpers shared by the bookmark popovers and dialogs. Their geometry
 * (§9.20 widths and placement) and the layer they render in come from lib/portals.tsx.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The tabbable elements inside `root`, in document order (hidden ones left out). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * Tab wraps inside an open popover or dialog (§9.22): at the last tabbable element Tab lands on
 * the first, and Shift+Tab at the first lands on the last. Call from the container's `onKeyDown`.
 */
export function wrapTab(e: React.KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root) return
  const list = tabbables(root)
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const current = document.activeElement
  if (!e.shiftKey && (current === last || !root.contains(current))) {
    e.preventDefault()
    first?.focus()
  } else if (e.shiftKey && (current === first || !root.contains(current))) {
    e.preventDefault()
    last?.focus()
  }
}

/** Escape returns focus to the anchor a popover hung from (§9.22). */
export function focusAnchor(selector: string): void {
  document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
}

/**
 * Whether a scrolling body has moved under its sticky title: the title draws the §9.7 hairline
 * only while it has (the ref's element is the scroll container).
 */
export function useScrolled(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setScrolled(el.scrollTop > 0)
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [ref])
  return scrolled
}

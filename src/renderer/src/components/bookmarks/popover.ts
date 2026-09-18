import { useEffect, useState, type RefObject } from 'react'
import type { Rect } from '@shared/types'

/**
 * Desktop popover geometry (design-language-v2-draft §9.20): one of three fixed widths, the top
 * border flush with the bottom edge of the bar or pill the anchor sits in, start edges aligned
 * with the anchor's box unless the anchor is in the trailing half of its bar, clamped 8 px inside
 * the window, and no taller than 60% of the window or the window minus 16.
 */
export const POPOVER_WIDTH = { list: 320, form: 400, table: 480 } as const
export const POPOVER_MARGIN = 8

export interface PopoverBox {
  left: number
  top: number
  width: number
  maxHeight: number
}

export function placePopover(
  anchor: Rect,
  /** The bar or pill the anchor sits in; the anchor's own box when it stands alone. */
  bar: Rect,
  width: number,
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight
  }
): PopoverBox {
  const trailing = anchor.x + anchor.width / 2 > bar.x + bar.width / 2
  let left = trailing ? anchor.x + anchor.width - width : anchor.x
  left = Math.min(Math.max(POPOVER_MARGIN, left), viewport.width - width - POPOVER_MARGIN)
  const top = bar.y + bar.height
  const maxHeight = Math.max(
    0,
    Math.min(viewport.height * 0.6, viewport.height - 16, viewport.height - top - POPOVER_MARGIN)
  )
  return { left, top, width, maxHeight }
}

export function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

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

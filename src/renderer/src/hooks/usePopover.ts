import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { focusableIn, wrapTab } from '@renderer/lib/popover'
import { useEscape } from './useEscape'

type Initial = 'first' | 'container' | 'none' | ((root: HTMLElement) => HTMLElement | null)

/**
 * The keyboard inside a renderer-owned popover, menu or dialog (v2 draft §9.22): Escape closes
 * it; once it is painted (`active`) focus moves into it – its first focusable, the container
 * itself (`tabIndex -1`, for a menu opened by pointer or a title-and-notice panel), or an
 * element of the caller's choosing – or, for `'none'`, stays where it was (a prompt a page event
 * raised beside a chip in the pill takes no focus on open); Tab wraps inside it; and when it
 * goes while focus is still inside, focus returns to the control that opened it (what had focus
 * when it mounted).
 *
 * The chrome layer and the frame dialog host (lib/portals.tsx) place the surface and own the
 * rest: light dismiss, one popover at a time, the scroll and resize that close an anchored
 * popover (`useLightDismiss`), the scrim and the inert chrome of a dialog (`useFrameDialog`).
 */
export function usePopover(
  ref: RefObject<HTMLElement | null>,
  {
    onClose,
    active = true,
    initial = 'first',
    returnTo
  }: {
    onClose: () => void
    /** False while the popover holds its first paint (the content capture is not in place yet). */
    active?: boolean
    initial?: Initial
    /**
     * Where focus goes back to – the anchor, as an element or a ref to one; defaults to the
     * element focused when the popover mounted.
     */
    returnTo?: HTMLElement | RefObject<HTMLElement | null> | null
  }
): void {
  useEscape(onClose)

  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const latestReturnTo = useRef(returnTo)
  useEffect(() => {
    latestReturnTo.current = returnTo
  })
  // The root from the moment focus moved into it, for the unmount cleanup: a popover that holds
  // its first paint (renders null until the content capture is in place) has no root yet when
  // the layout effect below first runs, so the cleanup cannot resolve it then.
  const entered = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    entered.current = root
    if (initial === 'none') return
    const el =
      initial === 'container'
        ? root
        : initial === 'first'
          ? (focusableIn(root)[0] ?? root)
          : (initial(root) ?? focusableIn(root)[0] ?? root)
    if (el === root && root.tabIndex < 0 && !root.hasAttribute('tabindex')) root.tabIndex = -1
    el.focus({ preventScroll: true })
  }, [active, initial, ref])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      const root = ref.current
      if (root) wrapTab(root, e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, ref])

  useLayoutEffect(() => {
    return () => {
      // A layout cleanup runs before React detaches refs and removes the node, so the root is
      // intact and focus, if it is inside, has not yet been lost to the removal.
      const root = entered.current
      if (!root || !root.contains(document.activeElement)) return
      const back = latestReturnTo.current
      const target = back === undefined ? opener : back && 'current' in back ? back.current : back
      target?.focus({ preventScroll: true })
    }
  }, [opener])
}

/**
 * Arrow keys move focus among a popover's items (menu items, options): Down and Up wrap, Home
 * and End jump; from the container itself Down starts at the first item, as Firefox's app menu
 * does when opened by pointer.
 */
export function useArrowKeys(ref: RefObject<HTMLElement | null>, itemSelector: string): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = ref.current
      if (!root) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const items = [...root.querySelectorAll<HTMLElement>(itemSelector)].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true'
      )
      if (items.length === 0) return
      const current = document.activeElement
      const index = current instanceof HTMLElement ? items.indexOf(current) : -1
      let next: HTMLElement | undefined
      if (e.key === 'Home') next = items[0]
      else if (e.key === 'End') next = items.at(-1)
      else if (e.key === 'ArrowDown') next = items[index === -1 ? 0 : (index + 1) % items.length]
      else next = items[index <= 0 ? items.length - 1 : index - 1]
      if (!next) return
      e.preventDefault()
      next.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [itemSelector, ref])
}

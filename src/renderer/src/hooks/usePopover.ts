import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { handleMenuKey } from '@renderer/lib/menuKeys'
import { focusableIn, returnFocusTo, wrapTab } from '@renderer/lib/popover'
import { useEscape } from './useEscape'

type Initial = 'first' | 'container' | 'none' | ((root: HTMLElement) => HTMLElement | null)

/**
 * The keyboard inside a renderer-owned popover, menu or dialog (v2 draft §9.22): Escape closes
 * it; once it is painted (`active`) focus moves into it – its first focusable, the container
 * itself (`tabIndex -1`, for a menu opened by pointer or a title-and-notice panel), or an
 * element of the caller's choosing – or, for `'none'`, stays where it was (a prompt a page event
 * raised beside a chip in the pill takes no focus on open); Tab wraps inside it; and when it
 * goes while focus is still inside, focus returns to the control that opened it (what had focus
 * when it mounted) – a control of the inert window chrome's once the chrome is back
 * (lib/popover.ts `returnFocusTo`, the Settings dialogs' return too).
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
  // The latest `returnTo` and `initial`, read when they are needed: callers pass them inline, and
  // a fresh function on every render must not count as a change (the initial focus is taken
  // once, when the popover becomes active – not again on every state push while the keyboard is
  // on one of its controls).
  const latestReturnTo = useRef(returnTo)
  const latestInitial = useRef(initial)
  useEffect(() => {
    latestReturnTo.current = returnTo
    latestInitial.current = initial
  })
  // The root from the moment focus moved into it, for the unmount cleanup: a popover that holds
  // its first paint (renders null until the content capture is in place) has no root yet when
  // the layout effect below first runs, so the cleanup cannot resolve it then.
  const entered = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    entered.current = root
    const first = latestInitial.current
    if (first === 'none') return
    const el =
      first === 'container'
        ? root
        : first === 'first'
          ? (focusableIn(root)[0] ?? root)
          : (first(root) ?? focusableIn(root)[0] ?? root)
    if (el === root && root.tabIndex < 0 && !root.hasAttribute('tabindex')) root.tabIndex = -1
    el.focus({ preventScroll: true })
  }, [active, ref])

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
      if (target) returnFocusTo(target)
    }
  }, [opener])
}

/**
 * Arrow keys move focus among a popover's items (menu items, options): Down and Up wrap, Home
 * and End jump; from the container itself Down starts at the first item, as Firefox's app menu
 * does when opened by pointer. A menu (`mnemonics`) also answers a letter as Chrome's native
 * menus do: it goes to the next item whose label starts with it, and runs the item when it is
 * the only one (lib/menuKeys.ts; on macOS the letter only moves, as the system's menus do).
 */
export function useArrowKeys(
  ref: RefObject<HTMLElement | null>,
  itemSelector: string,
  options: { mnemonics?: boolean } = {}
): void {
  const { mnemonics = false } = options
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = ref.current
      if (!root) return
      const items = [...root.querySelectorAll<HTMLElement>(itemSelector)]
      if (items.length === 0) return
      // A letter is the menu's only while the keyboard is in it (the URL bar may open over it).
      handleMenuKey(e, items, { mnemonics: mnemonics && root.contains(document.activeElement) })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [itemSelector, mnemonics, ref])
}

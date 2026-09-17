import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { claimPopover, focusableIn } from '@renderer/lib/popover'
import { useEscape } from './useEscape'

type Initial = 'first' | 'container' | ((root: HTMLElement) => HTMLElement | null)

/**
 * What every renderer-owned popover, menu and dialog does the same way (v2 draft §9.20, §9.22):
 * it is the one popover open (claiming the slot closes whatever held it); Escape closes it; once
 * it is painted (`active`) focus moves into it – its first focusable, the container itself
 * (`tabIndex -1`, for a menu opened by pointer or a title-and-notice panel), or an element of
 * the caller's choosing; Tab wraps inside it; and when it goes while focus is still inside,
 * focus returns to the control that opened it (what had focus when it mounted). A close by an
 * outside click leaves focus where the click landed, since the click moved it first.
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
  const latestClose = useRef(onClose)
  useEffect(() => {
    latestClose.current = onClose
  })
  useEscape(onClose)
  useEffect(() => claimPopover(() => latestClose.current()), [])

  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )

  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
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
      if (!root || e.key !== 'Tab') return
      const items = focusableIn(root)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const current = document.activeElement
      const index = current instanceof HTMLElement ? items.indexOf(current) : -1
      let next: HTMLElement | undefined
      if (index === -1 || !root.contains(current)) next = e.shiftKey ? items.at(-1) : items[0]
      else if (e.shiftKey && index === 0) next = items.at(-1)
      else if (!e.shiftKey && index === items.length - 1) next = items[0]
      if (!next) return
      e.preventDefault()
      next.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, ref])

  useLayoutEffect(() => {
    const root = ref.current
    // The anchor outlives its popover, so it can be resolved now rather than at cleanup.
    const target =
      returnTo === undefined
        ? opener
        : returnTo && 'current' in returnTo
          ? returnTo.current
          : returnTo
    return () => {
      if (!root || !root.contains(document.activeElement)) return
      target?.focus({ preventScroll: true })
    }
  }, [ref, returnTo, opener])
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

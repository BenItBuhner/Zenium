import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { initialFocusIn, wrapTabTarget } from '@renderer/lib/focusReach'

/**
 * Keyboard reach into a popover or dialog (design language v2 §9.22). On mount focus moves into
 * `container` – to its first field, row or button, or to the container itself (`tabIndex -1`)
 * when nothing inside is tabbable – unless something inside already took it. Tab and Shift+Tab
 * wrap at its ends for as long as it is up. `returnFocus` hands focus back to the element that
 * had it when the container opened (the anchor): for an Escape close; a close by outside click
 * leaves focus where the click landed and does not call it.
 */
export function useFocusReach(container: RefObject<HTMLElement | null>): {
  returnFocus: () => void
} {
  const opener = useRef<HTMLElement | null>(null)
  const opened = useRef(false)

  useEffect(() => {
    const root = container.current
    if (!root) return
    const active = document.activeElement
    // Recorded once: a development remount finds focus already inside and must not take that
    // for the anchor.
    if (!opened.current) {
      opened.current = true
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    if (!root.contains(active)) initialFocusIn(root).focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
      const target = wrapTabTarget(root, document.activeElement, e.shiftKey)
      if (!target) return
      e.preventDefault()
      target.focus()
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [container])

  const returnFocus = useCallback((): void => {
    const el = opener.current
    if (el?.isConnected) el.focus()
  }, [])

  return { returnFocus }
}

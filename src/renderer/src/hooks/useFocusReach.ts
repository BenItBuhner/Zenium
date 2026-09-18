import { useEffect, type RefObject } from 'react'
import { initialFocusIn, wrapTabTarget } from '@renderer/lib/focusReach'

/**
 * Keyboard reach into a popover or dialog (design language v2 §9.22). On mount focus moves into
 * `container` – to its first field, row or button, or to the container itself (`tabIndex -1`)
 * when nothing inside is tabbable – unless something inside already took it. Tab and Shift+Tab
 * wrap at its ends for as long as it is up. Where focus goes when the container closes is the
 * caller's: Escape hands it to the anchor (`focusAnchor`) or the page (`returnFocusToPage`), and
 * the chrome layer's light dismiss leaves it where the press landed.
 */
export function useFocusReach(container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = container.current
    if (!root) return
    if (!root.contains(document.activeElement)) initialFocusIn(root).focus()

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
}

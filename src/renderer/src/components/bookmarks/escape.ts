import { useEffect } from 'react'

/**
 * Capture-phase Escape so a pane (chooser, overflow, dialog) closes before the overlay
 * listener on `window` (bubble) dismisses the manager.
 */
export function useEscapeTrap(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, onEscape])
}

import { useEffect, useRef } from 'react'

/**
 * Escape closes the popup this component is: listened for in the capture phase so nothing under
 * it (the overlay behind a menu, the page) sees the key. `close` may change between renders.
 */
export function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

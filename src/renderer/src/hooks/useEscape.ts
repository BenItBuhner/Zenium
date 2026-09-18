import { useEffect, useRef, type RefObject } from 'react'

/** Open popups, oldest first: Escape goes to the one on top (v2 draft §9.24), the rest wait. */
const stack: Array<RefObject<() => void>> = []

/**
 * Escape closes the popup this component is: listened for in the capture phase so nothing under
 * it (the overlay behind a menu, the page, a sheet beneath a sheet) sees the key. Only the most
 * recently opened popup answers; one under it takes the next Escape once it is gone. `close` may
 * change between renders.
 */
export function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    stack.push(latest)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stack.at(-1) !== latest) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      const at = stack.indexOf(latest)
      if (at !== -1) stack.splice(at, 1)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
}

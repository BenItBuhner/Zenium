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

/**
 * Escape closes a prompt that stands outside the popup stack – a chassis sheet (the external
 * protocol ask, voice search's listening sheet) or its panel on a mouse – and answers "not now"
 * (hardware keyboards exist on tablets and DeX too). A sheet that is `leaving` – its request
 * gone, on its way down under `SheetPresence` (§11.1) – lets the key by: it answers nothing any
 * more, and a sheet that came up above it does. `close` may change between renders.
 */
export function useEscapeUnlessLeaving(close: () => void, leaving = false): void {
  const latest = useRef({ close, leaving })
  useEffect(() => {
    latest.current = { close, leaving }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || latest.current.leaving) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

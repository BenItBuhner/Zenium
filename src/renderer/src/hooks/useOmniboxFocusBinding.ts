import { useCallback, useEffect, useRef } from 'react'
import { bindOmniboxFocus } from '@renderer/lib/omniboxFocus'

/**
 * A ref for an element whose subtree reads the pill's focus motion (`bindOmniboxFocus`,
 * lib/omniboxFocus.ts): the phone bar and the omnibox's layer. The element carries
 * `--zen-omnibox-focus` – 0 the pill's pose … 1 the omnibox's, written on it per frame – and the
 * pill's slot from its mount to its unmount, for the rules under it in main.css to turn into
 * transforms and opacities. Written there rather than on the root so a frame recalculates that
 * subtree's style and not the whole chrome's (PERF-2's H3; `useBarHideBinding` is the same
 * shape for `--zen-bar-hide`).
 */
export function useOmniboxFocusBinding(): (el: HTMLElement | null) => void {
  const unbind = useRef<(() => void) | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    unbind.current?.()
    unbind.current = el ? bindOmniboxFocus(el) : null
  }, [])
  useEffect(
    () => () => {
      unbind.current?.()
      unbind.current = null
    },
    []
  )
  return ref
}

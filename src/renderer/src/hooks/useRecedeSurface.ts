import { useLayoutEffect, type RefObject } from 'react'
import { registerRecedeSurface } from '@renderer/lib/motion/recede'

/**
 * The element moves on the page's recede (main.css reads `--zen-recede` on it: the content
 * frame's scale and corner, the bottom bar's fade, the layers on the frame's edges): register it
 * with the recede registry for as long as it is mounted, so the sheet chassis writes the value on
 * it each frame (`lib/motion/recede.ts`, the header: the root's value does not inherit). A
 * layout effect, so a surface mounting under an open sheet carries the value before it paints.
 */
export function useRecedeSurface(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return registerRecedeSurface(el)
  }, [ref])
}

import { useLayoutEffect, type RefObject } from 'react'
import { registerFakeboxSurface } from '@renderer/lib/fakeboxMorph'

/**
 * The element reads the new tab page's morph values (main.css reads `--zen-ntp-morph` and
 * `--zen-ntp-pill` on it: the bar's fade under the arriving field, the pill's slot filling in as
 * the well, the omnibox sheet's fade, the page's gear): register it with the morph for as long
 * as it is mounted, so the controller writes the values on it each frame (`lib/fakeboxMorph.ts`,
 * the header: the root's values do not inherit). A layout effect, so an element mounting
 * mid-flight – the sheet as the field sets out, the bar as it comes home – carries the pose
 * before it paints.
 */
export function useFakeboxSurface(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return registerFakeboxSurface(el)
  }, [ref])
}

import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { bandOffsetStore } from '@renderer/lib/pageBand'

/**
 * Two corner masks that ride the page-edge band's offset (motion spec §3.1, §3.4; the Design
 * Lead's seed D3 on W8-M2): where the page's top edge stands under the band, its two top corners
 * keep the frame's radius – the frame's ground (`--zen-bg-solid`, the frame's own background)
 * painted outside an arc of `--zen-content-radius` at each side, the inverse of the frame's
 * corner. A page of the web needs none: its view is a native layer over the chrome, rounded at
 * the frame's radius by the host's own mask (`setBorderRadius`, the one reading the layout
 * reporter hands it), and the chrome paints nothing over it – under the view the masks lie
 * unseen, and in the notch its rounded corner leaves they are the ground the frame shows there
 * anyway. The masks are for the surfaces the chrome draws under the band – a chrome page on the
 * band's layer (`PageBandLayer`), the page's picture under a cover – whose boxes are square at
 * the top: above them (`z-index` 5) and under the band itself (6), so a page travelling under
 * the band shows its corners the moment its edge comes out from under the band's, and never a
 * notch cut into the band.
 *
 * They move with the page per frame, written to the element from the offset store's subscription
 * (`bandOffsetStore`, the number the core hears as `layout.pageOffset` and the layer rides on):
 * `translateY(offset)` – the page's top edge, whatever the seat – and a frame of a travel
 * re-renders nothing. At home (offset 0) there is nothing to mask: the page's top corners are
 * the frame's own, cut by the frame's radius and the view's, so the masks are hidden rather than
 * drawn over them – one source of truth for the corners at rest. They take no pointer: a press
 * at the page's corner is the page's.
 */
export function PageBandCorners(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = (): void => {
      const { offset } = bandOffsetStore.get()
      if (offset > 0) {
        el.style.transform = `translateY(${offset}px)`
        el.removeAttribute('data-home')
      } else {
        el.style.transform = ''
        el.setAttribute('data-home', '')
      }
    }
    place()
    return bandOffsetStore.subscribe(place)
  }, [])
  return (
    <div ref={ref} className="zen-band-corners" data-band-corners="" aria-hidden>
      <span className="zen-band-corner" data-side="left" />
      <span className="zen-band-corner" data-side="right" />
    </div>
  )
}

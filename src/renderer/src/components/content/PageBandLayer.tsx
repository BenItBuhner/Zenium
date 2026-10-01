import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import {
  bandOffsetStore,
  bandSeatStore,
  chromePageOffsetStore,
  chromePageSeatStore
} from '@renderer/lib/pageBand'

/**
 * The layer a page the chrome draws itself rides on under the page-edge band (motion spec §3.4;
 * the Design Lead's §10 change on #740: a state band stands on the chrome pages). Settings,
 * History, every `render: 'chrome'` page `InternalPageHost` draws has no page view under it, so
 * the core's `layout.pageOffset` moves nothing for it; this layer moves it the same way, through
 * the same seam the views use (`lib/pageBand.ts`): laid out under the band's SEAT (`top`), as
 * the layout reporter lays the views out (`pageRectUnderBand`), and translated per frame by the
 * band's OFFSET against that seat, as `core/window.ts`'s `setPageOffset` moves the placed
 * views' bounds by `offset − seat` – a move, never a resize. One source for both: the seat and
 * the offset stores the spring's frames drive through `seatBand` and `movePage`. The transform
 * is written to the element itself, so a frame of the travel re-renders nothing; the seat
 * changes once per travel and re-renders the layer with the page, as the frame's chrome re-lays
 * out under it. At home the layer is a plain full-frame box with no transform, so nothing of
 * the page's own layout is changed by it. The band draws above it (`.zen-band`'s `z-index`).
 *
 * Its SOURCE is the band's host's pair: the page's (`source="page"`, the default) where the
 * desktop's host is mounted – the stores above, the layout's too; the chrome page's
 * (`source="chrome-page"`) where Android's host is (`lib/band/androidHost.ts`), which moves
 * the WebView by the pull channel and writes `seatChromePage`/`moveChromePage` for such a page
 * alone – a pair the layout report never carries. The same contract either way: a travel
 * translates, the rest seats.
 *
 * The desktop's new tab page is not drawn here: `zen://newtab` is a document the chrome serves
 * into a page view, and the core moves it with every other view.
 */
export function PageBandLayer({
  source = 'page',
  children
}: {
  source?: 'page' | 'chrome-page'
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const chrome = source === 'chrome-page'
  const seatStore = chrome ? chromePageSeatStore : bandSeatStore
  const offsetStore = chrome ? chromePageOffsetStore : bandOffsetStore
  const seat = seatStore.use((s) => s.seat)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = (): void => {
      const shift = offsetStore.get().offset - seat
      el.style.transform = shift === 0 ? '' : `translateY(${shift}px)`
    }
    place()
    return offsetStore.subscribe(place)
  }, [offsetStore, seat])
  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={seat > 0 ? { top: seat } : undefined}
      data-band-layer=""
    >
      {children}
    </div>
  )
}

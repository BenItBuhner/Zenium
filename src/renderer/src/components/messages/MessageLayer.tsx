import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { claimMessageCards, coverBandStore, uiStore } from '@renderer/lib/ui'
import { BannerCard } from './BannerCard'
import { bannerSlots, coverFor } from './stack'
import { ToastCard } from './ToastCard'

/**
 * The phone's message layer over the content frame: banners stack down from its top edge (the
 * newest on top, older ones pushed down), the toast sits at its bottom edge. The layer clips to
 * the frame so cards arrive from and leave by its edges, and it tells the layout reporter how
 * much of the frame's edges the cards cover, so the host clips the page out from under them and
 * lets touches through to them (`coverBandStore`). While it is mounted, messages follow the cards'
 * semantics (`claimMessageCards`).
 */
export function MessageLayer(): JSX.Element | null {
  const toasts = uiStore.use((s) => s.toasts)
  const banners = uiStore.use((s) => s.banners)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const measure = useCallback((id: number, height: number): void => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }))
  }, [])
  useEffect(() => claimMessageCards(), [])

  const live = banners.filter((b) => !b.leaving)
  const { y, height: stackHeight } = bannerSlots(banners.map((b) => heights[b.id] ?? 0))
  const liveStack = bannerSlots(live.map((b) => heights[b.id] ?? 0)).height
  const liveToast = toasts.find((t) => !t.leaving)
  const { top, bottom } = coverFor(liveStack, liveToast ? (heights[liveToast.id] ?? 0) : 0)

  useEffect(() => {
    const prev = coverBandStore.get()
    if (prev.top !== top || prev.bottom !== bottom) coverBandStore.set({ top, bottom })
  }, [top, bottom])
  // Leaving the phone layout takes the cover with it.
  useEffect(() => () => coverBandStore.set({ top: 0, bottom: 0 }), [])

  if (toasts.length === 0 && banners.length === 0) return null
  return (
    <div className="zen-message-layer" aria-live="polite">
      {banners.length > 0 && (
        <div className="zen-message-stack" style={{ height: stackHeight }}>
          {banners.map((b, i) => (
            <BannerCard key={b.id} banner={b} slot={y[i] ?? 0} onMeasure={measure} />
          ))}
        </div>
      )}
      {toasts.length > 0 && (
        <div className="zen-message-toasts">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onMeasure={measure} />
          ))}
        </div>
      )}
    </div>
  )
}

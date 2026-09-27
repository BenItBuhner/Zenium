import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBarHideBinding } from '@renderer/hooks/useBarHideBinding'
import { hintBubbleStore } from '@renderer/lib/iph'
import { claimMessageCards, coverBandStore, uiStore } from '@renderer/lib/ui'
import { BannerCard } from './BannerCard'
import { HintBubbleCard } from './HintBubbleCard'
import { ScreenshotCard } from './ScreenshotCard'
import { bannerSlots, coverFor, hintCoverFor } from './stack'
import { ToastCard } from './ToastCard'

/**
 * The phone's message layer over the content frame: banners stack down from its top edge (the
 * newest on top, older ones pushed down), the toast sits at its bottom edge. The layer clips to
 * the frame so cards arrive from and leave by its edges, and it tells the layout reporter how
 * much of the frame's edges the cards cover, so the host clips the page out from under them and
 * lets touches through to them (`coverBandStore`). While it is mounted, messages follow the cards'
 * semantics (`claimMessageCards`).
 *
 * It is a frame surface, not a `ChromePortal` one (lib/portals.tsx): the cards belong to the
 * content frame's box – they sit at its edges, clip to its rounded corners, recede with it under
 * a sheet, and the strips they report are the frame's – and they layer above the page and the
 * overlays but below sheets, dialogs and popovers, as Chrome's Messages do; the chrome layer is
 * `fixed` over the whole window, above all of those, and never under a transform. Layer and
 * cards are page surfaces (§9.29).
 */
export function MessageLayer(): JSX.Element | null {
  const toasts = uiStore.use((s) => s.toasts)
  const cards = uiStore.use((s) => s.screenshotCards)
  const banners = uiStore.use((s) => s.banners)
  // The in-product help bubble (TB-19, lib/iph.ts): one at a time, at the bar's edge, pointing
  // at its control. It is not a message – no clock, no swipe, no action – but it is a card on
  // the frame's edge like them, and the page is clipped out from under it the same way.
  const hint = hintBubbleStore.use()
  const [heights, setHeights] = useState<Record<number, number>>({})
  const measure = useCallback((id: number, height: number): void => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }))
  }, [])
  const [hintHeight, setHintHeight] = useState(0)
  const measureHint = useCallback((height: number): void => setHintHeight(height), [])
  // How far the banner on its way out of the stack has gone (0 in its slot, 1 gone), written per
  // frame for the stylesheet: the corners it uncovers – its own and its neighbours' – round on it
  // (v2 §9.33), so the stack never shows a square corner and a spring-back un-rounds them.
  const stackRef = useRef<HTMLDivElement>(null)
  const travel = useCallback((progress: number): void => {
    stackRef.current?.style.setProperty('--zen-uncover', progress.toFixed(3))
  }, [])
  // The bar that hides on scroll (lib/barHide.ts) writes its progress on both containers per
  // frame; the stylesheet moves the one on the bar's edge with the bar (the toast under a bottom
  // bar, the stack under a top one), by transform, so the cards ride the bar and nothing here is
  // laid out per frame.
  const bindStack = useBarHideBinding()
  const bindToasts = useBarHideBinding()
  const stackRefs = useCallback(
    (el: HTMLDivElement | null): void => {
      stackRef.current = el
      bindStack(el)
    },
    [bindStack]
  )
  useEffect(() => claimMessageCards(), [])

  const live = banners.filter((b) => !b.leaving)
  const { y, height: stackHeight } = bannerSlots(banners.map((b) => heights[b.id] ?? 0))
  const liveStack = bannerSlots(live.map((b) => heights[b.id] ?? 0)).height
  // The toast's slot holds one live card: a toast, or a screenshot's preview (SH-07).
  const liveToast = toasts.find((t) => !t.leaving) ?? cards.find((c) => !c.leaving)
  const cover = coverFor(liveStack, liveToast ? (heights[liveToast.id] ?? 0) : 0)
  // The bubble's strip on the bar's edge – the card, its arrow to the edge, the inset over it –
  // kept through its fade (its box is still over the page).
  const hintCover = hint.bubble ? hintCoverFor(hintHeight) : 0
  const top = Math.max(cover.top, hint.bubble?.edge === 'top' ? hintCover : 0)
  const bottom = Math.max(cover.bottom, hint.bubble?.edge === 'bottom' ? hintCover : 0)

  useEffect(() => {
    const prev = coverBandStore.get()
    if (prev.top !== top || prev.bottom !== bottom) coverBandStore.set({ top, bottom })
  }, [top, bottom])
  // Leaving the phone layout takes the cover with it.
  useEffect(() => () => coverBandStore.set({ top: 0, bottom: 0 }), [])

  if (toasts.length === 0 && cards.length === 0 && banners.length === 0 && !hint.bubble) {
    return null
  }
  return (
    <div className="zen-message-layer" data-surface="page">
      {hint.bubble && (
        <HintBubbleCard bubble={hint.bubble} leaving={hint.leaving} onMeasure={measureHint} />
      )}
      {banners.length > 0 && (
        <div ref={stackRefs} className="zen-message-stack" style={{ height: stackHeight }}>
          {banners.map((b, i) => (
            <BannerCard
              key={b.id}
              banner={b}
              slot={y[i] ?? 0}
              stackTop={i === 0}
              stackBottom={i === banners.length - 1}
              onMeasure={measure}
              onTravel={travel}
            />
          ))}
        </div>
      )}
      {(toasts.length > 0 || cards.length > 0) && (
        <div ref={bindToasts} className="zen-message-toasts">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onMeasure={measure} />
          ))}
          {cards.map((c) => (
            <ScreenshotCard key={`shot-${c.id}`} card={c} onMeasure={measure} />
          ))}
        </div>
      )}
    </div>
  )
}

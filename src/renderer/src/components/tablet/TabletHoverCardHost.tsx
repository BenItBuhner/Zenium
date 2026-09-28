import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import {
  bindHoverCardDismissals,
  hostHoverCard,
  hoverCard,
  hoverCardNativeHost,
  nativeHoverCard
} from '@renderer/lib/hoverCard'
import { subscribePopovers } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { HOVER_CARD_HIDDEN, overlayCoversContent, uiStore } from '@renderer/lib/ui'

/**
 * The tablet chrome's host for the tab hover card (TABLET-05; Chrome's tablet strip card). On
 * Android the pages are layered above the chrome's WebView, so the card is the host's –
 * `Host.kt` draws `TabHoverCardView` where `lib/hoverCard.ts` says, above the live page and
 * under the fullscreen layer, in the desktop card's form (§9.20's panel at §9.31's numbers; the
 * lead's ruling: parity wins the card, §9.31 wins its form, the route is native). This
 * component is what lets the rows raise one: it counts itself as the card's host
 * (`hostHoverCard`) only where a native host is registered (Android's `boot.ts`; the desktop at
 * `?formFactor=tablet` registers none and keeps raising nothing, as before), and it binds the
 * desktop card's dismissals for as long as a card is up – a press, a wheel, a scroll, a key,
 * the window's blur or resize (`bindHoverCardDismissals`), another tab coming to the front, a
 * drag or other chrome over the page, a popover opening (as `TabHoverCard` does).
 *
 * It renders nothing. The card's text for the focused row (`TabItem`'s `aria-describedby`) is
 * not this host's to keep: the desktop class of the chrome raises the native card too, through
 * `TabHoverCard`, so the description has one home for every layout – Android's root
 * (`NativeHoverCardDescription`, src/android/main.tsx).
 */
export function TabletHoverCardHost({ state }: { state: UIState }): null {
  useEffect(() => (hoverCardNativeHost() ? hostHoverCard() : undefined), [])

  const shown = nativeHoverCard.use((s) => s.card.tabId !== null)
  const drag = uiStore.use((s) => s.drag !== null)
  const covered = uiStore.use((s) => overlayCoversContent({ ...s, hoverCard: HOVER_CARD_HIDDEN }))
  const activeTabId = activeTab(state)?.id ?? null

  useEffect(() => {
    hoverCard.hide()
  }, [activeTabId])
  useEffect(() => {
    if (drag || covered) hoverCard.hide()
  }, [drag, covered])
  useEffect(
    () =>
      subscribePopovers((change) => {
        if (change === 'open' || change === 'all') hoverCard.hide()
      }),
    []
  )
  useEffect(() => {
    if (!shown) return
    return bindHoverCardDismissals(() => hoverCard.hide())
  }, [shown])

  return null
}

import { useEffect, type ReactElement } from 'react'
import type { UIState } from '@shared/types'
import {
  bindHoverCardDismissals,
  domHoverCardHosted,
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
 * It draws nothing a sighted user sees. While the native card stands it keeps the card's text –
 * the title, the host, the state lines, as the desktop card renders them – in the chrome's
 * document as a visually hidden node under the desktop card's id, so the focused row describes
 * itself by it (`TabItem`'s `aria-describedby`, `useHoverCardUp`) exactly as a desktop row does
 * by the DOM card; the native layer stays `NO_HIDE_DESCENDANTS`, so nothing speaks twice. One
 * `#zen-tab-hover-card` per document: the node is rendered only where a native host is
 * registered and the chrome's own card is not mounted (`domHoverCardHosted`) – where it is, the
 * id is the DOM card's.
 */
export function TabletHoverCardHost({ state }: { state: UIState }): ReactElement | null {
  useEffect(() => (hoverCardNativeHost() ? hostHoverCard('native') : undefined), [])

  const shown = nativeHoverCard.use((s) => s.card.tabId !== null)
  const frame = nativeHoverCard.use((s) => s.frame)
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

  if (!shown || !frame || !hoverCardNativeHost() || domHoverCardHosted()) return null
  return (
    <div id="zen-tab-hover-card" role="tooltip" className="sr-only" data-tab-id={frame.tabId}>
      <div>{frame.title}</div>
      {frame.host && <div>{frame.host}</div>}
      {frame.lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  )
}

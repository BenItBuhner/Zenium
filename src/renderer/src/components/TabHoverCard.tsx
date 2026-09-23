import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { hoverCard, hoverCardHost, placeHoverCard } from '@renderer/lib/hoverCard'
import {
  ChromePortal,
  POPOVER_WIDTH,
  popoverStyle,
  subscribePopovers,
  viewportSize,
  type PopoverBox
} from '@renderer/lib/portals'
import { activeTab, tabStateLines, tabTitle } from '@renderer/lib/selectors'
import { HOVER_CARD_HIDDEN, overlayCoversContent, uiStore } from '@renderer/lib/ui'

/**
 * The tab hover card (design-language-v2-draft §9.20; tabs-04, BUG-004): a 320 popover flush
 * against the sidebar's edge and start-aligned with its row, with the row's full title on two
 * lines at most and the page's host under it, then the state lines the row's tooltip used to
 * carry. Shown by lib/hoverCard.ts after the pointer rests on a row or when keyboard focus
 * lands on one; one at a time; it never takes the pointer. Any press, a drag, a scroll,
 * Escape, the window losing focus, another tab coming to the front, or a popover, menu or
 * dialog opening takes it down.
 */
export function TabHoverCard({ state }: { state: UIState }): JSX.Element | null {
  const card = uiStore.use((s) => s.hoverCard)
  const drag = uiStore.use((s) => s.drag !== null)
  // Other chrome over the page – the URL bar, a menu, an overlay, a prompt, a bubble: the card
  // is not shown beside it (§9.20, one at a time) and goes the moment it opens.
  const covered = uiStore.use((s) => overlayCoversContent({ ...s, hoverCard: HOVER_CARD_HIDDEN }))
  const tab = card.tabId ? state.tabs[card.tabId] : undefined
  const agent = tab ? (state.agents.find((a) => a.tabIds.includes(tab.id)) ?? null) : null
  const shown = Boolean(tab && card.anchor && card.sidebar && !drag && !covered)
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)

  const title = tab ? tabTitle(tab) : ''
  const host = tab ? hoverCardHost(tab.url) : ''
  const lines = tab ? tabStateLines(tab, agent?.name ?? null) : []
  const stateText = lines.join('\n')

  // The card's own size decides where it fits; measured once it has rendered its text, at the
  // height its content wants (a height cap from the last placement is lifted for the reading).
  useLayoutEffect(() => {
    const el = ref.current
    if (!shown || !el || !card.anchor || !card.sidebar) {
      setBox(null)
      return
    }
    const capped = el.style.maxHeight
    el.style.maxHeight = 'none'
    const size = { width: el.offsetWidth, height: el.offsetHeight }
    el.style.maxHeight = capped
    setBox(placeHoverCard(card.anchor, card.sidebar, viewportSize(), size, card.axis))
  }, [shown, card.anchor, card.sidebar, card.axis, title, host, stateText])

  // The page behind the card is a capture of the active tab; another tab coming to the front
  // (Enter on a focused row, a shortcut) would leave the frame blank under it. A drag (its own
  // press took the card down; one relayed from another window did not) has the sidebar.
  const activeTabId = activeTab(state)?.id ?? null
  useEffect(() => {
    hoverCard.hide()
  }, [activeTabId])
  useEffect(() => {
    if (drag || covered) hoverCard.hide()
  }, [drag, covered])

  // A popover registering with the chrome layer (the star bubble on Ctrl+D, a bar folder
  // panel, the zoom bubble), or a frame dialog opening over the page (it clears the layer):
  // the card goes at once, whether it is up or on its way.
  useEffect(
    () =>
      subscribePopovers((change) => {
        if (change === 'open' || change === 'all') hoverCard.hide()
      }),
    []
  )

  useEffect(() => {
    if (!shown) return
    const hide = (): void => hoverCard.hide()
    // Escape, and typing: the page under the card had the keyboard until the card hid it (see
    // lib/hoverCard.ts), so a letter means the user is back at the page. Arrows, Tab and Enter
    // are the rows' own keys and move or activate instead.
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete' || typing) hide()
    }
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('contextmenu', hide, true)
    document.addEventListener('wheel', hide, { capture: true, passive: true })
    document.addEventListener('scroll', hide, { capture: true, passive: true })
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('contextmenu', hide, true)
      document.removeEventListener('wheel', hide, { capture: true })
      document.removeEventListener('scroll', hide, { capture: true })
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [shown])

  if (!shown || !tab) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        id="zen-tab-hover-card"
        role="tooltip"
        className="zen-tab-hover-card zen-animate-pop"
        data-tab-id={tab.id}
        data-side={box?.side}
        style={{
          width: POPOVER_WIDTH.list,
          ...(box ? popoverStyle(box) : { left: 0, top: 0 }),
          visibility: box ? 'visible' : 'hidden'
        }}
      >
        <div className="zen-tab-hover-card-title">{title}</div>
        {(host || lines.length > 0) && (
          <div className="zen-tab-hover-card-meta">
            {host && <div className="zen-tab-hover-card-host">{host}</div>}
            {lines.map((line) => (
              <div key={line} className="zen-tab-hover-card-host">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </ChromePortal>
  )
}

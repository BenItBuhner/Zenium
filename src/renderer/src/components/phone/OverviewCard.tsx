import type { CSSProperties, JSX } from 'react'
import { useRef } from 'react'
import { Moon, X } from 'lucide-react'
import type { Tab } from '@shared/types'
import { useOnScreen } from '@renderer/hooks/useOnScreen'
import { closeTabLabel, tabCardLabel } from '@renderer/lib/overviewLabels'
import { tabTitle } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { departStore } from './departureStore'
import { TabPreview } from './TabPreview'
import { liftStore, useCardLift, type CardLiftOptions } from './useCardLift'

/** Corner radius of a tab card; the page morphs from the content radius to this. */
export const CARD_RADIUS = 14
/**
 * How far past the grid's edges a card counts as on screen, as a share of the grid's height
 * (`useOnScreen` measures from the card's scroller): about a row of cards, so the pictures of
 * the next row are read before it scrolls in and the rest of the grid's cards hold none
 * (`lib/thumbnails.ts`). At 412 x 915 that is the rows in view plus one above and one below –
 * 10 to 14 cards of a 200-tab session, 18 to 25 MB counted (the preview host's numbers).
 */
const CARD_LOOKAHEAD = '35% 0px'

interface Props {
  tab: Tab
  active: boolean
  /**
   * The card's place among the pane's tabs, for what TalkBack says of it ("tab 2 of 7",
   * `tabCardLabel`): 1-based, in the grid's order.
   */
  position: number
  count: number
  /** The hero stands in for this card while the page morphs into it. */
  hidden: boolean
  onPick: (tab: Tab) => void
  /** The card's close button – absent, the card shows none. */
  onClose?: (tab: Tab) => void
  /** The card was swiped off the grid (it is out of sight already): close its tab. */
  onSwipeClose?: (tab: Tab) => void
  lift: Omit<CardLiftOptions, 'tab' | 'onSwipeClose'>
}

/**
 * One tab in the overview grid: title row above the thumbnail. Tap to switch to it; hold to pick
 * it up, swipe it sideways to close it (see `useCardLift`). While it is in the hand the slot
 * shows a faint stand-in, and a card that another card is about to be dropped on tucks itself in
 * a little. The outer box is the grid's cell, keyed by the tab id for the glide and the morph.
 * A card holds its tab's picture only while its cell is on screen or a row from it: the grid
 * is not virtualised, its pictures are.
 */
export function OverviewCard({
  tab,
  active,
  position,
  count,
  hidden,
  onPick,
  onClose,
  onSwipeClose,
  lift
}: Props): JSX.Element {
  const handlers = useCardLift({ tab, ...lift, onSwipeClose: (t) => onSwipeClose?.(t) })
  const held = liftStore.use((s) => (s.tabId === tab.id ? s.phase : 'idle'))
  const targeted = liftStore.use((s) => s.phase === 'dragging' && s.target === `card:${tab.id}`)
  const departing = departStore.use((s) => s.hidden.has(tab.id))
  const cellRef = useRef<HTMLDivElement>(null)
  const visible = useOnScreen(cellRef, CARD_LOOKAHEAD)
  const style: CSSProperties = {}
  if (hidden || departing || held === 'dropping') style.opacity = 0
  else if (held !== 'idle') style.opacity = 0.35
  return (
    <div
      ref={cellRef}
      className="relative"
      style={{ aspectRatio: '3 / 4' }}
      data-tab-id={tab.id}
      data-cell={tab.id}
    >
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'zen-overview-card absolute inset-0 flex flex-col overflow-hidden',
          targeted && 'zen-overview-card-target'
        )}
        data-active={active}
        data-discarded={tab.discarded || undefined}
        style={style}
        aria-label={tabCardLabel(tabTitle(tab), position, count, active, tab.discarded === true)}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (!handlers.swallowsClick()) onPick(tab)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onPick(tab)
        }}
      >
        <CardBody tab={tab} closable={onClose ? 'space' : false} visible={visible} />
      </div>
      {/*
        The close sits beside the card's button, not inside it: this WebView reads a focusable,
        named node as one leaf and drops a button nested in it from the tree (A11Y-01, the device
        driver's run 1), so a nested Close was never a TalkBack stop. It is laid over the header's
        end, the 44 the body keeps clear for it, and looks the same as the ghost's drawn one.
      */}
      {onClose && (
        <button
          type="button"
          className="zen-toolbar-button zen-overview-card-close absolute right-0 top-0 h-8 w-8 rounded-[10px]"
          style={style}
          aria-label={closeTabLabel(tabTitle(tab))}
          onClick={(e) => {
            e.stopPropagation()
            onClose(tab)
          }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/**
 * Title row and thumbnail – shared with the ghost of a card in the hand and a card on its way
 * out, which show the close button (so the card looks the same) without it doing anything.
 * `visible` is the grid's word on whether the card is on screen (a ghost always is).
 */
export function CardBody({
  tab,
  closable = true,
  visible = true
}: {
  tab: Tab
  /**
   * `true` draws a close glyph that does nothing (a ghost, a departing card); `'space'` keeps the
   * glyph's 44 clear for the real button `OverviewCard` lays over it; `false` gives the row to
   * the title.
   */
  closable?: boolean | 'space'
  visible?: boolean
}): JSX.Element {
  return (
    <>
      {/*
        The close is the phone's 44 icon button (§9.3, main.css's phone rule on
        `.zen-toolbar-button`), flush with the card's edge so the whole box stays inside the
        card's clip; the row is its 44 (`CARD_HEADER`, §9.21), drawn from
        `--zen-overview-card-header` so it grows with the system font size (A11Y-05).
      */}
      <header className="zen-overview-card-header flex shrink-0 items-center gap-2 pl-3 pr-0">
        <span className="zen-overview-card-favicon flex shrink-0">
          <Favicon tab={tab} size={16} />
        </span>
        <span className="zen-overview-card-title min-w-0 flex-1 truncate text-[13px] font-medium">
          {tabTitle(tab)}
        </span>
        {tab.discarded && (
          // A sleeping page (CT-22): the moon the sidebar's row shows, at the deemphasised
          // 69% with the title, 16 like the favicon and the close glyph beside it (§9.3); the
          // card's own tap wakes the page, so the glyph is a mark.
          <Moon
            className="zen-overview-card-sleeping h-4 w-4 shrink-0"
            aria-hidden
            data-sleeping=""
          />
        )}
        {closable === true && (
          <span aria-hidden className="zen-toolbar-button h-8 w-8 rounded-[10px]">
            <X className="h-4 w-4" />
          </span>
        )}
        {closable === 'space' && (
          <span aria-hidden className="zen-toolbar-button zen-overview-card-close-space h-8 w-8" />
        )}
      </header>
      <div className="zen-overview-card-preview relative min-h-0 flex-1 overflow-hidden">
        <TabPreview tab={tab} scale={0.8} visible={visible} />
      </div>
    </>
  )
}

import type { CSSProperties, JSX } from 'react'
import { useRef } from 'react'
import { Moon, VenetianMask, X } from 'lucide-react'
import type { Tab } from '@shared/types'
import { useOnScreen } from '@renderer/hooks/useOnScreen'
import { PRIVATE_TAB_PLACEHOLDER, useTabMasked } from '@renderer/lib/privateLock'
import { tabTitle } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { departStore } from './departureStore'
import { TabPreview } from './TabPreview'
import { liftStore, useCardLift, type CardLiftOptions } from './useCardLift'

/** Corner radius of a tab card; the page morphs from the content radius to this. */
export const CARD_RADIUS = 14
/** Height of a card's title row. */
export const CARD_HEADER = 40
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
  // A locked private tab's card is named the placeholder, as its title row reads (§9.19).
  const masked = useTabMasked(tab)
  const name = masked ? PRIVATE_TAB_PLACEHOLDER : tabTitle(tab)
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
        data-masked={masked || undefined}
        style={style}
        aria-label={tab.discarded ? `${name} – sleeping` : name}
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
        <CardBody tab={tab} closable={Boolean(onClose)} onClose={onClose} visible={visible} />
      </div>
    </div>
  )
}

/**
 * Title row and thumbnail – shared with the ghost of a card in the hand and a card on its way
 * out, which show the close button (so the card looks the same) without it doing anything.
 * `visible` is the grid's word on whether the card is on screen (a ghost always is). A locked
 * private tab's row reads "Private tab" behind the mask in place of its favicon and title
 * (`useTabMasked`, §9.19), as the pill does; its picture is masked by `TabPreview`.
 */
export function CardBody({
  tab,
  closable = true,
  onClose,
  visible = true
}: {
  tab: Tab
  closable?: boolean
  onClose?: (tab: Tab) => void
  visible?: boolean
}): JSX.Element {
  const masked = useTabMasked(tab)
  return (
    <>
      <header
        className="flex shrink-0 items-center gap-2 pl-3 pr-1"
        style={{ height: CARD_HEADER }}
      >
        <span className="zen-overview-card-favicon flex shrink-0">
          {masked ? (
            <VenetianMask className="h-4 w-4 opacity-60" strokeWidth={1.75} aria-hidden />
          ) : (
            <Favicon tab={tab} size={16} />
          )}
        </span>
        <span className="zen-overview-card-title min-w-0 flex-1 truncate text-[13px] font-medium">
          {masked ? PRIVATE_TAB_PLACEHOLDER : tabTitle(tab)}
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
        {closable && (
          <button
            type="button"
            className="zen-toolbar-button h-8 w-8 rounded-[10px]"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose?.(tab)
            }}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </header>
      <div className="zen-overview-card-preview relative min-h-0 flex-1 overflow-hidden">
        <TabPreview tab={tab} scale={0.8} visible={visible} />
      </div>
    </>
  )
}

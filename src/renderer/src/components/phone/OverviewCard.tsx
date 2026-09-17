import type { CSSProperties, JSX } from 'react'
import { X } from 'lucide-react'
import type { Tab } from '@shared/types'
import { tabTitle } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { departStore } from './departures'
import { TabPreview } from './TabPreview'
import { liftStore, useCardLift, type CardLiftOptions } from './useCardLift'

/** Corner radius of a tab card; the page morphs from the content radius to this. */
export const CARD_RADIUS = 14
/** Height of a card's title row. */
export const CARD_HEADER = 40

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
  ref: (el: HTMLDivElement | null) => void
}

/**
 * One tab in the overview grid: title row above the thumbnail. Tap to switch to it; hold to pick
 * it up, swipe it sideways to close it (see `useCardLift`). While it is in the hand the slot
 * shows a faint stand-in, and a card that another card is about to be dropped on tucks itself in
 * a little.
 */
export function OverviewCard({
  tab,
  active,
  hidden,
  onPick,
  onClose,
  onSwipeClose,
  lift,
  ref
}: Props): JSX.Element {
  const handlers = useCardLift({ tab, ...lift, onSwipeClose: (t) => onSwipeClose?.(t) })
  const held = liftStore.use((s) => (s.tabId === tab.id ? s.phase : 'idle'))
  const targeted = liftStore.use((s) => s.phase === 'dragging' && s.target === `card:${tab.id}`)
  const departing = departStore.use((s) => s.hidden.has(tab.id))
  const style: CSSProperties = {}
  if (hidden || departing || held === 'dropping') style.opacity = 0
  else if (held !== 'idle') style.opacity = 0.35
  return (
    <div ref={ref} className="relative" style={{ aspectRatio: '3 / 4' }} data-tab-id={tab.id}>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'zen-overview-card absolute inset-0 flex flex-col overflow-hidden',
          targeted && 'zen-overview-card-target'
        )}
        data-active={active}
        style={style}
        aria-label={tabTitle(tab)}
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
        <CardBody tab={tab} closable={Boolean(onClose)} onClose={onClose} />
      </div>
    </div>
  )
}

/**
 * Title row and thumbnail – shared with the ghost of a card in the hand and a card on its way
 * out, which show the close button (so the card looks the same) without it doing anything.
 */
export function CardBody({
  tab,
  closable = true,
  onClose
}: {
  tab: Tab
  closable?: boolean
  onClose?: (tab: Tab) => void
}): JSX.Element {
  return (
    <>
      <header
        className="flex shrink-0 items-center gap-2 pl-3 pr-1"
        style={{ height: CARD_HEADER }}
      >
        <Favicon tab={tab} size={16} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tabTitle(tab)}</span>
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
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TabPreview tab={tab} scale={0.8} />
      </div>
    </>
  )
}

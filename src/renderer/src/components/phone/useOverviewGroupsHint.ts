import { useEffect, useRef, type RefObject } from 'react'
import type { UIState } from '@shared/types'
import type { OverviewState } from '@renderer/lib/gestures/stage'
import {
  dismissHintBubble,
  forgetHintBubble,
  hintBubbleStore,
  hintBubbleTabId,
  markTabGroupsDragHintShown,
  overviewGroupsHintDue,
  showHintBubble,
  spendIphSession,
  TAB_GROUPS_DRAG_HINT_TEXT,
  tabGroupsDragRecord,
  takeOverviewGroupsHintRequest
} from '@renderer/lib/iph'
import { liftStore } from './useCardLift'

interface Input {
  state: UIState
  overview: OverviewState
  /**
   * The cards the bubble may stand on, the one to prefer first (`overviewHintCandidates`): the
   * first whose cell the grid holds in view (`cellInView`) is the anchor. Empty with none – a
   * Private or Groups pane, a grid of groups only, the tablet's overview.
   */
  candidates: readonly string[]
  /** The grid's scroller: the candidates' cells, and the view they are in, are read from it. */
  grid: RefObject<HTMLDivElement | null>
}

/** A card of the Tabs pane's loose run, in grid order: its tab, and whether it is a page's. */
export interface HintCard {
  id: string
  /** A page's card – not the new tab page's (`isEmptyTabUrl`), which the bubble never stands on. */
  page: boolean
}

/** The two edges of a box along the grid's scroll: a `DOMRect` fits. */
export interface CellSpan {
  top: number
  bottom: number
}

/**
 * The cards the bubble may stand on, the one to prefer first (the design lead's fold on #701):
 * the loose PAGE card nearest the active card – at each distance the cell BEFORE it in grid
 * order, then the one AFTER – and the active card itself last, only when it is a loose page
 * card, for a grid with no other page card in view. Never the new tab page's card: the tip's
 * "Try it now" left it, the page the finger came from, and a blank card teaches nothing of the
 * gesture – the pages beside it are what a hand would group. With no active card among the
 * loose ones (a pinned or grouped tab active, none active), the page cards from the first.
 * Which of these is in view is the grid's to say, as the bubble goes up (`cellInView`).
 */
export function overviewHintCandidates(
  cards: readonly HintCard[],
  activeId: string | null
): string[] {
  const pageAt = (i: number): string[] => {
    const card = cards[i]
    return card?.page ? [card.id] : []
  }
  const at = activeId === null ? -1 : cards.findIndex((c) => c.id === activeId)
  if (at < 0) return cards.filter((c) => c.page).map((c) => c.id)
  const out: string[] = []
  for (let d = 1; d < cards.length; d++) out.push(...pageAt(at - d), ...pageAt(at + d))
  return [...out, ...pageAt(at)]
}

/**
 * Whether a cell is in the grid's view: more than half its height inside the scroller's box. A
 * card cut at the grid's edge is not one to point at – the bubble stands flush under or over it
 * (§9.20), and half a card says little of where the finger should land.
 */
export function cellInView(cell: CellSpan, view: CellSpan): boolean {
  const seen = Math.min(cell.bottom, view.bottom) - Math.max(cell.top, view.top)
  return seen > (cell.bottom - cell.top) / 2
}

/**
 * The first candidate whose cell the grid holds in view, with the cell's box; null with none.
 * The layout reads happen here, once, as the bubble goes up: the grid's box, then a cell's per
 * candidate until one is in view – the nearest card to the active one is all but always the
 * first, so two reads.
 */
function anchorCell(
  grid: HTMLElement | null,
  ids: readonly string[]
): { id: string; rect: DOMRect } | null {
  if (!grid || ids.length === 0) return null
  const view = grid.getBoundingClientRect()
  for (const id of ids) {
    const cell = grid.querySelector<HTMLElement>(`[data-cell="${id}"]`)
    if (!cell) continue
    const rect = cell.getBoundingClientRect()
    if (cellInView(rect, view)) return { id, rect }
  }
  return null
}

/**
 * The overview's drag-to-group in-product help (TB-19, the tips card's seed): the §9.33 hint
 * bubble that stands in for Chrome's drag-and-drop IPH dialog when the Zenium tips card's
 * "Try it now" opens the overview (#695; Chrome: `ChromeTabbedActivity.java` l.3500–3508 shows
 * the Hub and `TabGridIphDialogCoordinator.showIph()`). The rule is `overviewGroupsHintDue`
 * (`lib/iph.ts`): asked for by the tip – the request `MagicStack.tsx` leaves as it calls
 * `openOverview`, taken here as the overview comes to rest – the record unspent, a loose page
 * card in view to point at (`overviewHintCandidates`, `cellInView`: the one nearest the active
 * card, before it in grid order, else after; the active card itself only when no other page
 * card is in view; never the new tab page's card). It goes up once the overview is OPEN (the
 * settle done, the cards in their slots), not while it is heading there: the anchor's box is
 * read once, and read where the card will stay. A request the overview never rests on – closed
 * on its way, or resting with no card to point at – is dropped, not kept for the next opening:
 * Chrome's dialog is the tap's, not owed.
 *
 * How it goes down (§9.33 – the first touch anywhere takes it down and passes through; Chrome's
 * dialog cancels on a touch outside): a `pointerdown` anywhere, heard in the capture phase and
 * not swallowed – a tap on a card picks the tab as it would, the hold that starts the drag it
 * teaches begins with the same down; the drag itself, belt and braces (`liftStore` leaving
 * idle); the overview leaving its rest – a close, the predictive back's drag, a tab picked from
 * the keyboard – so the bubble goes with the overview; a resize (rotation); the overview
 * unmounting. No clock (Chrome's `NO_TIMEOUT`). The bubble takes the session's one education as
 * it goes up: the Tabs button's bubble is not owed in the minutes after a teaching.
 */
export function useOverviewGroupsHint({ state, overview, candidates, grid }: Input): void {
  const open = overview.phase === 'open'
  const { settings } = state
  const { shown } = tabGroupsDragRecord(settings)
  // The candidates as one key: the grid builds the list anew each render, and the effect below
  // is the list's contents', not the array's.
  const key = candidates.join('\n')

  // The request is taken as the overview comes to rest, and dropped with an overview that goes
  // before resting (the flag would otherwise wait for an opening the tip did not ask for).
  const fromTip = useRef(false)
  useEffect(() => {
    if (open) fromTip.current = takeOverviewGroupsHintRequest()
    else if (overview.phase === 'closed') {
      takeOverviewGroupsHintRequest()
      fromTip.current = false
    }
  }, [open, overview.phase])

  // Due → up, once: the layout reads are the anchor's (`anchorCell`), as the bubble goes up.
  useEffect(() => {
    if (!open || !fromTip.current || hintBubbleStore.get().bubble) return
    const anchor = anchorCell(grid.current, key ? key.split('\n') : [])
    const due = overviewGroupsHintDue({
      settings,
      fromTip: fromTip.current,
      open,
      hasAnchor: anchor !== null
    })
    fromTip.current = false
    if (!due || !anchor) return
    const r = anchor.rect
    spendIphSession()
    showHintBubble({
      id: 'tabGroupsDragAndDrop',
      at: 'overview',
      tabId: anchor.id,
      anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
      text: TAB_GROUPS_DRAG_HINT_TEXT
    })
    markTabGroupsDragHintShown(settings)
  }, [open, key, grid, settings, shown])

  // The overview leaving its rest, or the first drag, takes the bubble down.
  const up = hintBubbleStore.use((s) => hintBubbleTabId(s.bubble) !== null && !s.leaving)
  const lifted = liftStore.use((s) => s.phase !== 'idle')
  useEffect(() => {
    if (!up) return
    if (!open || lifted) dismissHintBubble()
  }, [up, open, lifted])

  // A touch anywhere, or the window changing size.
  useEffect(() => {
    if (!up) return
    const down = (): void => dismissHintBubble()
    document.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('resize', down)
    return () => {
      document.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('resize', down)
    }
  }, [up])

  // The overview unmounting takes its bubble with it (never another's).
  useEffect(
    () => () => {
      if (hintBubbleTabId(hintBubbleStore.get().bubble) !== null) forgetHintBubble()
    },
    []
  )
}

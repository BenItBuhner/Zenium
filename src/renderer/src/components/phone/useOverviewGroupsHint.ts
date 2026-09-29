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
   * The card the bubble points at: the Tabs pane's active card when it is a loose tab (the one
   * the page just morphed into, in view by that fact), else the first loose card; null with none
   * – a Private or Groups pane, a grid of groups only, the tablet's overview.
   */
  anchorTabId: string | null
  /** The grid's scroller: the anchor's cell is read from it. */
  grid: RefObject<HTMLDivElement | null>
}

/**
 * The overview's drag-to-group in-product help (TB-19, the tips card's seed): the §9.33 hint
 * bubble that stands in for Chrome's drag-and-drop IPH dialog when the Zenium tips card's
 * "Try it now" opens the overview (#695; Chrome: `ChromeTabbedActivity.java` l.3500–3508 shows
 * the Hub and `TabGridIphDialogCoordinator.showIph()`). The rule is `overviewGroupsHintDue`
 * (`lib/iph.ts`): asked for by the tip – the request `MagicStack.tsx` leaves as it calls
 * `openOverview`, taken here as the overview comes to rest – the record unspent, a loose card to
 * point at. It goes up once the overview is OPEN (the settle done, the cards in their slots),
 * not while it is heading there: the anchor's box is read once, and read where the card will
 * stay. A request the overview never rests on – closed on its way, or resting with no card to
 * point at – is dropped, not kept for the next opening: Chrome's dialog is the tap's, not owed.
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
export function useOverviewGroupsHint({ state, overview, anchorTabId, grid }: Input): void {
  const open = overview.phase === 'open'
  const { settings } = state
  const { shown } = tabGroupsDragRecord(settings)

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

  // Due → up, once: the one layout read is the anchor cell's box, as the bubble goes up.
  useEffect(() => {
    if (!open || !fromTip.current || hintBubbleStore.get().bubble) return
    const cell = anchorTabId
      ? grid.current?.querySelector<HTMLElement>(`[data-cell="${anchorTabId}"]`)
      : null
    const due = overviewGroupsHintDue({
      settings,
      fromTip: fromTip.current,
      open,
      hasAnchor: Boolean(cell)
    })
    fromTip.current = false
    if (!due || !cell || !anchorTabId) return
    const r = cell.getBoundingClientRect()
    spendIphSession()
    showHintBubble({
      id: 'tabGroupsDragAndDrop',
      at: 'overview',
      tabId: anchorTabId,
      anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
      text: TAB_GROUPS_DRAG_HINT_TEXT
    })
    markTabGroupsDragHintShown(settings)
  }, [open, anchorTabId, grid, settings, shown])

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

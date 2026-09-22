import type { JSX } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { stageStore, type OverviewState, type StageState } from '@renderer/lib/gestures/stage'
import { contentAreaStore } from '@renderer/lib/ui'
import { TabOverview } from './TabOverview'
import { TabSwitchStage } from './TabSwitchStage'

/**
 * The overview's state as the tree reads it: its phase, its hero, where it is heading, and
 * whether the morph is still short of open (the hero stands in for its card until then). Its
 * `progress` moves on every frame of a pull and of the spring, and the grid follows it from the
 * store without a render up here (`TabOverview`'s morph effect writes the frame), so the
 * selector answers the same object for as long as those four read the same – the progress in
 * it is the one they last changed at.
 */
let overviewShape: OverviewState | null = null
function selectOverview(s: StageState): OverviewState {
  const o = s.overview
  const c = overviewShape
  if (
    c &&
    c.phase === o.phase &&
    c.heroTabId === o.heroTabId &&
    c.target === o.target &&
    c.progress < 1 === o.progress < 1
  )
    return c
  overviewShape = o
  return o
}

/**
 * Hosts the gesture stage of the touch layouts over the window: the tab track while a sideways
 * swipe is in flight and the tab overview while it is being pulled in, open, or pushed away.
 * Everything in here draws where the live page was; the layout reporter hides the page views
 * for as long as `uiStore.stageActive` says so.
 *
 * The stage's state is the store's, not this component's: the phone and the tablet shell each
 * mount their own `PhoneStage`, and a window resized from the one layout into the other swaps
 * shells with the overview still open (TABLET-08). Only the desktop layout dismisses the stage
 * (`App`'s `useStageContinuity`).
 *
 * `edge` is the bar's edge, whose band the overview keeps clear: the phone's bar position, the
 * tablet's toolbar at the top.
 */
export function PhoneStage({
  state,
  edge = state.settings.phoneBarPosition
}: {
  state: UIState
  edge?: PhoneBarPosition
}): JSX.Element | null {
  // The track's phase alone: its position moves every frame of a swipe and is the track's own
  // business (`TabSwitchStage` follows it from the store without a render up here); the
  // overview's shape alone, its progress the overview's own the same way.
  const tabsPhase = stageStore.use((s) => s.tabs.phase)
  const overview = stageStore.use(selectOverview)
  const area = contentAreaStore.use((s) => s.area)

  if (!area || (tabsPhase === 'idle' && overview.phase === 'closed')) return null
  return (
    <div className="absolute inset-0 z-20">
      {tabsPhase !== 'idle' && <TabSwitchStage state={state} area={area} />}
      {overview.phase !== 'closed' && (
        <TabOverview state={state} overview={overview} area={area} edge={edge} />
      )}
    </div>
  )
}

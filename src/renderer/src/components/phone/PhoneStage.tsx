import type { JSX } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { stageStore } from '@renderer/lib/gestures/stage'
import { contentAreaStore } from '@renderer/lib/ui'
import { TabOverview } from './TabOverview'
import { TabSwitchStage } from './TabSwitchStage'

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
  const tabs = stageStore.use((s) => s.tabs)
  const overview = stageStore.use((s) => s.overview)
  const area = contentAreaStore.use((s) => s.area)

  if (!area || (tabs.phase === 'idle' && overview.phase === 'closed')) return null
  return (
    <div className="absolute inset-0 z-20">
      {tabs.phase !== 'idle' && <TabSwitchStage state={state} tabs={tabs} area={area} />}
      {overview.phase !== 'closed' && (
        <TabOverview state={state} overview={overview} area={area} edge={edge} />
      )}
    </div>
  )
}

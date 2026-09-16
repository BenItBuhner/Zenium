import type { JSX } from 'react'
import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import { dismissStage, stageStore } from '@renderer/lib/gestures/stage'
import { contentAreaStore } from '@renderer/lib/ui'
import { TabOverview } from './TabOverview'
import { TabSwitchStage } from './TabSwitchStage'

/**
 * Hosts the gesture stage of the phone layout over the window: the tab track while a sideways
 * swipe is in flight and the tab overview while it is being pulled in, open, or pushed away.
 * Everything in here draws where the live page was; the layout reporter hides the page views
 * for as long as `uiStore.stageActive` says so.
 */
export function PhoneStage({ state }: { state: UIState }): JSX.Element | null {
  const tabs = stageStore.use((s) => s.tabs)
  const overview = stageStore.use((s) => s.overview)
  const area = contentAreaStore.use((s) => s.area)

  // Leaving the phone layout (rotation, DeX) takes the stage down with it.
  useEffect(() => () => dismissStage(), [])

  if (!area || (tabs.phase === 'idle' && overview.phase === 'closed')) return null
  return (
    <div className="absolute inset-0 z-20">
      {tabs.phase !== 'idle' && <TabSwitchStage state={state} tabs={tabs} area={area} />}
      {overview.phase !== 'closed' && <TabOverview state={state} overview={overview} area={area} />}
    </div>
  )
}

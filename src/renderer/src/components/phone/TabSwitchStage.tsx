import type { CSSProperties, JSX } from 'react'
import type { Rect, UIState } from '@shared/types'
import type { TabSwitchState } from '@renderer/lib/gestures/stage'
import { groupColorChannels, groupOf } from '@renderer/lib/groups'
import { activeTab } from '@renderer/lib/selectors'
import { TabPreview } from './TabPreview'

interface Props {
  state: UIState
  tabs: TabSwitchState
  /** Where the page normally is, in window coordinates. */
  area: Rect
}

/**
 * The tab track during a sideways swipe: every tab is a card the size of the page, laid out
 * side by side and moved as one with the finger. Cards leaving the centre shrink a little and
 * dim, so depth tells you which one you are about to land on. Tabs of a group sit next to each
 * other on the track and wear the group's name along their top edge while the track is moving.
 * Every card is page-sized, so each paints the full cover of its tab when the chrome has one
 * (`sharp`: the last few tabs a gesture left) and the card picture scaled up otherwise.
 */
export function TabSwitchStage({ state, tabs, area }: Props): JSX.Element {
  const { order, position, advance, origin } = tabs
  const first = Math.max(0, Math.floor(position) - 1)
  const last = Math.min(order.length - 1, Math.ceil(position) + 1)
  // The ribbon has nothing to add to a page that is at rest: it fades in with the movement.
  const moving = Math.min(1, Math.abs(position - origin) * 2.5)
  // The current tab's card is what the live page is swapped for when the track appears.
  const current = activeTab(state)?.id ?? null
  const cards: JSX.Element[] = []
  for (let index = first; index <= last; index++) {
    const tab = state.tabs[order[index]]
    if (!tab) continue
    const offset = index - position
    const distance = Math.min(1, Math.abs(offset))
    const group = groupOf(state, tab)
    cards.push(
      <div
        key={tab.id}
        className="zen-stage-card absolute"
        style={{
          left: area.x,
          top: area.y,
          width: area.width,
          height: area.height,
          transform: `translate3d(${offset * advance}px, 0, 0) scale(${1 - 0.06 * distance})`
        }}
      >
        <TabPreview tab={tab} cover={tab.id === current} sharp />
        {group && (
          <div
            className="zen-group-ribbon absolute inset-x-0 top-0 flex h-7 items-center gap-2 px-3 text-[12px] font-semibold"
            style={
              {
                opacity: moving,
                '--zen-group-rgb': groupColorChannels(group.color)
              } as CSSProperties
            }
          >
            <span className="zen-group-dot h-2 w-2 shrink-0 rounded-full" />
            <span className="min-w-0 truncate">{group.name}</span>
          </div>
        )}
        <div className="zen-stage-dim absolute inset-0" style={{ opacity: 0.22 * distance }} />
      </div>
    )
  }
  return <div className="pointer-events-none absolute inset-0 overflow-hidden">{cards}</div>
}

import type { JSX } from 'react'
import type { Rect, UIState } from '@shared/types'
import type { TabSwitchState } from '@renderer/lib/gestures/stage'
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
 * dim, so depth tells you which one you are about to land on.
 */
export function TabSwitchStage({ state, tabs, area }: Props): JSX.Element {
  const { order, position, advance } = tabs
  const first = Math.max(0, Math.floor(position) - 1)
  const last = Math.min(order.length - 1, Math.ceil(position) + 1)
  const cards: JSX.Element[] = []
  for (let index = first; index <= last; index++) {
    const tab = state.tabs[order[index]]
    if (!tab) continue
    const offset = index - position
    const distance = Math.min(1, Math.abs(offset))
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
        <TabPreview tab={tab} />
        <div
          className="pointer-events-none absolute inset-0 bg-black"
          style={{ opacity: 0.22 * distance }}
        />
      </div>
    )
  }
  return <div className="pointer-events-none absolute inset-0 overflow-hidden">{cards}</div>
}

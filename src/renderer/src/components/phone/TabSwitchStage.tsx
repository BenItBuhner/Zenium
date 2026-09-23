import type { CSSProperties, JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import type { Rect, UIState } from '@shared/types'
import { stageStore } from '@renderer/lib/gestures/stage'
import type { TabSwitchState } from '@renderer/lib/gestures/stage'
import { type GroupColorVars, groupColorVars, groupOf } from '@renderer/lib/groups'
import { activeTab } from '@renderer/lib/selectors'
import { TabPreview } from './TabPreview'

interface Props {
  state: UIState
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
 *
 * React lays the cards out; the finger moves them without it. The track's position changes on
 * every move of the finger and every frame of the settling spring, and re-rendering three
 * page-sized cards through React for each of them was most of a swipe frame's script on the
 * phone (PERF-5's profile of the drag). So this component subscribes to the store for what
 * changes seldom – the tabs on the track, the window of cards worth mounting (which shifts as
 * the position crosses a whole card), the current tab – and each card writes its own transform
 * and its layers' opacity straight to the DOM from a store subscription of its own
 * ([StageCard]): the same writes as before, on the same promoted layers (`.zen-stage-card`,
 * `.zen-stage-dim`, `.zen-group-ribbon`), without a render between the finger and them.
 */
export function TabSwitchStage({ state, area }: Props): JSX.Element {
  const order = stageStore.use((s) => s.tabs.order)
  // The window of cards to keep mounted: the one under the finger, its neighbours, and one more
  // each side so a card is up before it comes into view. Whole numbers, so a move changes them
  // only as the position crosses a card.
  const first = stageStore.use((s) => Math.max(0, Math.floor(s.tabs.position) - 1))
  const last = stageStore.use((s) =>
    Math.min(s.tabs.order.length - 1, Math.ceil(s.tabs.position) + 1)
  )
  // The current tab's card is what the live page is swapped for when the track appears.
  const current = activeTab(state)?.id ?? null
  const cards: JSX.Element[] = []
  for (let index = first; index <= last; index++) {
    const tab = state.tabs[order[index]]
    if (!tab) continue
    const group = groupOf(state, tab)
    cards.push(
      <StageCard
        key={tab.id}
        index={index}
        area={area}
        group={group ? { name: group.name, colorVars: groupColorVars(group.color) } : null}
      >
        <TabPreview tab={tab} cover={tab.id === current} sharp />
      </StageCard>
    )
  }
  return <div className="pointer-events-none absolute inset-0 overflow-hidden">{cards}</div>
}

/** Where a card at `index` stands for a track at `position`, and how far from the centre it is. */
function placement(
  index: number,
  { position, origin, advance }: Pick<TabSwitchState, 'position' | 'origin' | 'advance'>
): { transform: string; dim: number; ribbon: number } {
  const offset = index - position
  const distance = Math.min(1, Math.abs(offset))
  return {
    transform: `translate3d(${offset * advance}px, 0, 0) scale(${1 - 0.06 * distance})`,
    dim: 0.22 * distance,
    // The ribbon has nothing to add to a page that is at rest: it fades in with the movement.
    ribbon: Math.min(1, Math.abs(position - origin) * 2.5)
  }
}

/**
 * One card of the track. Its transform, its dim layer's opacity and its ribbon's follow the
 * store's position from a subscription of the card's own, written to the elements directly;
 * the render gives them their first values, so a card mounted mid-swipe stands where the
 * track is from its first frame.
 */
function StageCard({
  index,
  area,
  group,
  children
}: {
  index: number
  area: Rect
  group: { name: string; colorVars: GroupColorVars } | null
  children: JSX.Element
}): JSX.Element {
  const card = useRef<HTMLDivElement>(null)
  const dim = useRef<HTMLDivElement>(null)
  const ribbon = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    let last: string | null = null
    const apply = (): void => {
      const tabs = stageStore.get().tabs
      if (tabs.phase === 'idle') return
      const at = placement(index, tabs)
      // The dim follows the position as the transform does; the ribbon follows the ORIGIN too.
      // The commit sets `origin` to the landed card while the spring's last step has already put
      // `position` there (`spring.ts` snaps its final step to the target), so the transform is
      // unchanged at the moment the ribbon has to go out: keying on the transform alone kept it up.
      const key = `${at.transform}|${at.ribbon}`
      if (key === last) return
      last = key
      if (card.current) card.current.style.transform = at.transform
      if (dim.current) dim.current.style.opacity = String(at.dim)
      if (ribbon.current) ribbon.current.style.opacity = String(at.ribbon)
    }
    apply()
    return stageStore.subscribe(apply)
  }, [index])
  const at = placement(index, stageStore.get().tabs)
  return (
    <div
      ref={card}
      className="zen-stage-card absolute"
      style={{
        left: area.x,
        top: area.y,
        width: area.width,
        height: area.height,
        transform: at.transform
      }}
    >
      {children}
      {group && (
        <div
          ref={ribbon}
          className="zen-group-ribbon absolute inset-x-0 top-0 flex h-7 items-center gap-2 px-3 text-[12px] font-semibold"
          data-group-rgb=""
          style={{ opacity: at.ribbon, ...group.colorVars } as CSSProperties}
        >
          <span className="zen-group-dot h-2 w-2 shrink-0 rounded-full" />
          <span className="min-w-0 truncate">{group.name}</span>
        </div>
      )}
      <div ref={dim} className="zen-stage-dim absolute inset-0" style={{ opacity: at.dim }} />
    </div>
  )
}

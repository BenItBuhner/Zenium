import type { CSSProperties, JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Rect } from '@shared/types'
import { groupColorChannels } from '@renderer/lib/groups'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { departed, departStore, type Departure } from './departures'
import { GROUP_HEADER, GROUP_PAD, GroupBadge } from './GroupCard'
import { CardBody } from './OverviewCard'

/** Travel (px) of the exit spring: its progress is 1 − position / this. */
const EXIT_TRAVEL = 120
/** How far a card shrinks on its way out. */
const EXIT_SCALE = 0.1

/**
 * The cards leaving the grid, each collapsing out where it stood while the grid closes the gap
 * behind it (see `departures.ts`). Drawn over the grid in window coordinates, like the ghost of a
 * card in the hand.
 */
export function Departures({ activeTabId }: { activeTabId: string | null }): JSX.Element | null {
  const items = departStore.use((s) => s.items)
  if (items.length === 0) return null
  return (
    <>
      {items.map((item) => (
        <Exit key={item.key} item={item} activeTabId={activeTabId} />
      ))}
    </>
  )
}

function Exit({ item, activeTabId }: { item: Departure; activeTabId: string | null }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const spring = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => {
        if (!el) return
        const t = 1 - x / EXIT_TRAVEL
        el.style.transform = `scale(${1 - EXIT_SCALE * t})`
        el.style.opacity = String(Math.max(0, 1 - t))
      },
      () => departed(item.key)
    )
    spring.start(EXIT_TRAVEL, 0, 0)
    return () => {
      spring.stop()
    }
  }, [item.key])
  return item.kind === 'tab' ? (
    <div
      ref={ref}
      className="zen-overview-card pointer-events-none fixed z-30 flex flex-col overflow-hidden"
      data-active={item.tab.id === activeTabId}
      style={{ ...place(item.rect), willChange: 'transform, opacity' }}
    >
      <CardBody tab={item.tab} />
    </div>
  ) : (
    <div
      ref={ref}
      className="zen-group pointer-events-none fixed z-30 flex flex-col overflow-hidden"
      style={
        {
          ...place(item.rect),
          willChange: 'transform, opacity',
          '--zen-group-rgb': groupColorChannels(item.folder.color)
        } as CSSProperties
      }
    >
      <div
        className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2"
        style={{ height: GROUP_HEADER }}
      >
        <GroupBadge folder={item.folder} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.folder.name}</span>
        <span className="text-[12px] tabular-nums text-[var(--zen-muted)]">{item.tabs.length}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 opacity-60"
          style={{ transform: item.folder.collapsed ? 'rotate(-90deg)' : 'none' }}
        />
      </div>
      {!item.folder.collapsed && (
        <div
          className="grid gap-3"
          style={{
            padding: GROUP_PAD,
            paddingTop: 0,
            gridTemplateColumns: `repeat(${item.tabs.length === 1 ? 1 : item.columns}, minmax(0, 1fr))`
          }}
        >
          {item.tabs.map((tab) => (
            <div key={tab.id} className="relative" style={{ aspectRatio: '3 / 4' }}>
              <div
                className="zen-overview-card absolute inset-0 flex flex-col overflow-hidden"
                data-active={tab.id === activeTabId}
              >
                <CardBody tab={tab} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function place(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

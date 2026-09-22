import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { groupColorChannels } from '@renderer/lib/groups'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { departed, departStore, releaseDepartures, type Departure } from './departureStore'
import { GROUP_PAD, GroupBadge } from './GroupCard'
import { CardBody } from './OverviewCard'

/** Travel (px) of the exit spring: its progress is 1 − position / this. */
const EXIT_TRAVEL = 120
/** How far a card shrinks on its way out. */
const EXIT_SCALE = 0.1
/** How long an exit waits for the browser to show the close before it runs regardless. */
export const EXIT_WAIT_MS = 900
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * The cards leaving the grid, each collapsing out where it stood while the grid closes the gap
 * behind it (see `departureStore.ts`). Drawn over the grid in window coordinates, like the ghost
 * of a card in the hand. An exit stands still over its card – the same card, drawn again – until
 * `state` no longer has the tab (or group): that commit is the one whose glide closes the gap,
 * so the collapse and the neighbours' glide start on the same frame (v2 §11.4). Under reduced
 * motion a card fades out in place over 120 ms, without the shrink (v2 §11.3). A card whose
 * close is still in flight (`closingTabIds`: its page's `beforeunload` may be asking "Leave
 * site?", PUI-28) stands as long as it is, and stands unmoved when the user stays.
 */
export function Departures({
  state,
  activeTabId
}: {
  state: UIState
  activeTabId: string | null
}): JSX.Element | null {
  const items = departStore.use((s) => s.items)
  useLayoutEffect(() => {
    const gone = items.filter((item) =>
      item.kind === 'tab' ? !state.tabs[item.tab.id] : !state.folders[item.folder.id]
    )
    if (gone.length > 0) releaseDepartures(gone.map((item) => item.key))
  })
  if (items.length === 0) return null
  const asked = (item: Departure): boolean => {
    const ids = item.kind === 'tab' ? [item.tab.id] : item.tabs.map((t) => t.id)
    return ids.some((id) => state.closingTabIds.includes(id))
  }
  return (
    <>
      {items.map((item) => (
        <Exit key={item.key} item={item} activeTabId={activeTabId} asked={asked(item)} />
      ))}
    </>
  )
}

function Exit({
  item,
  activeTabId,
  asked
}: {
  item: Departure
  activeTabId: string | null
  /** The card's close is in flight (its page may be asking "Leave site?"): the exit waits with it. */
  asked: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const released = departStore.use((s) => s.released.has(item.key))
  const wasAsked = useRef(false)
  // The browser may never show the close (the command failed): the exit runs anyway, and the
  // card is back once it has. Not while the close is in flight – its page may be asking "Leave
  // site?", the close waiting on the user – and once it is through a tab still here after the
  // same wait is one the user stayed on: its card is back where it stands, no exit run over it.
  useEffect(() => {
    if (released) return
    if (asked) {
      wasAsked.current = true
      return
    }
    const timer = setTimeout(
      () => (wasAsked.current ? departed(item.key) : releaseDepartures([item.key])),
      EXIT_WAIT_MS
    )
    return () => clearTimeout(timer)
  }, [released, asked, item.key])
  useLayoutEffect(() => {
    if (!released) return
    const el = ref.current
    if (reducedMotion()) {
      const fade = el?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
        duration: REDUCED_FADE_MS,
        easing: EASE,
        fill: 'forwards'
      })
      const done = (): void => departed(item.key)
      if (fade) fade.onfinish = done
      const timer = fade ? null : setTimeout(done, REDUCED_FADE_MS)
      return () => {
        fade?.cancel()
        if (timer !== null) clearTimeout(timer)
      }
    }
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
  }, [item.key, released])
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
      <div className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2">
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

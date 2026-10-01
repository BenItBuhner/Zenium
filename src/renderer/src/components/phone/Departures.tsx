import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { groupColorVars } from '@renderer/lib/groups'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { ZEN_EASE } from '@renderer/lib/motion/tokens'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { GroupGlyph } from '../GroupGlyph'
import {
  departed,
  departStore,
  departureGone,
  isHeld,
  releaseDepartures,
  restDeparture,
  type Departure
} from './departureStore'
import { EXIT_TRAVEL, exitFrame } from './exitSpring'
import { GROUP_PAD } from './GroupCard'
import { CARD_ASPECT, CardBody, NewTabFace } from './OverviewCard'

/** How long an exit waits for the browser to show the close before it runs regardless. */
export const EXIT_WAIT_MS = 900

/**
 * The cards leaving the grid, each collapsing out where it stood while the grid closes the gap
 * behind it (see `departureStore.ts`). Drawn over the grid in window coordinates, like the ghost
 * of a card in the hand. An exit stands still over its card – the same card, drawn again – until
 * `state` no longer has the tab (or group): that commit is the one whose glide closes the gap,
 * so the collapse and the neighbours' glide start on the same frame (v2 §11.4). Under reduced
 * motion a card fades out in place over 120 ms, without the shrink (v2 §11.3). A card the tab
 * search drops (`filtered`), and the New Tab card a query takes with it (`new-tab`), leave the
 * same way, released by the grid's own commit (`TabOverview`) – as is a group's exit whatever
 * took its cards: the group's folder stays (saved on a close, open when a query hides the cards
 * it has left), so the commit that takes its card off the grid is the one that releases it (the
 * one whose glide closes the gap, §11.4's leave). A card whose close is still in flight
 * (`closingTabIds`: its page's `beforeunload` may be asking "Leave site?", PUI-28) stands as long
 * as it is, and stands unmoved when the user stays – a tab's own close, or a group's whose last
 * shown card was swiped or closed under a query (`tab.close`); a whole group's X, Close Group and
 * a close-all go through `folder.close`, which closes its members without the ask.
 *
 * Quick Delete's exits (`held`, MOT-24) run the other way round: the wipe releases each in its
 * turn BEFORE the browser closes the tab, the exit rests out of view over the slot its card
 * still holds, and the close that follows takes the slot – the exit going on that commit, the
 * neighbours gliding into the gap – or keeps the tab, on which the exit runs back to the card
 * (`restoring`). Nothing else releases a held exit: no wait runs out on it.
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
    // The New Tab card's exit is the grid's to release when a query takes it off; when it leaves
    // `with` the close that empties the pane (TAB-34) it is the close's, as a card's exit is:
    // released in the commit the tabs it leaves with are gone.
    const gone = items.filter((item) =>
      item.kind === 'tab'
        ? !state.tabs[item.tab.id]
        : item.kind === 'group'
          ? !state.folders[item.folder.id]
          : item.with !== undefined && item.with.every((id) => !state.tabs[id])
    )
    if (gone.length > 0) departureGone(gone.map((item) => item.key))
  })
  if (items.length === 0) return null
  // The New Tab card has no page to ask of its own; leaving with a close, it waits on the pages
  // that close asks.
  const asked = (item: Departure): boolean => {
    const ids =
      item.kind === 'new-tab'
        ? (item.with ?? [])
        : item.kind === 'tab'
          ? [item.tab.id]
          : item.tabs.map((t) => t.id)
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
  const restoring = departStore.use((s) => s.restoring.has(item.key))
  const held = isHeld(item)
  // A held exit frozen at a frame of its run (the preview host's still): drawn there, never run.
  const frozen = held && item.kind !== 'new-tab' ? item.frozen : undefined
  const wasAsked = useRef(false)
  // The exit's spring, kept so a restore sets off from wherever the run left it.
  const spring = useRef<SpringAnimation | null>(null)
  // The browser may never show the close (the command failed): the exit runs anyway, and the
  // card is back once it has. Not while the close is in flight – its page may be asking "Leave
  // site?", the close waiting on the user – and once it is through a tab still here after the
  // same wait is one the user stayed on: its card is back where it stands, no exit run over it.
  // A held exit waits on nothing but the wipe's schedule.
  useEffect(() => {
    if (released || held) return
    if (asked) {
      wasAsked.current = true
      return
    }
    const timer = setTimeout(
      () => (wasAsked.current ? departed(item.key) : releaseDepartures([item.key])),
      EXIT_WAIT_MS
    )
    return () => clearTimeout(timer)
  }, [released, held, asked, item.key])
  useLayoutEffect(() => {
    if (frozen === undefined) return
    exitFrame(ref.current)(EXIT_TRAVEL * (1 - frozen))
  }, [frozen])
  useLayoutEffect(() => {
    if (!released || restoring || frozen !== undefined) return
    const el = ref.current
    // A card's exit is done at rest; a held one rests where it is, out of view, until the
    // browser's close takes its slot (or keeps its tab).
    const rest = (): void => (held ? restDeparture(item.key) : departed(item.key))
    if (reducedMotion()) {
      const fade = el?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
        duration: REDUCED_FADE_MS,
        easing: ZEN_EASE,
        fill: 'forwards'
      })
      if (fade) fade.onfinish = rest
      const timer = fade ? null : setTimeout(rest, REDUCED_FADE_MS)
      return () => {
        fade?.cancel()
        if (timer !== null) clearTimeout(timer)
      }
    }
    const run = new SpringAnimation(SPRING_SNAPPY, exitFrame(el), rest)
    spring.current = run
    run.start(EXIT_TRAVEL, 0, 0)
    return () => {
      run.stop()
    }
  }, [item.key, released, restoring, held, frozen])
  // The browser kept the tab: the exit runs back to the card from where its run left it, and
  // goes once it is there – the card, hidden behind it all along, showing again on that commit.
  // Under reduced motion the spring lands at once: the card is back in a cut.
  useLayoutEffect(() => {
    if (!restoring) return
    const el = ref.current
    const from = spring.current?.current.x ?? 0
    const back = new SpringAnimation(SPRING_SNAPPY, exitFrame(el), () => departed(item.key))
    spring.current = back
    back.start(from, 0, EXIT_TRAVEL)
    return () => {
      back.stop()
    }
  }, [item.key, restoring])
  if (item.kind === 'new-tab')
    return (
      <div
        ref={ref}
        className="zen-overview-new pointer-events-none fixed z-30 flex flex-col items-center justify-center gap-2 text-[var(--zen-muted)]"
        style={{ ...place(item.rect), willChange: 'transform, opacity' }}
      >
        <NewTabFace isPrivate={item.isPrivate} />
      </div>
    )
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
      data-group-rgb=""
      style={
        {
          ...place(item.rect),
          willChange: 'transform, opacity',
          ...groupColorVars(item.folder.color)
        } as CSSProperties
      }
    >
      <div className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2">
        <GroupGlyph folder={item.folder} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.folder.name}</span>
        <span className="zen-group-row-count">{item.tabs.length}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 opacity-60"
          style={{ transform: item.folder.collapsed ? 'rotate(-90deg)' : 'none' }}
        />
      </div>
      {!item.folder.collapsed && !item.flown && (
        <div
          className="grid gap-3"
          style={{
            padding: GROUP_PAD,
            paddingTop: 0,
            gridTemplateColumns: `repeat(${item.tabs.length === 1 ? 1 : item.columns}, minmax(0, 1fr))`
          }}
        >
          {item.tabs.map((tab) => (
            <div key={tab.id} className="relative" style={{ aspectRatio: CARD_ASPECT }}>
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

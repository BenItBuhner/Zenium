import type { CSSProperties, JSX } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { PhoneBarPosition, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { closeOverview, overviewIsOpen, toggleOverview } from '@renderer/lib/gestures/stage'
import { groupColorChannels } from '@renderer/lib/groups'
import { GROUP_STRIP_HEIGHT, newTabAnchor, stripCellKey } from '@renderer/lib/groupStrip'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { openNewTabPage, prepareNewTabGrow } from '@renderer/lib/newtab'
import { tabTitle } from '@renderer/lib/selectors'
import { createStore, type Store } from '@renderer/lib/store'
import { cn } from '@renderer/lib/utils'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { Favicon } from '../sidebar/Favicon'
import { GroupBadge } from './GroupCard'
import { useFlip } from './useFlip'
import type { GroupStripPresence } from './useGroupStrip'

/**
 * Travel (px) of a chip's own entrance and exit spring: the slot pitch (a 36 chip and its 4
 * gap), the distance its neighbours glide on the same spring, so the two settle together.
 */
const CHIP_TRAVEL = 40
/** The scale a chip's face starts at coming in, and shrinks to going out. */
const CHIP_SCALE_FROM = 0.6
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
/** Room kept between the active chip and the scroller's fading edge. */
const KEEP_IN_VIEW_PAD = 8

interface Props {
  presence: GroupStripPresence
  state: UIState
  edge: PhoneBarPosition
  /** The overview is up: a member chip closes it into its card, the show-group chip is pressed. */
  overviewOpen: boolean
  /** The bar preview at the other edge during a carry: drawn, never pressed, nothing moves. */
  inert?: boolean
}

/** A chip whose tab has left the group, fading out where it stood while its neighbours close up. */
interface ChipExit {
  tab: Tab
  /** Its slot's left edge in the scroller (`offsetLeft`). */
  x: number
}

/** What the strip is doing, for the render: read through the store, written from effects. */
interface StripMotion {
  /** The tray is sliding in or out: nothing is measured meanwhile. */
  sliding: boolean
  exits: ChipExit[]
}

/**
 * What the last commit showed, kept in the effect phase: which group, each member's slot, and
 * which chips are still running their entrance. The chips read it in their own layout effects –
 * which run before the strip's, so they see the commit before theirs – and the strip's effect
 * moves it on. A chip decides once that it enters and is remembered until its entrance has
 * landed, so StrictMode's second run of its effect (after the strip's has moved the ledger on)
 * comes to the same answer.
 */
class StripLedger {
  group: string | null = null
  cells = new Map<string, ChipExit>()
  private readonly entering = new Set<string>()

  /** This commit's group and members' slots are the baseline from here. */
  advance(group: string, cells: Map<string, ChipExit>): void {
    this.group = group
    this.cells = cells
  }

  /** Whether the chip of `id` joins a strip of `group` that was already showing. */
  enters(group: string, id: string): boolean {
    if (this.entering.has(id)) return true
    if (this.group !== group || this.cells.has(id)) return false
    this.entering.add(id)
    return true
  }

  entered(id: string): void {
    this.entering.delete(id)
  }
}

/**
 * The tab group strip (TAB-14, MOT-13): the row the bar band gains while the active tab is in a
 * group. A 44 tray in the window family (v2 §9.29: `--v2-window-fill`, the theme's ink, the
 * theme's accent for the active mark), full width of the bar, holding the show-group chip (the
 * group's colour dot; it opens the overview at the group), the members' favicon chips in a
 * horizontal scroller with fading edges, and the plus chip that opens a new tab in the group.
 * Chips are §9.22 buttons: in the tab order, each with its own label, the active one marked
 * `aria-current`. The tray's radius is the pill's (22) and the chips' 18 sit 4 inside it.
 *
 * Motion (v2 §11): the strip slides out of the bar's row and back behind it on `SPRING_SNAPPY`,
 * clipped to its own band; a chip that joins scales in at its slot while the chips after it
 * glide over (the grid's `FlipTracker` through `useFlip`, one FLIP set), a chip that leaves
 * shrinks out where it stood while they glide back – neighbours and the chip on one spring
 * over the same travel. Under reduced motion every appearance and departure is the 120 ms fade
 * in place of §11.3, and the tracker turns the glides into fades.
 *
 * The strip takes only its own band: nothing on it reaches the pill's gesture recogniser or the
 * bar's hold (both live on siblings), and the bar's hold-to-edit does not reach the chips.
 */
export function GroupStrip({ presence, state, edge, overviewOpen, inert }: Props): JSX.Element {
  const { model, phase, onEntered, onLeft } = presence
  const { group, members, activeTabId } = model
  const trayRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const fadeEdges = useFadeEdges<HTMLDivElement>({ axis: 'x', size: 12 })
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef.current = el
      return fadeEdges(el)
    },
    [fadeEdges]
  )

  const [motion] = useState<Store<StripMotion>>(() =>
    createStore<StripMotion>({ sliding: phase !== 'shown', exits: [] })
  )
  const { sliding, exits } = motion.use()
  const [ledger] = useState(() => new StripLedger())

  // The members' chips are the FLIP set. While the tray slides nothing is measured: a chip's
  // window position moves with the tray, and the tracker would read that as a glide of every
  // chip; the first commit at rest takes the baseline.
  const flip = useFlip(scrollerRef, !inert && !sliding)

  // After the tracker's commit: which chips are gone since the last one (their exits, placed
  // where they stood), then the ledger moves on to this commit. A different group is a
  // different strip: its chips simply appear, and nothing of the old one leaves.
  useLayoutEffect(() => {
    const prev = { group: ledger.group, cells: ledger.cells }
    const cells = new Map<string, ChipExit>()
    for (const tab of members) {
      const el = flip.element(stripCellKey(tab.id))
      cells.set(tab.id, { tab, x: el?.offsetLeft ?? prev.cells.get(tab.id)?.x ?? 0 })
    }
    ledger.advance(group.id, cells)
    if (inert || phase === 'leaving' || prev.group !== group.id) return
    const gone = [...prev.cells.values()].filter((c) => !cells.has(c.tab.id))
    if (gone.length === 0) return
    motion.set((s) => ({
      exits: [...s.exits.filter((e) => !gone.some((g) => g.tab.id === e.tab.id)), ...gone]
    }))
  })
  const exitDone = useCallback(
    (id: string) => motion.set((s) => ({ exits: s.exits.filter((e) => e.tab.id !== id) })),
    [motion]
  )

  // The active chip stays in view: the first time at once, then along with the scroller.
  const scrolledOnce = useRef(false)
  const membersKey = members.map((t) => t.id).join('|')
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const cell = activeTabId ? flip.element(stripCellKey(activeTabId)) : null
    if (!scroller || !cell) return
    const start = cell.offsetLeft - KEEP_IN_VIEW_PAD
    const end = cell.offsetLeft + cell.offsetWidth + KEEP_IN_VIEW_PAD
    let target = scroller.scrollLeft
    if (start < target) target = start
    else if (end > target + scroller.clientWidth) target = end - scroller.clientWidth
    target = Math.max(0, target)
    const smooth = scrolledOnce.current && !reducedMotion() && !inert
    scrolledOnce.current = true
    if (Math.abs(target - scroller.scrollLeft) < 1) return
    if (typeof scroller.scrollTo === 'function')
      scroller.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' })
    else scroller.scrollLeft = target
  }, [activeTabId, membersKey, flip, inert])

  // The tray's slide: out of the bar's row when the strip enters, back behind it when it
  // leaves, on one spring that a change of mind turns round. The two ends are reported to the
  // presence; under reduced motion each is a 120 ms fade in place instead.
  const dir = useRef(1)
  useLayoutEffect(() => {
    dir.current = edge === 'bottom' ? 1 : -1
  }, [edge])
  const spring = useRef<SpringAnimation | null>(null)
  useLayoutEffect(() => {
    const el = trayRef.current
    if (!el || inert) return
    const target = phase === 'leaving' ? GROUP_STRIP_HEIGHT : 0
    /** The slide has landed at `at`: the end it reached is the one reported. */
    const landed = (at: number): void => {
      el.style.willChange = ''
      motion.set({ sliding: false })
      if (at === 0) onEntered()
      else onLeft()
    }
    if (phase === 'shown' && !spring.current?.running) {
      el.style.transform = ''
      motion.set({ sliding: false })
      return
    }
    if (reducedMotion()) {
      spring.current?.stop()
      spring.current = null
      el.style.transform = ''
      const from = phase === 'leaving' ? 1 : 0
      const fade = el.animate?.([{ opacity: from }, { opacity: 1 - from }], {
        duration: REDUCED_FADE_MS,
        easing: EASE,
        fill: 'forwards'
      })
      const done = (): void => landed(target)
      if (fade) fade.onfinish = done
      const timer = fade ? null : setTimeout(done, REDUCED_FADE_MS)
      return () => {
        fade?.cancel()
        if (timer !== null) clearTimeout(timer)
      }
    }
    const draw = (x: number): void => {
      el.style.transform = `translate3d(0, ${(dir.current * x).toFixed(2)}px, 0)`
    }
    // One spring for the strip's life, turned round by a change of mind: its rest reads where
    // it was heading when it landed, not the phase of the run that made it.
    const s = (spring.current ??= new SpringAnimation(SPRING_SNAPPY, draw, () => {
      const at = spring.current?.destination ?? 0
      if (at === 0) el.style.transform = ''
      landed(at)
    }))
    el.style.willChange = 'transform'
    motion.set({ sliding: true })
    if (s.running) s.retarget(target)
    else {
      // Drawn at its start in this very commit: the spring's first frame is a frame away, and
      // the tray must not show at rest for it.
      const from = phase === 'leaving' ? 0 : GROUP_STRIP_HEIGHT
      s.start(from, 0, target)
      draw(from)
    }
    return undefined
  }, [phase, inert, motion, onEntered, onLeft])
  useLayoutEffect(
    () => () => {
      spring.current?.stop()
      spring.current = null
    },
    []
  )

  const label = group.name.trim() || 'Group'

  return (
    <div
      className={cn('zen-group-strip', inert && 'pointer-events-none')}
      data-edge={edge}
      data-phase={phase}
      aria-hidden={inert || undefined}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={trayRef}
        role={inert ? undefined : 'group'}
        aria-label={inert ? undefined : `Tab group, ${label}`}
        className="zen-group-tray"
        style={{ '--zen-group-rgb': groupColorChannels(group.color) } as CSSProperties}
      >
        <button
          type="button"
          className="zen-group-chip zen-v2-group-chip zen-group-chip-show"
          data-strip-show
          aria-label={`Show group, ${label}`}
          aria-pressed={inert ? undefined : overviewOpen}
          tabIndex={inert ? -1 : 0}
          onClick={inert ? undefined : () => toggleOverview(state)}
        >
          <span className="zen-group-chip-face">
            <GroupBadge folder={group} />
          </span>
        </button>
        <div ref={setScroller} className="zen-group-scroller" data-strip-members>
          {members.map((tab) => (
            <MemberChip
              key={tab.id}
              tab={tab}
              groupId={group.id}
              active={tab.id === activeTabId}
              ledger={inert ? null : ledger}
              inert={inert}
              onPick={() => {
                if (overviewIsOpen()) closeOverview(tab.id)
                else if (tab.id !== activeTabId) run('tab.activate', { tabId: tab.id })
              }}
            />
          ))}
          {exits.map((exit) => (
            <ExitChip key={`exit:${exit.tab.id}`} exit={exit} onDone={exitDone} />
          ))}
        </div>
        <button
          type="button"
          className="zen-group-chip zen-v2-group-chip"
          data-strip-plus
          aria-label={`New tab in ${label}`}
          tabIndex={inert ? -1 : 0}
          onPointerDown={inert ? undefined : prepareNewTabGrow}
          onClick={
            inert
              ? undefined
              : (e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  void openNewTabPage(
                    { x: r.left, y: r.top, width: r.width, height: r.height },
                    { afterTabId: newTabAnchor(model) }
                  )
                }
          }
        >
          <span className="zen-group-chip-face">
            <Plus className="zen-group-chip-glyph" aria-hidden />
          </span>
        </button>
      </div>
    </div>
  )
}

/**
 * A member's chip: its favicon in a 36 circle, the cell the tracker glides. The face inside is
 * what the entrance scales – the cell's own transform belongs to the tracker, which writes it
 * every frame of a glide. Whether it enters (joins a strip already showing) is the ledger's
 * answer, asked in the layout effect that runs before the strip's own.
 */
function MemberChip({
  tab,
  groupId,
  active,
  ledger,
  inert,
  onPick
}: {
  tab: Tab
  groupId: string
  active: boolean
  ledger: StripLedger | null
  inert?: boolean
  onPick: () => void
}): JSX.Element {
  const face = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = face.current
    if (!el || !ledger || !ledger.enters(groupId, tab.id)) return
    const settled = (): void => ledger.entered(tab.id)
    if (reducedMotion()) {
      const fade = el.animate?.([{ opacity: 0 }, { opacity: 1 }], {
        duration: REDUCED_FADE_MS,
        easing: EASE
      })
      if (fade) fade.onfinish = settled
      const timer = fade ? null : setTimeout(settled, REDUCED_FADE_MS)
      return () => {
        fade?.cancel()
        if (timer !== null) clearTimeout(timer)
      }
    }
    const draw = (x: number): void => {
      const t = 1 - x / CHIP_TRAVEL
      el.style.transform = `scale(${(CHIP_SCALE_FROM + (1 - CHIP_SCALE_FROM) * t).toFixed(4)})`
      el.style.opacity = Math.max(0, Math.min(1, t)).toFixed(3)
    }
    const spring = new SpringAnimation(SPRING_SNAPPY, draw, () => {
      el.style.transform = ''
      el.style.opacity = ''
      settled()
    })
    spring.start(CHIP_TRAVEL, 0, 0)
    // Small and clear from this commit: the spring's first frame is a frame away.
    draw(CHIP_TRAVEL)
    return () => {
      spring.stop()
      el.style.transform = ''
      el.style.opacity = ''
    }
  }, [ledger, groupId, tab.id])
  const title = tabTitle(tab) || tab.url
  return (
    <button
      type="button"
      className="zen-group-chip zen-v2-group-chip"
      data-cell={stripCellKey(tab.id)}
      data-strip-member={tab.id}
      aria-label={active ? `${title}, current tab` : title}
      aria-current={active ? 'true' : undefined}
      tabIndex={inert ? -1 : 0}
      onClick={inert ? undefined : onPick}
    >
      <span ref={face} className="zen-group-chip-face">
        <Favicon tab={tab} size={16} />
      </span>
    </button>
  )
}

/**
 * The chip of a tab that left the group: shrinks out in place on the exit spring (v2 §11.4).
 * Its face is what shrinks, as a joining chip's face is what grows.
 */
function ExitChip({ exit, onDone }: { exit: ChipExit; onDone: (id: string) => void }): JSX.Element {
  const face = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = face.current
    if (!el) return
    const finish = (): void => onDone(exit.tab.id)
    if (reducedMotion()) {
      const fade = el.animate?.([{ opacity: 1 }, { opacity: 0 }], {
        duration: REDUCED_FADE_MS,
        easing: EASE,
        fill: 'forwards'
      })
      if (fade) fade.onfinish = finish
      const timer = fade ? null : setTimeout(finish, REDUCED_FADE_MS)
      return () => {
        fade?.cancel()
        if (timer !== null) clearTimeout(timer)
      }
    }
    const draw = (x: number): void => {
      const t = 1 - x / CHIP_TRAVEL
      el.style.transform = `scale(${(1 - (1 - CHIP_SCALE_FROM) * t).toFixed(4)})`
      el.style.opacity = Math.max(0, Math.min(1, 1 - t)).toFixed(3)
    }
    const spring = new SpringAnimation(SPRING_SNAPPY, draw, finish)
    spring.start(CHIP_TRAVEL, 0, 0)
    draw(CHIP_TRAVEL)
    return () => spring.stop()
  }, [exit.tab.id, onDone])
  return (
    <span
      aria-hidden
      className="zen-group-chip zen-group-chip-exit"
      data-strip-exit={exit.tab.id}
      style={{ left: exit.x }}
    >
      <span ref={face} className="zen-group-chip-face">
        <Favicon tab={exit.tab} size={16} />
      </span>
    </span>
  )
}

import type { CSSProperties, JSX } from 'react'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Folder, PhoneBarPosition, Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { closeOverview, overviewIsOpen, toggleOverview } from '@renderer/lib/gestures/stage'
import { groupColorChannels } from '@renderer/lib/groups'
import {
  GROUP_STRIP_HEIGHT,
  GROUP_SWITCH_FADE_MS,
  newTabAnchor,
  stripCellKey
} from '@renderer/lib/groupStrip'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { openNewTabPage, prepareNewTabGrow } from '@renderer/lib/newtab'
import { tabTitle } from '@renderer/lib/selectors'
import { createStore, type Store } from '@renderer/lib/store'
import { browserStore } from '@renderer/lib/ui'
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

/**
 * A chip's face as a spring starts to write it: the stylesheet's transition paused (or the
 * pressed state's ease would drag on every frame), and the compositor told what moves – only
 * for as long as it does (v2 §11): at rest a face computes `will-change: auto`.
 */
function moveFace(el: HTMLElement): void {
  el.style.transition = 'none'
  el.style.willChange = 'transform, opacity'
}

/**
 * A chip's face back at rest after a spring wrote it: the scale and fade gone, the transition
 * back for the pressed state, and the compositor's layer let go.
 */
function restFace(el: HTMLElement): void {
  el.style.transform = ''
  el.style.opacity = ''
  el.style.transition = ''
  el.style.willChange = ''
}

interface Props {
  presence: GroupStripPresence
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

/**
 * The chips of the group the strip showed until this commit, kept for the cross-fade of a
 * switch of group (v2 §11.4): drawn once more where they stood, out of the flow, fading out
 * over the chips that took their slots.
 */
interface StripGhosts {
  /** One switch's ghosts; a second switch inside the fade replaces them. */
  key: number
  /** The group they belonged to, for its dot on the show-group chip. */
  group: Folder
  /** The show-group chip's left edge in the tray. */
  show: number
  /** The scroller's box in the tray, the members' clip. */
  box: { left: number; width: number }
  /** The members' chips, `x` in the scroller's viewport (their slot less the scroll). */
  cells: ChipExit[]
  /** The member that was active, its ring fading out with it. */
  active: string | null
  /** The scroller's edge fades as they stood (`useFadeEdges`' two lengths). */
  fade: [string, string]
}

/** What the strip is doing, for the render: read through the store, written from effects. */
interface StripMotion {
  /** The tray is sliding in or out: nothing is measured meanwhile. */
  sliding: boolean
  exits: ChipExit[]
  ghosts: StripGhosts | null
}

/** How a chip comes onto the strip: on the spring, as a member joining a strip already showing; by fade, as the strip switches to its group from another (§11.4). */
type ChipArrival = 'spring' | 'fade'

/**
 * What the last commit showed, kept in the effect phase: which group, each member's slot, and
 * which chips are still arriving. The chips read it in their own layout effects – which run
 * before the strip's, so they see the commit before theirs – and the strip's effect moves it
 * on. A chip decides once how it arrives and is remembered until its arrival has landed, so
 * StrictMode's second run of its effect (after the strip's has moved the ledger on) comes to the
 * same answer.
 */
class StripLedger {
  group: Folder | null = null
  cells = new Map<string, ChipExit>()
  active: string | null = null
  private readonly arriving = new Map<string, ChipArrival>()

  /** This commit's group, members' slots and active member are the baseline from here. */
  advance(group: Folder, cells: Map<string, ChipExit>, active: string | null): void {
    this.group = group
    this.cells = cells
    this.active = active
  }

  /**
   * How the chip of `id` arrives on a strip of `group`: on the spring if it joins the group the
   * strip was already showing, by fade if the strip switched to its group from another, not at
   * all on a strip that has just arrived (its chips come with it) or for a chip that was there.
   */
  arrival(group: string, id: string): ChipArrival | null {
    const remembered = this.arriving.get(id)
    if (remembered) return remembered
    if (this.group === null) return null
    if (this.group.id === group && this.cells.has(id)) return null
    const how: ChipArrival = this.group.id === group ? 'spring' : 'fade'
    this.arriving.set(id, how)
    return how
  }

  arrived(id: string): void {
    this.arriving.delete(id)
  }
}

/**
 * `el` fades on opacity over `ms` from `from` to `to` (the Web Animations API; a timer stands
 * in where there is none), `done` at the end; returns the cancel. A fade to nothing is held
 * there (`fill`), so the element does not show again before it is removed.
 */
function fadeOver(
  el: HTMLElement,
  from: number,
  to: number,
  ms: number,
  done: () => void
): () => void {
  const anim = el.animate?.([{ opacity: from }, { opacity: to }], {
    duration: ms,
    easing: EASE,
    fill: to === 0 ? 'forwards' : 'none'
  })
  if (anim) anim.onfinish = done
  const timer = anim ? null : setTimeout(done, ms)
  return () => {
    anim?.cancel()
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The tab group strip (TAB-14, MOT-13): the row the bar band gains while the active tab is in a
 * group. A 44 tray in the window family (v2 §9.29: `--v2-window-fill`, the theme's ink, the
 * theme's accent for the active mark), full width of the bar, holding the show-group chip (the
 * group's colour dot; it opens the overview at the group), the members' favicon chips in a
 * horizontal scroller with fading edges, and the plus chip that opens a new tab in the group.
 * Chips are §9.22 buttons: in the tab order, each with its own label, the active one marked
 * `aria-current`. The tray's radius is the pill's (22) and the chips' 18 sit 4 inside it; a
 * chip's cell – its touch target – is §9.3's 44 x 44 box laid over the slot's 40 pitch (the
 * cells overlap by 4, the later one taking the shared strip), the 36 face inside it what it
 * shows (main.css).
 *
 * Motion (v2 §11): the strip slides out of the bar's row and back behind it on `SPRING_SNAPPY`,
 * clipped to its own band; a chip that joins scales in at its slot while the chips after it
 * glide over (the grid's `FlipTracker` through `useFlip`, one FLIP set), a chip that leaves
 * shrinks out where it stood while they glide back – neighbours and the chip on one spring
 * over the same travel. Under reduced motion every appearance and departure is the 120 ms fade
 * in place of §11.3, and the tracker turns the glides into fades. A switch of group – the
 * active tab moves from one group to another – changes the strip's content in place: the old
 * group's chips and dot fade out where they stood over the new group's fading in at their
 * slots, 120 ms on opacity, no slide and no cut (§11.4); the same fade under reduced motion.
 * The tray stands and the band holds; the scroller takes the new group's width from the first
 * frame, and scrolls at once (no smooth scroll) to keep the new active chip in view.
 *
 * The strip takes only its own band: nothing on it reaches the pill's gesture recogniser or the
 * bar's hold (both live on siblings), and the bar's hold-to-edit does not reach the chips.
 *
 * A `memo`: the strip is mounted for as long as the tab is grouped, and every render of it
 * commits the FLIP set – every chip's transform cleared and its rect read. Its presence hands it
 * the same model while nothing it draws has changed (`useGroupStrip`), so a browser state that
 * moved something else leaves it be; what it needs at a tap it reads then.
 */
export const GroupStrip = memo(function GroupStrip({
  presence,
  edge,
  overviewOpen,
  inert
}: Props): JSX.Element {
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
    createStore<StripMotion>({ sliding: phase !== 'shown', exits: [], ghosts: null })
  )
  const { sliding, exits, ghosts } = motion.use()
  const [ledger] = useState(() => new StripLedger())
  const showRef = useRef<HTMLButtonElement>(null)
  const showFaceRef = useRef<HTMLSpanElement>(null)
  // Where the scroller stood before this commit: the browser clamps `scrollLeft` to the new
  // content the moment it is laid out, so the ghosts of a switch read the position from here.
  const lastScroll = useRef(0)

  // The members' chips are the FLIP set. While the tray slides nothing is measured: a chip's
  // window position moves with the tray, and the tracker would read that as a glide of every
  // chip; the first commit at rest takes the baseline.
  const flip = useFlip(scrollerRef, !inert && !sliding)

  // After the tracker's commit: which chips are gone since the last one (their exits, placed
  // where they stood), then the ledger moves on to this commit. A different group is a switch
  // of the strip's content in place (§11.4): the old group's chips stay a fade longer as ghosts
  // where they stood, over the new group's chips fading in at their slots, the group's dot
  // fading with them; nothing of the old one leaves on the spring.
  useLayoutEffect(() => {
    const prev = { group: ledger.group, cells: ledger.cells, active: ledger.active }
    const scroller = scrollerRef.current
    const cells = new Map<string, ChipExit>()
    for (const tab of members) {
      const el = flip.element(stripCellKey(tab.id))
      cells.set(tab.id, { tab, x: el?.offsetLeft ?? prev.cells.get(tab.id)?.x ?? 0 })
    }
    ledger.advance(group, cells, activeTabId)
    if (inert || phase === 'leaving') return
    if (prev.group && prev.group.id !== group.id) {
      const scroll = lastScroll.current
      motion.set((s) => ({
        ghosts: {
          key: (s.ghosts?.key ?? 0) + 1,
          group: prev.group!,
          show: showRef.current?.offsetLeft ?? 0,
          box: { left: scroller?.offsetLeft ?? 0, width: scroller?.offsetWidth ?? 0 },
          cells: [...prev.cells.values()].map((c) => ({ tab: c.tab, x: c.x - scroll })),
          active: prev.active,
          fade: [
            scroller?.style.getPropertyValue('--zen-fade-start') || '0px',
            scroller?.style.getPropertyValue('--zen-fade-end') || '0px'
          ]
        }
      }))
      if (showFaceRef.current) fadeOver(showFaceRef.current, 0, 1, GROUP_SWITCH_FADE_MS, () => {})
    } else {
      if (scroller) lastScroll.current = scroller.scrollLeft
      if (!prev.group) return
      const gone = [...prev.cells.values()].filter((c) => !cells.has(c.tab.id))
      if (gone.length === 0) return
      motion.set((s) => ({
        exits: [...s.exits.filter((e) => !gone.some((g) => g.tab.id === e.tab.id)), ...gone]
      }))
    }
  })
  const exitDone = useCallback(
    (id: string) => motion.set((s) => ({ exits: s.exits.filter((e) => e.tab.id !== id) })),
    [motion]
  )
  const ghostsDone = useCallback(
    (key: number) => motion.set((s) => (s.ghosts?.key === key ? { ghosts: null } : {})),
    [motion]
  )

  // The active chip stays in view: the first time at once, then along with the scroller – but
  // at once again on a switch of group, whose chips are new and take their places from frame 0.
  const scrolledOnce = useRef(false)
  const scrolledGroup = useRef(group.id)
  const membersKey = members.map((t) => t.id).join('|')
  useLayoutEffect(() => {
    const switched = scrolledGroup.current !== group.id
    scrolledGroup.current = group.id
    const scroller = scrollerRef.current
    const cell = activeTabId ? flip.element(stripCellKey(activeTabId)) : null
    if (!scroller || !cell) return
    const start = cell.offsetLeft - KEEP_IN_VIEW_PAD
    const end = cell.offsetLeft + cell.offsetWidth + KEEP_IN_VIEW_PAD
    let target = scroller.scrollLeft
    if (start < target) target = start
    else if (end > target + scroller.clientWidth) target = end - scroller.clientWidth
    target = Math.max(0, target)
    const smooth = scrolledOnce.current && !switched && !reducedMotion() && !inert
    scrolledOnce.current = true
    if (Math.abs(target - scroller.scrollLeft) < 1) return
    if (typeof scroller.scrollTo === 'function')
      scroller.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' })
    else scroller.scrollLeft = target
  }, [activeTabId, membersKey, group.id, flip, inert])

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
          ref={showRef}
          type="button"
          className="zen-group-chip zen-group-chip-show"
          data-strip-show
          aria-label={`Show group, ${label}`}
          aria-pressed={inert ? undefined : overviewOpen}
          tabIndex={inert ? -1 : 0}
          onClick={
            inert
              ? undefined
              : () => {
                  const state = browserStore.get().state
                  if (state) toggleOverview(state)
                }
          }
        >
          <span ref={showFaceRef} className="zen-group-chip-face">
            <GroupBadge folder={group} />
          </span>
        </button>
        <div
          ref={setScroller}
          className="zen-group-scroller"
          data-strip-members
          onScroll={(e) => {
            lastScroll.current = e.currentTarget.scrollLeft
          }}
        >
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
          className="zen-group-chip"
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
        {ghosts && <GhostLayer key={ghosts.key} ghosts={ghosts} onDone={ghostsDone} />}
      </div>
    </div>
  )
})

/**
 * The chips of the group the strip switched from (§11.4): a layer over the tray, out of the
 * flow and out of reach, holding the group's dot and its members' chips where they stood – the
 * members clipped and edge-faded at the scroller's box as they were – fading out as one over
 * the chips that took their slots. Gone once the fade has landed.
 */
function GhostLayer({
  ghosts,
  onDone
}: {
  ghosts: StripGhosts
  onDone: (key: number) => void
}): JSX.Element {
  const layer = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    return fadeOver(el, 1, 0, GROUP_SWITCH_FADE_MS, () => onDone(ghosts.key))
  }, [ghosts.key, onDone])
  return (
    <div
      ref={layer}
      className="zen-group-ghosts"
      data-strip-ghosts={ghosts.group.id}
      aria-hidden
      style={{ '--zen-group-rgb': groupColorChannels(ghosts.group.color) } as CSSProperties}
    >
      <span className="zen-group-chip zen-group-chip-exit" style={{ left: ghosts.show }}>
        <span className="zen-group-chip-face">
          <GroupBadge folder={ghosts.group} />
        </span>
      </span>
      <div
        className="zen-group-ghost-members"
        data-fade-axis="x"
        style={
          {
            left: ghosts.box.left,
            width: ghosts.box.width,
            '--zen-fade-start': ghosts.fade[0],
            '--zen-fade-end': ghosts.fade[1]
          } as CSSProperties
        }
      >
        {ghosts.cells.map((cell) => (
          <span
            key={cell.tab.id}
            className="zen-group-chip zen-group-chip-exit"
            data-strip-ghost={cell.tab.id}
            aria-current={cell.tab.id === ghosts.active ? 'true' : undefined}
            style={{ left: cell.x }}
          >
            <span className="zen-group-chip-face">
              <Favicon tab={cell.tab} size={16} />
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * A member's chip: its favicon in a 36 circle, the cell the tracker glides. The face inside is
 * what the entrance scales – the cell's own transform belongs to the tracker, which writes it
 * every frame of a glide. How it arrives – on the spring as a member joining a strip already
 * showing, by a 120 ms fade as the strip switches to its group (§11.4), or not at all – is the
 * ledger's answer, asked in the layout effect that runs before the strip's own.
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
    const how = el && ledger ? ledger.arrival(groupId, tab.id) : null
    if (!el || !ledger || !how) return
    const settled = (): void => ledger.arrived(tab.id)
    // A switch of group is the same 120 ms fade with or without reduced motion (§11.4); an
    // entrance under reduced motion is that fade in place of its spring (§11.3).
    if (how === 'fade') return fadeOver(el, 0, 1, GROUP_SWITCH_FADE_MS, settled)
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
      restFace(el)
      settled()
    })
    spring.start(CHIP_TRAVEL, 0, 0)
    // Small and clear from this commit: the spring's first frame is a frame away.
    moveFace(el)
    draw(CHIP_TRAVEL)
    return () => {
      spring.stop()
      restFace(el)
    }
  }, [ledger, groupId, tab.id])
  const title = tabTitle(tab) || tab.url
  return (
    <button
      type="button"
      className="zen-group-chip"
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
    moveFace(el)
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

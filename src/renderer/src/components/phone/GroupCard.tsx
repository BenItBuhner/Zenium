import type { CSSProperties, JSX, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type { Folder, Tab } from '@shared/types'
import { OVERVIEW_LABELS } from '@shared/overviewMenu'
import { useOnScreen } from '@renderer/hooks/useOnScreen'
import { accessibilityStore } from '@renderer/lib/accessibilityState'
import { run } from '@renderer/lib/api'
import { groupColorVars } from '@renderer/lib/groups'
import { CELL_ATTR, layoutAnimations } from '@renderer/lib/motion/flip'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { groupCardLabel } from '@renderer/lib/overviewLabels'
import { noteGroupFolded, noteGroupUnfolded } from '@renderer/lib/overviewUi'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { GroupGlyph } from '../GroupGlyph'
import { departStore } from './departureStore'
import { groupCardControls } from './groupActions'
import { groupHeaderHeight } from './groupCardHeader'
import { foldedCardHeight, mosaicOf, MOSAIC_TILES } from './groupMosaic'
import { TabPreview } from './TabPreview'
import { liftStore } from './useCardLift'
import { useLongPress } from './useLongPress'

/** Inset of the member cards inside the group card: its radius is the card radius plus this. */
export const GROUP_PAD = 6

/**
 * How far past the grid's edges the folded card's mosaic counts as on screen (`useOnScreen`,
 * from the grid it scrolls in): the tab card's lookahead (`OverviewCard`), a row of cards.
 */
const MOSAIC_LOOKAHEAD = '35% 0px'

/**
 * The folded card's height: a cell at the grid's card aspect (`--zen-overview-card-aspect`, the
 * tablet's frame ratio, or the phone's 3 / 4 where none is set – `CARD_ASPECT` in
 * `OverviewCard`), read off the shell itself; a shell with no width yet answers its header.
 */
function foldedHeightOf(shell: HTMLElement, header: number): number {
  const aspect = getComputedStyle(shell).getPropertyValue('--zen-overview-card-aspect')
  return foldedCardHeight(shell.offsetWidth, aspect.trim() || '3 / 4', header)
}

interface Props {
  folder: Folder
  tabs: Tab[]
  card: (tab: Tab) => JSX.Element
  /** The header held, or its ⋯: the group's sheet (`GroupSheet`) opens. */
  onMenu: (folder: Folder) => void
  /** New Tab in Group, Close Group and Delete Group: the sheet's rows that reach past the card (`groupActions`). */
  onNewTab: (folder: Folder) => void
  onCloseGroup: (folder: Folder) => void
  onDelete: (folder: Folder) => void
  /** Columns of the overview grid: a group of two or more spans them all and lays out in as many. */
  columns: number
  /**
   * The group has just been made while the grid was on screen (v2 §11.4): it grows on its
   * spring out of the bare row of cards it was made from, and its header and tint stay off until
   * the tracker releases the cells below at the end of the glide (`onRelease`).
   */
  forming?: boolean
  /**
   * The group has lost its last card while on screen (v2 §11.4): it shrinks to nothing on its
   * spring while the card glides out, the cells below waiting, and calls `onDissolved` once it
   * has – the owner takes it off the grid then, header and tint going with it. `held` is how
   * many cards it had: the span and the count it keeps while it shrinks, so the row stands still
   * around it.
   */
  dissolving?: boolean
  held?: number
  onDissolved?: (folder: Folder) => void
  /** Subscribe to the FLIP tracker's release (see `FlipTracker.onRelease`). */
  onRelease?: (listener: () => void) => () => void
}

/**
 * A tab group in the overview (`docs/tab-overview-cleanup-spec.md` §2): FOLDED it is ONE CARD
 * in the group's place – a cell at the card aspect among the tab cards, the group's name and
 * colour in its header row, its count the aside, and a 2×2 mosaic of its members' captures
 * under them (`GroupMosaic`); a tap anywhere on it opens the group in place. OPEN it is the
 * tinted card spanning the row with the same header – the ⋯ beside it opening the group's
 * options – and its tabs as cards in a grid below; the header folds it. The height runs on a
 * spring – on a fold, and whenever what the card holds changes height (a card entering or
 * leaving, a row coming or going with the count or the columns) – that a change mid-flight
 * retargets; the cells below wait for it through the FLIP tracker (`layoutAnimations`, v2
 * §11.4), and the mosaic and the member cards cross-fade (120 ms, the stylesheet's) as the
 * height runs. The card is the grid's cell `group:<id>` for the glide and the morph.
 */
export function GroupCard({
  folder,
  tabs,
  card,
  onMenu,
  onNewTab,
  onCloseGroup,
  onDelete,
  columns,
  forming,
  dissolving = false,
  held,
  onDissolved,
  onRelease
}: Props): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapsed = folder.collapsed
  const key = `group:${folder.id}`
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const touchExploring = accessibilityStore.use((s) => s.touchExploration)
  const targeted = liftStore.use(
    (s) =>
      s.phase === 'dragging' &&
      s.tabId !== null &&
      !tabs.some((t) => t.id === s.tabId) &&
      (s.target === key || tabs.some((t) => s.target === `card:${t.id}`))
  )

  // A group being made shows no header and no tint until the end of the glide – radius, header
  // and tint are not animated properties (v2 §11.4). Subscribed before the height effect below
  // runs the spring: under reduced motion it settles, and the tracker releases, within that
  // very effect.
  const [chromeOff, setChromeOff] = useState(Boolean(forming))
  useLayoutEffect(() => {
    if (!chromeOff || !onRelease) return
    return onRelease(() => setChromeOff(false))
  }, [chromeOff, onRelease])

  const latest = useRef({ folder, dissolving, onDissolved })
  useLayoutEffect(() => {
    latest.current = { folder, dissolving, onDissolved }
  })
  // The height is the card's own business, never React's: collapsed it is clipped to its header,
  // expanded it is whatever the body needs, dissolving it is nothing, and between any two heights
  // a spring runs from wherever the card is right now. `settled` is the height the grid was last
  // laid out at – what the tracker's positions assume – so a change in the body is caught on the
  // commit it lands: the height effect below runs on that commit, and on no other.
  const mounted = useRef(false)
  const settled = useRef<number | null>(null)
  const wasCollapsed = useRef(collapsed)
  const spring = useRef<SpringAnimation | null>(null)
  useLayoutEffect(() => {
    const anim = new SpringAnimation(
      SPRING_GENTLE,
      (h) => {
        const floor = latest.current.dissolving ? 0 : groupHeaderHeight()
        const height = Math.max(floor, h)
        if (shellRef.current) shellRef.current.style.height = `${height}px`
        layoutAnimations.frame(key, height)
        // Folding to the header (or shrinking away), the written height stops at the floor the
        // frame the spring passes it, and the spring's way to rest beneath it – the §7 hair of
        // overshoot and back, ~100 ms at 60 Hz, one or two of a slow emulator's frames – would
        // draw nothing while the cells below wait for it (PERF-5, #349): the card is at rest here.
        if (h <= floor && anim.destination <= floor) anim.settle()
      },
      () => {
        const shell = shellRef.current
        const { dissolving, onDissolved, folder } = latest.current
        if (shell) {
          if (dissolving) {
            // Gone: no longer a cell for the tracker's release to measure; the owner takes the
            // card off the grid on the next render.
            shell.style.height = '0px'
            shell.style.display = 'none'
            shell.removeAttribute(CELL_ATTR)
          } else {
            // At rest the stylesheet holds the height – a collapsed card at its header's
            // (`.zen-group[data-collapsed]`), so a text-size change while it stands reaches it.
            shell.style.height = ''
            delete shell.dataset.clip
          }
        }
        layoutAnimations.end(key)
        if (dissolving) onDissolved?.(folder)
      }
    )
    spring.current = anim
    return () => {
      anim.stop()
      spring.current = null
      layoutAnimations.end(key)
      // Back to before the mount: StrictMode (every dev build) runs this cleanup and mounts
      // again at once, and the height effect below must then take its mount branch again – a
      // group being made sets out from the bare row a second time – rather than find the card
      // "mounted" at a height whose spring this cleanup has just stopped.
      mounted.current = false
      settled.current = null
    }
  }, [key])

  // The fold measurement. `body.offsetHeight` is a forced layout, so the effect runs only on a
  // commit that can have moved the height – a fold or unfold, a card entering or leaving (the
  // count: the body's rows are the cards over the columns), the grid's columns, the group
  // forming or dissolving – and not on every render of the grid around it: the overview's phase
  // renders (lift, pick, settle) re-render every card, and a layout per group card per commit
  // was 34 ms of the baseline pick's script on six tabs, 52 on thirty (PERF-5, #315), 11 / 31
  // with fewer renders. Which cards the group holds, the card renderer's identity and the menu
  // callback change nothing the effect reads. A fold reads no body: the folded card's height is
  // its cell's at the card aspect, from the shell's own width (`foldedHeightOf`).
  const members = tabs.length
  useLayoutEffect(() => {
    const shell = shellRef.current
    const body = bodyRef.current
    const anim = spring.current
    if (!shell || !body || !anim) return
    const header = groupHeaderHeight()
    const to = dissolving
      ? 0
      : collapsed
        ? foldedHeightOf(shell, header)
        : header + body.offsetHeight
    const run = (from: number, velocity: number): void => {
      layoutAnimations.start(key, from, to, !dissolving)
      shell.style.display = ''
      shell.style.height = `${from}px`
      settled.current = to
      anim.start(from, velocity, to)
    }
    if (!mounted.current) {
      mounted.current = true
      if (forming && !collapsed) {
        // Out of the row of cards it was made from: header and tint come at the end.
        run(Math.max(header, body.offsetHeight - GROUP_PAD), 0)
      } else {
        shell.style.height = ''
        settled.current = to
      }
      return
    }
    // Folding or unfolding, and shrinking to nothing, the card is clipped to the shell until it
    // has come to rest.
    if (collapsed !== wasCollapsed.current || dissolving) shell.dataset.clip = ''
    wasCollapsed.current = collapsed
    if (dissolving && shell.style.position !== 'absolute') {
      // Out of the grid's flow, where it stood: the card its last member became takes its cell
      // and glides there once, the cells below wait for the height as they would for any group,
      // and the card shrinks away under the loose card (which is positioned, and paints over it).
      // `offsetTop` is a layout distance – no transform in it, no scroll either – read against
      // the nearest positioned ancestor, and `top` places the shell against the same box: the
      // grid the shell is a child of is positioned for it (`TabOverview`), so the box stands
      // where the card stood and scrolls with the cells. Against an ancestor outside the
      // scroller the shell would land `scrollTop` px too low, and the tracker would hold only
      // the cells drawn under that lower box: the row beneath the group gliding at once, the
      // rows further down after the settle – two waves (#355's finding, seed 49).
      const { offsetLeft, offsetTop, offsetWidth } = shell
      shell.style.position = 'absolute'
      shell.style.left = `${offsetLeft}px`
      shell.style.top = `${offsetTop}px`
      shell.style.width = `${offsetWidth}px`
    }
    if (anim.running) {
      if (Math.abs(to - anim.destination) >= 0.5) {
        settled.current = to
        layoutAnimations.retarget(key, to)
        anim.retarget(to)
      }
      return
    }
    const from = settled.current ?? to
    if (Math.abs(to - from) < 0.5) {
      settled.current = to
      return
    }
    run(from, 0)
  }, [key, collapsed, dissolving, forming, members, columns])

  const press = useLongPress(() => onMenu(folder))
  // The header's tap unfolds and folds (§2); an unfold is noted for the system back to undo
  // (`TabOverview` registers the surface – `backFoldTarget`), a fold takes the note back.
  const toggle = (): void => {
    if (press.swallowsClick()) return
    if (renaming) return
    run('folder.update', { folderId: folder.id, patch: { collapsed: !collapsed } })
    if (collapsed) noteGroupUnfolded(folder.id)
    else noteGroupFolded(folder.id)
  }

  // Closing: the exit drawn over the card takes its place until the browser removes the tabs.
  const departing = departStore.use((s) => s.items.some((i) => i.key === `group:${folder.id}`))
  const style = {
    ...groupColorVars(folder.color),
    opacity: departing ? 0 : undefined
  } as CSSProperties
  // Folded, the group is one cell among the cards (§2). Open, a group of one takes a single
  // column, like the card it holds; two or more span the row, however many columns the window
  // gives it, and lay their cards out in the same columns. A group shrinking to nothing keeps
  // the span and the count it had.
  const count = dissolving ? (held ?? 0) : tabs.length
  const single = count <= 1
  const oneCell = collapsed || single
  const name = folder.name.trim()
  return (
    <div
      ref={shellRef}
      className={cn('zen-group flex flex-col', oneCell ? 'col-span-1' : 'col-span-full')}
      style={style}
      data-group-rgb=""
      data-cell={key}
      data-targeted={targeted || undefined}
      data-collapsed={collapsed || undefined}
      data-chrome={chromeOff ? 'off' : undefined}
      data-dissolving={dissolving || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={groupCardLabel(folder.name, count)}
        aria-expanded={!collapsed}
        className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2"
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle()
        }}
        {...press.handlers}
      >
        <GroupGlyph folder={folder} />
        {renaming ? (
          <GroupRename folder={folder} />
        ) : (
          // A nameless group is its dot and its count (§2): the name's slot stands empty.
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        )}
        {/* The count is the aside in both states (§9.36; #360's verdict): the tablet row's 13
            tabular at 69%, never a badge – a pill on the tinted header would be two fills
            stacked, and a header carrying the group's dot never carries a badge too (§9.19). */}
        <span className="zen-group-row-count" data-testid="group-card-count">
          {count}
        </span>
        {/* Open, the header's trailing 44 is the ⋯'s (laid beside the header below, as the tab
            card lays its close); folded, the count ends the row and the card is the affordance. */}
        {!collapsed && <span className="h-11 w-11 shrink-0" aria-hidden />}
      </div>
      {/*
        The ⋯ of the open group (§2: Rename, Colour, New Tab in Group, Ungroup, Close Group,
        Delete Group – the group's sheet, which the header's hold opens too). Beside the header,
        not inside it: this WebView reads a focusable, named node as one leaf and drops a
        button nested in it from the tree (A11Y-01), so a nested ⋯ was never a TalkBack stop.
        Over the header's trailing end, the 44 the row keeps clear for it.
      */}
      {!collapsed && !dissolving && (
        <button
          type="button"
          className="zen-toolbar-button zen-group-options absolute right-1 top-0 h-11 w-11 rounded-[10px]"
          aria-label={OVERVIEW_LABELS.groupOptions}
          aria-haspopup="dialog"
          data-testid="group-card-options"
          onClick={(e) => {
            e.stopPropagation()
            onMenu(folder)
          }}
        >
          <Ellipsis className="h-5 w-5" />
        </button>
      )}
      {touchExploring && !dissolving && (
        <GroupCardControls
          folder={folder}
          count={count}
          onNewTab={onNewTab}
          onCloseGroup={onCloseGroup}
          onDelete={onDelete}
        />
      )}
      <div
        ref={bodyRef}
        className="zen-group-members grid gap-3"
        style={{
          padding: GROUP_PAD,
          paddingTop: 0,
          gridTemplateColumns: `repeat(${single ? 1 : columns}, minmax(0, 1fr))`
        }}
        aria-hidden={collapsed || undefined}
      >
        {tabs.map(card)}
      </div>
      {/* The folded face: the mosaic under the header, and the whole card as the tap – a plain
          overlay with no name of its own (the header is the control the tree reads) that
          takes the tap and the hold the header takes. */}
      {!dissolving && <GroupMosaic tabs={tabs} shellRef={shellRef} />}
      {collapsed && !dissolving && (
        <div
          className="zen-group-tap absolute inset-0"
          aria-hidden
          data-testid="group-card-tap"
          onClick={toggle}
          {...press.handlers}
        />
      )}
    </div>
  )
}

/**
 * The folded card's 2×2 mosaic (§2): the members' captures as tiles – all of them up to four,
 * else three and a "+N" tile naming the rest (`mosaicOf`) – with the tiles a smaller group leaves
 * empty drawn as quiet slots, so the face is a two-by-two whatever the count. Laid under the
 * header over the member cards' place and faded by the stylesheet with the fold
 * (`.zen-group-mosaic`); it reads nothing to assistive technology – the header's sentence names
 * the group and its count – and holds its pictures only while the card is on screen or a row
 * from it, as the tab cards do (`useOnScreen`).
 */
function GroupMosaic({
  tabs,
  shellRef
}: {
  tabs: readonly Tab[]
  shellRef: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const visible = useOnScreen(shellRef, MOSAIC_LOOKAHEAD)
  const { tiles, more } = mosaicOf(tabs)
  const empty = Math.max(0, MOSAIC_TILES - tiles.length - (more > 0 ? 1 : 0))
  return (
    <div className="zen-group-mosaic" aria-hidden data-testid="group-card-mosaic">
      {tiles.map((tab) => (
        <div key={tab.id} className="zen-group-tile" data-tile={tab.id}>
          <TabPreview tab={tab} scale={0.45} visible={visible} />
        </div>
      ))}
      {more > 0 && (
        <div className="zen-group-tile zen-group-tile-more" data-tile="more">
          +{more}
        </div>
      )}
      {Array.from({ length: empty }, (_, i) => (
        <div key={`empty-${i}`} className="zen-group-tile zen-group-tile-empty" data-tile="empty" />
      ))}
    </div>
  )
}

/**
 * The group's actions as controls a reader reaches (A11Y-10), drawn under touch exploration
 * alone: the hold sheet's rows – Rename, Ungroup, Close Group, Delete Group (`groupCardControls`;
 * the fold is the header's own tap and its `aria-expanded`) – by the same names, next after the
 * header in the reading order and out of sight (`sr-only`: a one-pixel box, not `display: none`,
 * so the tree has them). The hold that opens the sheet is a gesture TalkBack passes through to
 * the page (double-tap and hold), not an action the WebView exposes: Chromium's bridge
 * advertises no `ACTION_LONG_CLICK` and ARIA has no custom-action vocabulary, so TalkBack's
 * actions menu on the header lists Collapse / Expand and nothing of the sheet's; these controls
 * put the sheet's rows within a swipe of the header. Without touch exploration nothing is drawn:
 * a keyboard's Tab would stop on controls it cannot see.
 */
function GroupCardControls({
  folder,
  count,
  onNewTab,
  onCloseGroup,
  onDelete
}: {
  folder: Folder
  count: number
  onNewTab: (folder: Folder) => void
  onCloseGroup: (folder: Folder) => void
  onDelete: (folder: Folder) => void
}): JSX.Element {
  const controls = groupCardControls(folder, count, {
    newTabInGroup: onNewTab,
    closeGroup: onCloseGroup,
    deleteGroup: onDelete
  })
  return (
    <div className="relative" data-testid="group-card-controls">
      {controls.map((action) => (
        <button
          key={action.id}
          type="button"
          className="sr-only"
          data-group-action={action.id}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The group's name being edited in place (`uiStore.renamingFolderId`): in the open group's card
 * header, and in the saved group's card (TAB-16, `SavedGroupCard`) – a host's own size through
 * `className`. Enter and a blur save a changed, non-empty name; Escape keeps the old one.
 */
export function GroupRename({
  folder,
  className
}: {
  folder: Folder
  className?: string
}): JSX.Element {
  const [value, setValue] = useState(folder.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (save: boolean): void => {
    if (uiStore.get().renamingFolderId === folder.id) uiStore.set({ renamingFolderId: null })
    if (save && value.trim() && value.trim() !== folder.name)
      run('folder.update', { folderId: folder.id, patch: { name: value.trim() } })
  }
  return (
    <input
      ref={ref}
      value={value}
      aria-label={OVERVIEW_LABELS.groupName}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
        e.stopPropagation()
      }}
      className={cn(
        'min-w-0 flex-1 rounded-[8px] bg-[var(--zen-element-bg)] px-2 py-0.5 text-[13px] font-medium outline-none',
        className
      )}
    />
  )
}

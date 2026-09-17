import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelLeft, PanelRight, Plus } from 'lucide-react'
import type {
  Folder,
  FolderColor,
  PhoneBarPosition,
  Rect,
  Space,
  Tab,
  UIState
} from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { cmd, run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { openSpacesDrawer } from '@renderer/lib/gestures/drawer'
import {
  closeOverview,
  overviewInteractive,
  type OverviewState
} from '@renderer/lib/gestures/stage'
import { groupColorHex, groupsOf, nextGroupColor } from '@renderer/lib/groups'
import { overviewColumns } from '@renderer/lib/layout'
import { FRAME_SHADOW, cardShadow, lerpShadow, shadowCss } from '@renderer/lib/motion/elevation'
import {
  activeSpace,
  activeTab,
  essentialsFor,
  isDarkScheme,
  pinnedOf,
  regularOf,
  tabTitle
} from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { SpaceGlyph } from '../SpaceGlyph'
import { DEFAULT_FOLDER_ICON, GroupCard } from './GroupCard'
import { CARD_HEADER, CARD_RADIUS, CardBody, OverviewCard } from './OverviewCard'
import { OverviewSheet, type SheetAction } from './OverviewSheet'
import { TabPreview } from './TabPreview'
import { cancelLift, liftStore, settleLift, type LiftTarget } from './useCardLift'
import { useFlip } from './useFlip'
import { useOverviewHandle } from './usePillGestures'

/** Name a group gets when a gesture makes it; the header renames it in a tap. */
const NEW_GROUP_NAME = 'Group'
/** How long a dropped card waits for the browser to confirm its new place before it lands anyway. */
const DROP_TIMEOUT_MS = 900

interface Props {
  state: UIState
  overview: OverviewState
  /** Where the page normally is, in window coordinates. */
  area: Rect
  /** Edge the address bar is docked at: the overview fills the rest of the screen. */
  edge: PhoneBarPosition
}

type Sheet = { kind: 'tab'; tabId: string } | { kind: 'group'; folderId: string }

interface PendingDrop {
  /** True once the browser state shows the drop – then the card's new slot can be measured. */
  landed: (state: UIState) => boolean
  deadline: number
}

/**
 * The tab overview of the phone layout: the active space's tabs as a grid of thumbnail cards –
 * Essentials on top, pinned tabs first, groups as tinted cards of their own – with the other
 * spaces as a strip of chips. Its entrance is driven by `overview.progress`: the grid scales and
 * fades in while the page shrinks into the slot of its own card (and grows back out of the card
 * that is picked when leaving), so a half-finished drag always shows exactly where things are
 * going. Cards can be held and dragged onto each other to make groups (see `useCardLift`).
 */
export function TabOverview({ state, overview, area, edge }: Props): JSX.Element {
  const { progress, phase, heroTabId } = overview
  const space = activeSpace(state)
  const active = activeTab(state)
  const essentials = essentialsFor(state, space)
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  const groups = groupsOf(state, space.id)
  const loose = regular.filter((t) => !t.folderId || !state.folders[t.folderId])
  const count = essentials.length + pinned.length + regular.length
  const hero = heroTabId ? (state.tabs[heroTabId] ?? null) : null
  const p = Math.min(1, Math.max(0, progress))
  // Taps work as soon as the overview is heading open; layout tracking waits for it to rest.
  const interactive = overviewInteractive(overview)
  const settled = phase === 'open'
  const side = state.settings.sidebarSide
  const isDark = isDarkScheme(state)
  // A phone on its side gets a row of four smaller cards, as Chrome's grid does.
  const columns = overviewColumns(useViewport().width)

  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fadeGrid = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const cells = useRef(new Map<string, HTMLElement>())
  const [heroCell, setHeroCell] = useState<Rect | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const handle = useOverviewHandle({ edge })
  const flip = useFlip(cells, scrollRef, settled)

  // Where the hero's own card sits, in layout space (the root's entrance scale divided out). A
  // hero inside a collapsed group has no card to land on: it heads for the group's card instead
  // and fades into it.
  const heroGroup = hero?.folderId ? (state.folders[hero.folderId] ?? null) : null
  const heroCellKey = heroGroup?.collapsed ? `group:${heroGroup.id}` : heroTabId
  const heroFades = Boolean(heroGroup?.collapsed)
  const cardsKey = [...essentials, ...pinned, ...regular].map((t) => t.id).join('|')
  const measure = (): void => {
    const root = rootRef.current
    const cell = heroCellKey ? cells.current.get(heroCellKey) : undefined
    if (!root || !cell) {
      setHeroCell(null)
      return
    }
    const r = cell.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    const scale = root.offsetWidth ? rr.width / root.offsetWidth : 1
    const cx = rr.left + rr.width / 2
    const cy = rr.top + rr.height / 2
    setHeroCell({
      x: cx + (r.left - cx) / scale,
      y: cy + (r.top - cy) / scale,
      width: r.width / scale,
      height: r.height / scale
    })
  }
  useLayoutEffect(() => {
    const cell = heroCellKey ? cells.current.get(heroCellKey) : undefined
    // The page morphs out of / into its card: make sure that card is fully on screen first.
    const morphing = (phase === 'dragging' && progress < 0.05) || phase === 'settling'
    if (cell && morphing) cell.scrollIntoView({ block: 'nearest' })
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the layout inputs change
  }, [heroCellKey, cardsKey, area.width, area.height, phase])

  // Escape closes the overview – unless a sheet or the Spaces drawer is up over it; the top
  // surface takes the key, and the next Escape reaches the overview.
  const sheetOpen = sheet !== null
  const drawerOpen = uiStore.use((s) => s.drawerOpen)
  useEffect(() => {
    if (!interactive || sheetOpen || drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeOverview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [interactive, sheetOpen, drawerOpen])

  // A card in the hand has nowhere to go once the overview leaves (the sheet stays in state but
  // off screen; the overview unmounts altogether when it is closed).
  useEffect(() => {
    if (!interactive) cancelLift()
  }, [interactive])
  useEffect(() => () => cancelLift(), [])

  // A dropped card flies to its new slot once the browser has moved it there.
  const liftPhase = liftStore.use((s) => s.phase)
  const liftTabId = liftStore.use((s) => s.tabId)
  const pendingDrop = useRef<PendingDrop | null>(null)
  useLayoutEffect(() => {
    const pending = pendingDrop.current
    if (!pending || liftPhase !== 'dropping' || !liftTabId) return
    if (!pending.landed(state) && performance.now() < pending.deadline) return
    pendingDrop.current = null
    // The slot as laid out (any glide in flight stripped); before the grid has settled nothing
    // is tracked yet and the cell's own box is the answer.
    const rect = flip.layoutRect(liftTabId) ?? cells.current.get(liftTabId)?.getBoundingClientRect()
    const origin = liftStore.get().origin
    const to = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : origin
    if (to) settleLift(to)
    else cancelLift()
  })
  useEffect(() => {
    // The browser may never confirm (the command failed): land the card where it is regardless.
    const pending = pendingDrop.current
    if (!pending || liftPhase !== 'dropping') return
    const timer = setTimeout(
      () => {
        if (pendingDrop.current === pending) {
          pendingDrop.current = null
          const s = liftStore.get()
          if (s.phase === 'dropping' && s.origin) settleLift(s.origin)
        }
      },
      Math.max(0, pending.deadline - performance.now())
    )
    return () => clearTimeout(timer)
  }, [liftPhase])

  const pick = (tab: Tab): void => closeOverview(tab.id)
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) cells.current.set(id, el)
    else cells.current.delete(id)
  }

  const groupTabs = (tabIds: string[], folderId: string): void => {
    for (const tabId of tabIds) run('tab.moveToFolder', { tabId, folderId })
  }
  const makeGroup = async (tabIds: string[], rename: boolean): Promise<string | null> => {
    try {
      const folderId = await cmd('folder.create', {
        spaceId: space.id,
        name: NEW_GROUP_NAME,
        icon: DEFAULT_FOLDER_ICON,
        color: nextGroupColor(state, space.id),
        rename
      })
      groupTabs(tabIds, folderId)
      return folderId
    } catch {
      return null
    }
  }

  /**
   * A card was dropped: act on the target, then let the settle effect above fly the ghost to
   * the card's slot once the browser shows it there (straight away when nothing changes).
   */
  const dropCard = (tab: Tab, target: LiftTarget | null): void => {
    const expect = (landed: (s: UIState) => boolean): void => {
      pendingDrop.current = { landed, deadline: performance.now() + DROP_TIMEOUT_MS }
    }
    const unchanged = (): void => expect(() => true)
    if (!target) return unchanged()
    if (target === 'loose') {
      if (!tab.folderId) return unchanged()
      run('tab.moveToFolder', { tabId: tab.id, folderId: null })
      return expect((s) => !s.tabs[tab.id]?.folderId)
    }
    if (target.startsWith('group:')) {
      const folderId = target.slice('group:'.length)
      if (!state.folders[folderId] || tab.folderId === folderId) return unchanged()
      run('tab.moveToFolder', { tabId: tab.id, folderId })
      return expect((s) => s.tabs[tab.id]?.folderId === folderId)
    }
    if (target.startsWith('card:')) {
      const other = state.tabs[target.slice('card:'.length)]
      if (!other || other.id === tab.id || other.pinned || other.essential) return unchanged()
      const theirs = other.folderId && state.folders[other.folderId] ? other.folderId : null
      if (theirs) {
        // Dropped on a member of a group: join that group.
        if (tab.folderId === theirs) return unchanged()
        run('tab.moveToFolder', { tabId: tab.id, folderId: theirs })
        return expect((s) => s.tabs[tab.id]?.folderId === theirs)
      }
      void makeGroup([other.id, tab.id], false)
      return expect((s) => {
        const mine = s.tabs[tab.id]?.folderId
        return Boolean(mine) && mine === s.tabs[other.id]?.folderId
      })
    }
    unchanged()
  }

  const card = (tab: Tab): JSX.Element => (
    <OverviewCard
      key={tab.id}
      ref={register(tab.id)}
      tab={tab}
      active={tab.id === active?.id}
      hidden={tab.id === heroTabId && p < 1}
      onPick={pick}
      lift={{
        enabled: interactive && !tab.pinned,
        scroller: () => scrollRef.current,
        onMenu: (t) => setSheet({ kind: 'tab', tabId: t.id }),
        onDrop: dropCard
      }}
    />
  )

  const heroRect = hero ? lerpRect(area, heroCell ?? shrunk(area), p) : null
  const contentRadius =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--zen-content-radius')
    ) || 12
  const heroActive = Boolean(hero && hero.id === active?.id)
  const draggedTab = liftTabId ? state.tabs[liftTabId] : null
  const showLooseStrip = liftPhase === 'dragging' && Boolean(draggedTab?.folderId)

  return (
    <>
      <div
        className="absolute"
        style={{
          left: 'var(--zen-inset-left)',
          right: 'var(--zen-inset-right)',
          top:
            edge === 'top'
              ? 'calc(var(--zen-phone-bar) + var(--zen-inset-top))'
              : 'var(--zen-inset-top)',
          bottom:
            edge === 'bottom'
              ? 'calc(var(--zen-phone-bar) + var(--zen-inset-bottom))'
              : 'var(--zen-inset-bottom)',
          pointerEvents: interactive ? 'auto' : 'none'
        }}
      >
        <div
          ref={rootRef}
          className="zen-overview absolute inset-0 flex flex-col"
          style={{
            opacity: Math.min(1, p * 1.6),
            transform: `scale(${0.94 + 0.06 * p})`
          }}
        >
          <header className="flex h-14 shrink-0 items-center gap-2.5 px-3" {...handle}>
            <SpaceGlyph icon={space.icon} size={20} />
            <span className="zen-title min-w-0 truncate">{space.name}</span>
            <span className="shrink-0 text-[13px] tabular-nums text-[var(--zen-muted)]">
              {count} tab{count === 1 ? '' : 's'}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="zen-toolbar-button h-9 w-9"
              aria-label="Spaces"
              onClick={() => void openSpacesDrawer(active?.id ?? null)}
            >
              {side === 'right' ? (
                <PanelRight className="h-[18px] w-[18px]" />
              ) : (
                <PanelLeft className="h-[18px] w-[18px]" />
              )}
            </button>
          </header>
          {state.spaces.length > 1 && <SpaceStrip spaces={state.spaces} activeId={space.id} />}
          <div
            ref={(el) => {
              scrollRef.current = el
              return fadeGrid(el)
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1"
            // The card the page morphs into is scrolled into view: keep it clear of the fades.
            style={{ touchAction: 'pan-y', overscrollBehavior: 'contain', scrollPaddingBlock: 16 }}
            onScroll={measure}
          >
            {essentials.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {essentials.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="zen-essential h-12 w-12"
                    data-active={tab.id === active?.id}
                    data-discarded={tab.discarded}
                    aria-label={tabTitle(tab)}
                    onClick={() => pick(tab)}
                  >
                    <Favicon tab={tab} size={22} />
                  </button>
                ))}
              </div>
            )}
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {pinned.map(card)}
              {groups.map((folder) => {
                const members = regular.filter((t) => t.folderId === folder.id)
                if (members.length === 0) return null
                return (
                  <GroupCard
                    key={folder.id}
                    ref={register(`group:${folder.id}`)}
                    folder={folder}
                    tabs={members}
                    card={card}
                    onMenu={(f) => setSheet({ kind: 'group', folderId: f.id })}
                  />
                )
              })}
              {loose.map(card)}
              {showLooseStrip && <LooseStrip />}
              <NewTabCard />
            </div>
          </div>
        </div>
        <LiftGhost state={state} activeTabId={active?.id ?? null} />
      </div>
      {hero && heroRect && p < 1 && (
        <div
          className="zen-stage-card zen-overview-hero pointer-events-none absolute flex flex-col"
          style={{
            left: heroRect.x,
            top: heroRect.y,
            width: heroRect.width,
            height: heroRect.height,
            borderRadius: contentRadius + (CARD_RADIUS - contentRadius) * p,
            boxShadow: shadowCss(lerpShadow(FRAME_SHADOW, cardShadow(isDark), p)),
            opacity: heroFades ? 1 - Math.max(0, (p - 0.55) / 0.45) : 1
          }}
        >
          <div
            className="relative flex shrink-0 items-center gap-2 overflow-hidden pl-3 pr-1"
            style={{ height: CARD_HEADER * p, opacity: p }}
          >
            {heroActive && (
              <div
                className="absolute inset-0"
                style={{ background: 'rgb(var(--zen-accent-rgb) / 0.14)' }}
              />
            )}
            <Favicon tab={hero} size={16} className="relative" />
            <span className="relative min-w-0 flex-1 truncate text-[13px] font-medium">
              {tabTitle(hero)}
            </span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <TabPreview tab={hero} scale={1 - 0.2 * p} />
          </div>
        </div>
      )}
      {interactive && sheet?.kind === 'tab' && state.tabs[sheet.tabId] && (
        <TabSheet
          state={state}
          tab={state.tabs[sheet.tabId]}
          groups={groups}
          onClose={() => setSheet(null)}
          onNewGroup={(tab) => void makeGroup([tab.id], true)}
        />
      )}
      {interactive && sheet?.kind === 'group' && state.folders[sheet.folderId] && (
        <GroupSheet
          folder={state.folders[sheet.folderId]}
          count={regular.filter((t) => t.folderId === sheet.folderId).length}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}

/** The card in the hand: follows the finger, tucks in over a target, flies into its slot. */
function LiftGhost({
  state,
  activeTabId
}: {
  state: UIState
  activeTabId: string | null
}): JSX.Element | null {
  const lift = liftStore.use()
  if (lift.phase === 'idle' || !lift.ghost || !lift.tabId) return null
  const tab = state.tabs[lift.tabId]
  if (!tab) return null
  return (
    <div
      className="zen-overview-card zen-overview-ghost pointer-events-none fixed z-30 flex flex-col overflow-hidden"
      data-active={tab.id === activeTabId}
      data-landing={lift.phase === 'dropping' || undefined}
      style={{
        left: lift.ghost.x,
        top: lift.ghost.y,
        width: lift.ghost.width,
        height: lift.ghost.height,
        transform: `scale(${lift.scale})`
      }}
    >
      <CardBody tab={tab} closable={false} />
    </div>
  )
}

/** Landing strip for a grouped card being dragged: drop it here to take it out of its group. */
function LooseStrip(): JSX.Element {
  const targeted = liftStore.use((s) => s.target === 'loose')
  return (
    <div
      className="zen-loose-strip col-span-full flex h-14 items-center justify-center text-[13px] font-medium"
      data-drop="loose"
      data-targeted={targeted || undefined}
    >
      Remove from group
    </div>
  )
}

function TabSheet({
  state,
  tab,
  groups,
  onClose,
  onNewGroup
}: {
  state: UIState
  tab: Tab
  groups: Folder[]
  onClose: () => void
  onNewGroup: (tab: Tab) => void
}): JSX.Element {
  const current = tab.folderId && state.folders[tab.folderId] ? tab.folderId : null
  const actions: SheetAction[] = []
  if (!tab.pinned && !tab.essential) {
    actions.push({ id: 'new-group', label: 'New group', onPick: () => onNewGroup(tab) })
    for (const g of groups) {
      if (g.id === current) continue
      actions.push({
        id: `group-${g.id}`,
        label: current ? `Move to ${g.name}` : `Add to ${g.name}`,
        icon: <GroupDot color={g.color} />,
        onPick: () => run('tab.moveToFolder', { tabId: tab.id, folderId: g.id })
      })
    }
    if (current)
      actions.push({
        id: 'ungroup',
        label: 'Remove from group',
        onPick: () => run('tab.moveToFolder', { tabId: tab.id, folderId: null })
      })
  }
  actions.push({
    id: 'close',
    label: 'Close tab',
    destructive: true,
    onPick: () => run('tab.close', { tabId: tab.id })
  })
  return <OverviewSheet title={tabTitle(tab)} actions={actions} onClose={onClose} />
}

function GroupSheet({
  folder,
  count,
  onClose
}: {
  folder: Folder
  count: number
  onClose: () => void
}): JSX.Element {
  const palette = Object.keys(FOLDER_COLORS) as FolderColor[]
  const actions: SheetAction[] = [
    {
      id: 'rename',
      label: 'Rename',
      onPick: () => uiStore.set({ renamingFolderId: folder.id })
    },
    {
      id: 'collapse',
      label: folder.collapsed ? 'Expand' : 'Collapse',
      onPick: () =>
        run('folder.update', { folderId: folder.id, patch: { collapsed: !folder.collapsed } })
    },
    {
      id: 'ungroup',
      label: 'Ungroup',
      onPick: () => run('folder.delete', { folderId: folder.id, unpack: true })
    },
    {
      id: 'close',
      label: `Close group (${count} tab${count === 1 ? '' : 's'})`,
      destructive: true,
      onPick: () => run('folder.delete', { folderId: folder.id, unpack: false })
    }
  ]
  return (
    <OverviewSheet
      title={folder.name}
      header={
        <div
          className="flex items-center gap-2 px-3 pb-2 pt-1"
          role="radiogroup"
          aria-label="Colour"
        >
          {palette.map((color) => {
            const selected = (folder.color ?? null) === color
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={color}
                className={cn(
                  'zen-group-swatch flex h-8 w-8 items-center justify-center rounded-full',
                  selected && 'zen-group-swatch-selected'
                )}
                style={{ '--zen-swatch': FOLDER_COLORS[color] } as CSSProperties}
                onClick={() => run('folder.update', { folderId: folder.id, patch: { color } })}
              >
                <span
                  className="h-5 w-5 rounded-full"
                  style={{ background: FOLDER_COLORS[color] }}
                />
              </button>
            )
          })}
        </div>
      }
      actions={actions}
      onClose={onClose}
    />
  )
}

function GroupDot({ color }: { color: FolderColor | null | undefined }): JSX.Element {
  return <span className="h-2.5 w-2.5 rounded-full" style={{ background: groupColorHex(color) }} />
}

function NewTabCard(): JSX.Element {
  return (
    <button
      type="button"
      className="zen-overview-new flex flex-col items-center justify-center gap-2 text-[var(--zen-muted)] active:text-[var(--zen-fg)]"
      style={{ aspectRatio: '3 / 4' }}
      onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
    >
      <Plus className="h-6 w-6" />
      <span className="text-[13px] font-medium">New Tab</span>
    </button>
  )
}

/** The spaces as chips: pills, the current one in the accent tint, edges fading into the gutter. */
function SpaceStrip({ spaces, activeId }: { spaces: Space[]; activeId: string }): JSX.Element {
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'x', size: 24 })
  return (
    <div
      ref={fade}
      className="zen-overview-strip flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 pt-0.5"
    >
      {spaces.map((s) => {
        const active = s.id === activeId
        return (
          <button
            key={s.id}
            type="button"
            className={cn(
              'flex h-9 shrink-0 snap-start items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-[background] duration-150 active:scale-[0.98]',
              active
                ? 'bg-[rgb(var(--zen-accent-rgb)/0.16)]'
                : 'bg-[var(--zen-element-bg)] active:bg-[var(--zen-element-bg-hover)]'
            )}
            aria-current={active || undefined}
            onClick={() => run('space.activate', { spaceId: s.id })}
          >
            <SpaceGlyph icon={s.icon} size={14} />
            <span className="max-w-[140px] truncate">{s.name}</span>
          </button>
        )
      })}
    </div>
  )
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t
  }
}

/** Fallback destination when the hero has no card (a tab of another space): shrink in place. */
function shrunk(area: Rect): Rect {
  return {
    x: area.x + area.width * 0.25,
    y: area.y + area.height * 0.25,
    width: area.width * 0.5,
    height: area.height * 0.5
  }
}

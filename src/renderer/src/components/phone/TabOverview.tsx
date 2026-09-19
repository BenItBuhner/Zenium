import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Ellipsis, PanelLeft, PanelRight, Plus, VenetianMask } from 'lucide-react'
import type {
  Folder,
  FolderColor,
  PhoneBarPosition,
  Rect,
  Space,
  Tab,
  UIState
} from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { cmd, run } from '@renderer/lib/api'
import { closeWithUndo } from '@renderer/lib/closeUndo'
import { useViewport } from '@renderer/lib/formFactor'
import { openSpacesDrawer } from '@renderer/lib/gestures/drawer'
import type { DropOutcome } from '@renderer/lib/gestures/dropTarget'
import {
  closeOverview,
  overviewInteractive,
  type OverviewState
} from '@renderer/lib/gestures/stage'
import { groupColorHex, groupsOf, nextGroupColor } from '@renderer/lib/groups'
import { historyAdapter, type ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import { overviewColumns } from '@renderer/lib/layout'
import { FRAME_SHADOW, cardShadow, lerpShadow, shadowCss } from '@renderer/lib/motion/elevation'
import { reducedMotion } from '@renderer/lib/motion/spring'
import {
  overviewPane,
  pickOverviewPane,
  privateTabsOf,
  privateTabsStore,
  tabsOnPane,
  type OverviewPane
} from '@renderer/lib/privateTabs'
import {
  activeSpace,
  activeTab,
  essentialsFor,
  isDarkScheme,
  pinnedOf,
  regularOf,
  tabTitle
} from '@renderer/lib/selectors'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { SpaceGlyph } from '../SpaceGlyph'
import { CloseAllSheet } from './CloseAllSheet'
import { Departures } from './Departures'
import { clearDepartures, depart, rectOf } from './departureStore'
import { DEFAULT_FOLDER_ICON, GroupCard } from './GroupCard'
import { CARD_HEADER, CARD_RADIUS, CardBody, OverviewCard } from './OverviewCard'
import { OverviewSheet, type SheetAction } from './OverviewSheet'
import { noteSheetOpener } from './phonePanel'
import { RecentlyClosedSheet } from './RecentlyClosedSheet'
import { TabPreview } from './TabPreview'
import { cancelLift, liftStore, retargetLift, settleLift, type LiftHover } from './useCardLift'
import { useFlip } from './useFlip'
import { useOverviewHandle } from './usePillGestures'

/** Name a group gets when a gesture makes it; the header renames it in a tap. */
const NEW_GROUP_NAME = 'Group'
/** Cell key of the New Tab card: the last cell of the grid, in the glide with the rest. */
export const NEW_TAB_CELL = 'new-tab'
/** How long a dropped card waits for the browser to confirm its new place before it lands anyway. */
const DROP_TIMEOUT_MS = 900
/** How long a restored tab is waited for before the overview leaves on whatever tab is active. */
const RESTORE_TIMEOUT_MS = 800
/**
 * The middle of a card, as fractions of its width and height inset from each edge, is where a
 * dragged card merges into it; the bands outside put the dragged card before or after it.
 */
const MERGE_INSET_X = 0.26
const MERGE_INSET_Y = 0.2

interface Props {
  state: UIState
  overview: OverviewState
  /** Where the page normally is, in window coordinates. */
  area: Rect
  /** Edge the address bar is docked at: the overview fills the rest of the screen. */
  edge: PhoneBarPosition
}

/**
 * The sheet up over the grid: a card's or a group's menu, the header's menu (with the recently
 * closed list as the menu read it), the close-all question, the recently closed list.
 */
type Sheet =
  | { kind: 'tab'; tabId: string }
  | { kind: 'group'; folderId: string }
  | { kind: 'menu'; closed: ClosedEntrySummary[] }
  | { kind: 'close-all' }
  | { kind: 'recently-closed'; closed: ClosedEntrySummary[] }

interface PendingDrop {
  /** True once the browser state shows the drop – then the card's new slot can be measured. */
  landed: (state: UIState) => boolean
  /** When to stop waiting for the browser (`performance.now()`), and whether that has come. */
  deadline: number
  expired: boolean
}

/** A group as the grid last showed it holding cards. */
interface HeldGroup {
  folder: Folder
  count: number
}

interface ShownGroups {
  /** The pane the grid showed: its groups are that pane's, and the other pane has none. */
  pane: OverviewPane
  /** The groups holding cards after the last render, by folder id. */
  held: ReadonlyMap<string, HeldGroup>
  /**
   * Groups that have lost their last card while on screen and are shrinking to nothing
   * (v2 §11.4), at the span and count they had, until their spring has settled.
   */
  lingering: ReadonlyMap<string, HeldGroup>
}

/**
 * The tab overview of the phone layout: the active space's tabs as a grid of thumbnail cards –
 * Essentials on top, pinned tabs first, groups as tinted cards of their own – with the other
 * spaces as a strip of chips. Its entrance is driven by `overview.progress`: the grid scales and
 * fades in while the page shrinks into the slot of its own card (and grows back out of the card
 * that is picked when leaving), so a half-finished drag always shows exactly where things are
 * going. Cards can be held and dragged onto each other to make groups (see `useCardLift`).
 *
 * On a host with private tabs the overview has two panes under a segment (TAB-02, TAB-03): the
 * space's tabs, and the private ones – the private session is one across the spaces, so that
 * pane lists every private tab, as loose cards on the private theme's backdrop (the window
 * surfaces blend to it while the pane is up, §9.29), with an explainer when there are none. A
 * private card never shows in the regular pane, nor a regular one in the private pane
 * (`tabsOnPane`); the overview opens on the pane of the tab in view.
 */
export function TabOverview({ state, overview, area, edge }: Props): JSX.Element {
  const { progress, phase, heroTabId } = overview
  const space = activeSpace(state)
  const active = activeTab(state)
  const picked = privateTabsStore.use((s) => s.pane)
  const hasPrivate = state.capabilities.privateTabs
  const pane: OverviewPane = hasPrivate ? overviewPane(state, picked) : 'tabs'
  const privatePane = pane === 'private'
  // The private pane is a session, not a workspace: its cards are neither pinned nor grouped
  // here, and a drag moves nothing (`hoverAt`, `dropCard`); the regular pane keeps its structure.
  const essentials = privatePane ? [] : tabsOnPane(essentialsFor(state, space), 'tabs')
  const pinned = privatePane ? [] : tabsOnPane(pinnedOf(state, space), 'tabs')
  const regular = privatePane ? privateTabsOf(state) : tabsOnPane(regularOf(state, space), 'tabs')
  const groups = privatePane ? [] : groupsOf(state, space.id)
  const count = essentials.length + pinned.length + regular.length

  // While a card is dragged its stand-in sits in the slot under the finger, not where the tab
  // is: the grid shows the order the drop would make, and glides into it as the slot moves.
  const liftTabId = liftStore.use((s) => s.tabId)
  const liftSlot = liftStore.use((s) => s.slot)
  const dragged = liftSlot && liftTabId ? (state.tabs[liftTabId] ?? null) : null
  const shown = (list: Tab[], folderId: string | null): Tab[] => {
    if (!dragged || !liftSlot) return list
    const without = list.filter((t) => t.id !== dragged.id)
    if (liftSlot.folderId !== folderId) return without
    const i = Math.min(liftSlot.index, without.length)
    return [...without.slice(0, i), dragged, ...without.slice(i)]
  }
  const membersOf = (folderId: string): Tab[] => regular.filter((t) => t.folderId === folderId)
  const loose = shown(
    privatePane ? regular : regular.filter((t) => !t.folderId || !state.folders[t.folderId]),
    null
  )
  const members = new Map(groups.map((f) => [f.id, shown(membersOf(f.id), f.id)] as const))
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
  const [heroCell, setHeroCell] = useState<Rect | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  /**
   * A sheet has left: forget it – unless the row it was dismissed for has put the next sheet up
   * already (the menu's "Close All Tabs" opens the question as the menu goes).
   */
  const leaveSheet = (kind: Sheet['kind']): void =>
    setSheet((current) => (current?.kind === kind ? null : current))
  const handle = useOverviewHandle({ edge })
  // Every `data-cell` under the grid – page and blank-tab cards, group cards, the New Tab card –
  // is one set on one spring; the same set answers where a card is for the morph and the exits.
  const flip = useFlip(scrollRef, settled)

  // Where the hero's own card sits, in layout space (the root's entrance scale divided out). A
  // hero inside a collapsed group has no card to land on: it heads for the group's card instead
  // and fades into it.
  const heroGroup = hero?.folderId ? (state.folders[hero.folderId] ?? null) : null
  const heroCellKey = heroGroup?.collapsed ? `group:${heroGroup.id}` : heroTabId
  const heroFades = Boolean(heroGroup?.collapsed)
  const cardsKey = [...essentials, ...pinned, ...regular].map((t) => t.id).join('|')
  const measure = (): void => {
    const root = rootRef.current
    const cell = heroCellKey ? flip.element(heroCellKey) : null
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
    const cell = heroCellKey ? flip.element(heroCellKey) : null
    // The page morphs out of / into its card: make sure that card is fully on screen first. A
    // hero inside an open group brings its group along – the group's card first, so the header
    // is in view when the group fits (the strip's show-group chip opens the overview at the
    // group, TAB-14), then its own card, which wins when the group is taller than the grid.
    const morphing = (phase === 'dragging' && progress < 0.05) || phase === 'settling'
    if (cell && morphing) {
      if (heroGroup && !heroGroup.collapsed)
        flip.element(`group:${heroGroup.id}`)?.scrollIntoView({ block: 'nearest' })
      cell.scrollIntoView({ block: 'nearest' })
    }
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
  // off screen; the overview unmounts altogether when it is closed), and cards on their way out
  // have nothing to leave from.
  useEffect(() => {
    if (!interactive) {
      cancelLift()
      clearDepartures()
    }
  }, [interactive])
  useEffect(
    () => () => {
      cancelLift()
      clearDepartures()
    },
    []
  )

  // A dropped card flies to its new slot once the browser has moved it there: to where its
  // stand-in is drawn, and after it while the stand-in glides (the cells below a group set off
  // once its height has settled, v2 §11.4), so the ghost lands on the card wherever that is.
  // The stand-in's slot goes with the confirmation, before that slot is measured: the browser
  // shows the card where the drop put it, which for a drop on a target is not the slot the
  // stand-in held – kept, the card would stand in the old slot for one more render (a group made
  // from it would form with the other card alone) and glide to the new one when the ghost had
  // landed, in a second step.
  const liftPhase = liftStore.use((s) => s.phase)
  const pendingDrop = useRef<PendingDrop | null>(null)
  const standInRect = (tabId: string): Rect | null => {
    // Before the grid has settled nothing is tracked yet and the cell's own box is the answer.
    const rect = flip.drawnRect(tabId) ?? flip.element(tabId)?.getBoundingClientRect()
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
  }
  useLayoutEffect(() => {
    const pending = pendingDrop.current
    if (!pending || liftPhase !== 'dropping' || !liftTabId) return
    if (!pending.landed(state) && !pending.expired && performance.now() < pending.deadline) return
    if (liftSlot) {
      // The render this asks for lays the card out where the tab is; it lands there.
      liftStore.set({ slot: null })
      return
    }
    pendingDrop.current = null
    const to = standInRect(liftTabId) ?? liftStore.get().origin
    if (to) settleLift(to)
    else cancelLift()
  })
  useEffect(() => {
    // The browser may never confirm (the command failed): land the card where the tab is.
    const pending = pendingDrop.current
    if (!pending || liftPhase !== 'dropping') return
    const timer = setTimeout(
      () => {
        if (pendingDrop.current !== pending) return
        pending.expired = true
        const s = liftStore.get()
        if (s.phase !== 'dropping') return
        if (s.slot) {
          // The layout effect above lands the card on the render this asks for.
          liftStore.set({ slot: null })
          return
        }
        pendingDrop.current = null
        const to = (s.tabId ? standInRect(s.tabId) : null) ?? s.origin
        if (to) settleLift(to)
        else cancelLift()
      },
      Math.max(0, pending.deadline - performance.now())
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- standInRect reads the tracker, which is stable
  }, [liftPhase, flip])
  useEffect(() => {
    if (liftPhase !== 'dropping') return
    return flip.onFrame(() => {
      const s = liftStore.get()
      if (s.phase !== 'dropping' || !s.tabId) return
      const to = standInRect(s.tabId)
      if (to) retargetLift(to)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- standInRect reads the tracker, which is stable
  }, [liftPhase, flip])

  // Groups made or emptied while the grid is on screen (v2 §11.4). A group whose card the
  // tracker has not seen, holding cards it has, was just made from them: it grows out of their
  // row with its header and tint off until the tracker's release at the end of the glide. A group
  // that has just lost its last card lingers, shrinking to nothing on its spring while the card
  // glides out and the cells below wait; it leaves once it has settled.
  const forming = (folder: Folder, tabs: Tab[]): boolean =>
    settled &&
    flip.element(`group:${folder.id}`) === null &&
    tabs.some((t) => flip.element(t.id) !== null)
  const subscribeRelease = useCallback((fn: () => void) => flip.onRelease(fn), [flip])
  // The groups holding cards after the last render, and the ones lingering since: a group that
  // has lost its last card since the last render must be on the grid in this very render, so it
  // is found here, from the last render's groups, not in an effect after it.
  const [shownGroups, setShownGroups] = useState<ShownGroups>(() => ({
    pane,
    held: new Map(),
    lingering: new Map()
  }))
  const held = new Map<string, HeldGroup>()
  for (const folder of groups) {
    const count = members.get(folder.id)?.length ?? 0
    if (count) held.set(folder.id, { folder, count })
  }
  // The other pane's grid is a fresh one: its groups did not dissolve, they are simply not here.
  const samePane = shownGroups.pane === pane
  const lost = samePane ? [...shownGroups.held].filter(([id]) => !held.has(id)) : []
  const back = [...shownGroups.lingering.keys()].filter((id) => held.has(id))
  let lingering = samePane ? shownGroups.lingering : new Map<string, HeldGroup>()
  if (lost.length || back.length) {
    const next = new Map(lingering)
    for (const [id, was] of lost) next.set(id, was)
    for (const id of back) next.delete(id)
    lingering = next
  }
  if (
    !samePane ||
    lingering !== shownGroups.lingering ||
    held.size !== shownGroups.held.size ||
    [...held].some(([id, h]) => shownGroups.held.get(id)?.count !== h.count)
  ) {
    setShownGroups({ pane, held, lingering })
  }
  const dissolvedGroup = (folder: Folder): void =>
    setShownGroups((shown) => {
      if (!shown.lingering.has(folder.id)) return shown
      const next = new Map(shown.lingering)
      next.delete(folder.id)
      return { ...shown, lingering: next }
    })
  // The group cards, one keyed list: a group that has just lost its last card (or whose folder
  // is gone with it) keeps its element – the same key in the same list – so its card's height
  // spring runs on from where the card is rather than starting over in a fresh mount.
  const groupCards: Array<{ folder: Folder; tabs: Tab[]; gone: HeldGroup | undefined }> = []
  for (const folder of groups) {
    const tabs = members.get(folder.id) ?? []
    const gone = lingering.get(folder.id)
    if (tabs.length || gone) groupCards.push({ folder, tabs, gone })
  }
  for (const gone of lingering.values())
    if (!groups.some((f) => f.id === gone.folder.id))
      groupCards.push({ folder: gone.folder, tabs: [], gone })

  const pick = (tab: Tab): void => closeOverview(tab.id)

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

  /** The group a tab is shown in (a folder of this space), or null for a loose tab. */
  const groupIdOf = (tab: Tab, s: UIState = state): string | null =>
    tab.folderId && s.folders[tab.folderId]?.spaceId === space.id ? tab.folderId : null
  /** The regular tabs shown in a group (or loose, for null), in the browser's order. */
  const listIn = (s: UIState, folderId: string | null): Tab[] =>
    regularOf(s, activeSpace(s)).filter((t) => groupIdOf(t, s) === folderId)

  /**
   * What the finger is over, from the slots of the last layout (the glide in flight ignored, so
   * cards passing under the finger cannot flip the answer). On another card: its middle merges
   * into it, its edges put the card before or after it; on a group's own chrome: into the group;
   * on the New Tab card or past the last card: the end; anywhere else (a gutter, the stand-in):
   * no change. Off the grid altogether: null, and nothing is targeted.
   */
  const hoverAt = (tab: Tab, x: number, y: number, current: LiftHover): LiftHover | null => {
    const keep: LiftHover = { target: null, slot: current.slot }
    const grid = scrollRef.current?.getBoundingClientRect()
    if (!grid || x < grid.left || x > grid.right || y < grid.top || y > grid.bottom) return null
    // Private cards are held for their menu and swiped to close; a drag rearranges nothing.
    if (privatePane) return keep
    const inside = (r: DOMRect | null): r is DOMRect =>
      r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    // Member cards of an expanded group and the loose cards, as shown right now.
    const cards: Array<{ tab: Tab; list: Tab[]; folderId: string | null }> = []
    for (const folder of groups) {
      if (folder.collapsed) continue
      const list = members.get(folder.id) ?? []
      for (const t of list) cards.push({ tab: t, list, folderId: folder.id })
    }
    for (const t of loose) cards.push({ tab: t, list: loose, folderId: null })
    for (const { tab: other, list, folderId } of cards) {
      if (other.id === tab.id) continue
      const r = flip.layoutRect(other.id)
      if (!inside(r)) continue
      const ix = r.width * MERGE_INSET_X
      const iy = r.height * MERGE_INSET_Y
      if (x > r.left + ix && x < r.right - ix && y > r.top + iy && y < r.bottom - iy)
        return { target: `card:${other.id}`, slot: current.slot }
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const after = Math.abs(x - cx) / r.width > Math.abs(y - cy) / r.height ? x > cx : y > cy
      const index = list.filter((t) => t.id !== tab.id).indexOf(other)
      return { target: null, slot: { folderId, index: index + (after ? 1 : 0) } }
    }
    for (const folder of groups) {
      if (inside(flip.layoutRect(`group:${folder.id}`)))
        return { target: `group:${folder.id}`, slot: current.slot }
    }
    if (inside(flip.layoutRect(tab.id))) return keep
    const looseWithout = loose.filter((t) => t.id !== tab.id)
    const end: LiftHover = { target: null, slot: { folderId: null, index: looseWithout.length } }
    if (inside(flip.layoutRect(NEW_TAB_CELL))) return end
    const lastGroup = groups.filter((f) => (members.get(f.id) ?? []).length > 0).at(-1)
    const lastKey =
      looseWithout.at(-1)?.id ?? (lastGroup ? `group:${lastGroup.id}` : pinned.at(-1)?.id)
    const last = lastKey ? flip.layoutRect(lastKey) : null
    if (!last || y > last.bottom || (y >= last.top && x > last.right)) return end
    return keep
  }

  /**
   * A card was dropped: act on the outcome (a target, a slot, or nothing), then let the settle
   * effect above fly the ghost to the card's slot once the browser shows it there (straight away
   * when nothing changes).
   */
  const dropCard = (tab: Tab, outcome: DropOutcome): void => {
    const expect = (landed: (s: UIState) => boolean): void => {
      pendingDrop.current = {
        landed,
        deadline: performance.now() + DROP_TIMEOUT_MS,
        expired: false
      }
    }
    const unchanged = (): void => expect(() => true)
    if (privatePane) return unchanged()
    const regularWithout = regular.filter((t) => t.id !== tab.id)
    /** Move the tab right before `before` (or to the end of the regular tabs), into `folderId`. */
    const moveTo = (folderId: string | null, before: Tab | undefined, after?: Tab): void => {
      const index = before
        ? regularWithout.indexOf(before)
        : after
          ? regularWithout.indexOf(after) + 1
          : regularWithout.length
      run('tab.move', { tabId: tab.id, spaceId: space.id, section: 'regular', index })
      if (groupIdOf(tab) !== folderId) run('tab.moveToFolder', { tabId: tab.id, folderId })
    }
    const target = outcome.kind === 'target' ? outcome.target : null
    const slot = outcome.kind === 'slot' ? outcome.slot : null
    if (target?.startsWith('group:')) {
      const folderId = target.slice('group:'.length)
      if (!state.folders[folderId] || groupIdOf(tab) === folderId) return unchanged()
      moveTo(folderId, undefined, membersOf(folderId).at(-1))
      return expect((s) => groupIdOf(s.tabs[tab.id] ?? tab, s) === folderId)
    }
    if (target?.startsWith('card:')) {
      const other = state.tabs[target.slice('card:'.length)]
      if (!other || other.id === tab.id || other.pinned || other.essential) return unchanged()
      const theirs = groupIdOf(other)
      if (theirs) {
        // Dropped on a member of a group: join that group, right behind it.
        moveTo(theirs, undefined, other)
        return expect((s) => groupIdOf(s.tabs[tab.id] ?? tab, s) === theirs)
      }
      // Dropped on a loose card: the two make a group, the dropped card right behind the other –
      // the order joining a group gives, so the two gestures read as one rule (v2 §11.4). The
      // stand-in holds its slot until the group shows, so the move is not seen on its own.
      run('tab.move', {
        tabId: tab.id,
        spaceId: space.id,
        section: 'regular',
        index: regularWithout.indexOf(other) + 1
      })
      void makeGroup([other.id, tab.id], false)
      return expect((s) => {
        const mine = s.tabs[tab.id]?.folderId
        return Boolean(mine) && mine === s.tabs[other.id]?.folderId
      })
    }
    if (slot) {
      const list = listIn(state, slot.folderId).filter((t) => t.id !== tab.id)
      const index = Math.min(slot.index, list.length)
      const from = listIn(state, groupIdOf(tab))
      if (slot.folderId === groupIdOf(tab) && from.indexOf(tab) === index) return unchanged()
      moveTo(slot.folderId, list[index], list.at(-1))
      return expect((s) => {
        const t = s.tabs[tab.id]
        if (!t) return true
        if (groupIdOf(t, s) !== slot.folderId) return false
        const now = listIn(s, slot.folderId)
        return now.findIndex((o) => o.id === tab.id) === Math.min(index, now.length - 1)
      })
    }
    unchanged()
  }

  /** Tabs told to close leave the grid visibly: their cards collapse where they stand. */
  const closesForReal = (tab: Tab): boolean =>
    !(tab.pinned || tab.essential) || state.settings.pinnedCloseBehavior === 'close'
  /**
   * Every close goes through at once and comes with Undo on the toast (lib/closeUndo.ts):
   * "Closed <title>" or "N tabs closed", the restore through the core's recently closed store.
   */
  const undoable = (tabs: Tab[], close: () => void): void =>
    closeWithUndo({ tabs, settings: state.settings, activeTabId: active?.id ?? null, close })
  const departAll = (tabs: Tab[]): void =>
    depart(
      tabs.flatMap((tab) => {
        const rect = closesForReal(tab) ? rectOf(flip.element(tab.id)) : null
        return rect ? [{ key: tab.id, kind: 'tab' as const, tab, rect }] : []
      })
    )
  const closeTabs = (tabs: Tab[]): void => {
    departAll(tabs)
    undoable(tabs, () => {
      for (const tab of tabs) run('tab.close', { tabId: tab.id })
    })
  }
  // "Close other tabs" closes the other cards of this pane – the core's `tab.closeOthers` takes
  // the whole space, private tabs included, and would end the private session from the regular
  // pane (or take the space's regular tabs with it from the private one) – then keeps `tab` in
  // view, as the core's does.
  const closeOthers = (tab: Tab): void => {
    const others = regular.filter((t) => t.id !== tab.id)
    departAll(others)
    undoable(others, () => {
      for (const t of others) run('tab.close', { tabId: t.id })
      run('tab.activate', { tabId: tab.id })
    })
  }
  /**
   * "Close All Tabs": every unpinned card of the pane goes (Zen's Clear tabs); pinned ones stay.
   * On a host with private tabs the space holds both modes and the core's `space.closeUnpinned`
   * would take them all – from the regular pane it would end the private session, from the
   * private one take the space's tabs with it – so there the regular pane closes its own cards
   * one by one, as "Close other tabs" does, and the private pane's row is the app menu's Close
   * Private Tabs (`tab.closePrivate`: the session ends and its profile is wiped, INC-04; a
   * private tab is never filed, so no toast follows).
   */
  const closeAll = (): void => {
    departAll(regular)
    if (privatePane) {
      run('tab.closePrivate', undefined)
      return
    }
    undoable(regular, () => {
      if (hasPrivate) for (const t of regular) run('tab.close', { tabId: t.id })
      else run('space.closeUnpinned', { spaceId: space.id })
    })
  }
  const closeAllAsked = (): void => {
    if (regular.length === 0) return
    if (state.settings.confirmCloseAll) setSheet({ kind: 'close-all' })
    else closeAll()
  }
  /**
   * The header's menu: it reads the recently closed list first, so its row can say how many. The
   * private pane's menu has no such row – a private tab is never filed (the core's
   * `captureClosed`), and the list would be the regular tabs' – so it reads nothing.
   */
  const openMenu = async (): Promise<void> => {
    noteSheetOpener()
    const closed = privatePane ? [] : await historyAdapter.recentlyClosed().catch(() => [])
    setSheet({ kind: 'menu', closed: closed.filter((entry) => entry.kind === 'tab') })
  }
  /**
   * A recently closed tab picked from the sheet comes back into its place and the overview
   * leaves on it: the tab is a new record, so the leave waits for the browser to show it.
   */
  const restoreClosed = (entry: ClosedEntrySummary): void => {
    const known = new Set(Object.keys(state.tabs))
    void historyAdapter.restoreClosed(entry.id)
    void whenState(
      (s) => Object.keys(s.tabs).find((id) => !known.has(id)) ?? null,
      RESTORE_TIMEOUT_MS
    ).then((tabId) => closeOverview(tabId ?? undefined))
  }
  const closeGroup = (folder: Folder): void => {
    const rect = rectOf(flip.element(`group:${folder.id}`))
    if (rect)
      depart([
        {
          key: `group:${folder.id}`,
          kind: 'group',
          folder,
          tabs: membersOf(folder.id),
          rect,
          columns
        }
      ])
    run('folder.delete', { folderId: folder.id, unpack: false })
  }
  /** A card swiped off the grid is already out of sight: just close the tab. */
  const swipedAway = (tab: Tab): void => undoable([tab], () => run('tab.close', { tabId: tab.id }))

  const card = (tab: Tab): JSX.Element => (
    <OverviewCard
      key={tab.id}
      tab={tab}
      active={tab.id === active?.id}
      hidden={tab.id === heroTabId && p < 1}
      onPick={pick}
      onClose={(t) => closeTabs([t])}
      onSwipeClose={swipedAway}
      lift={{
        enabled: interactive && !tab.pinned,
        swipeable: interactive && closesForReal(tab),
        scroller: () => scrollRef.current,
        onMenu: (t) => setSheet({ kind: 'tab', tabId: t.id }),
        onHover: hoverAt,
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

  return (
    <>
      <div
        className="absolute"
        style={{
          left: 'var(--zen-inset-left)',
          right: 'var(--zen-inset-right)',
          // The bar's edge keeps the whole band free: the row and the group strip (TAB-14).
          top:
            edge === 'top'
              ? 'calc(var(--zen-phone-band) + var(--zen-inset-top))'
              : 'var(--zen-inset-top)',
          bottom:
            edge === 'bottom'
              ? 'calc(var(--zen-phone-band) + var(--zen-inset-bottom))'
              : 'var(--zen-inset-bottom)',
          pointerEvents: interactive ? 'auto' : 'none'
        }}
      >
        <div
          ref={rootRef}
          className="zen-overview absolute inset-0 flex flex-col"
          // The overview backdrop is window chrome (v2 §9.29): its controls draw in the window family.
          data-surface="window"
          style={{
            opacity: Math.min(1, p * 1.6),
            // Under reduced motion the grid appears at scale 1 with a 120 ms fade (v2 §11.3).
            transform: reducedMotion() ? undefined : `scale(${0.94 + 0.06 * p})`
          }}
        >
          <header className="flex h-14 shrink-0 items-center gap-2.5 px-3" {...handle}>
            {privatePane ? (
              <VenetianMask className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
            ) : (
              <SpaceGlyph icon={space.icon} size={20} />
            )}
            <span className="zen-title min-w-0 truncate">
              {privatePane ? 'Private' : space.name}
            </span>
            <span
              className="shrink-0 text-[13px] tabular-nums text-[var(--zen-muted)]"
              data-testid="overview-count"
            >
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
            <button
              type="button"
              className="zen-toolbar-button h-9 w-9"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={sheet?.kind === 'menu'}
              onClick={() => void openMenu()}
            >
              <Ellipsis className="h-[18px] w-[18px]" />
            </button>
          </header>
          {hasPrivate && <PaneSegment pane={pane} onPick={pickOverviewPane} />}
          {!privatePane && state.spaces.length > 1 && (
            <SpaceStrip spaces={state.spaces} activeId={space.id} />
          )}
          {privatePane && count === 0 ? (
            <PrivateEmpty />
          ) : (
            <div
              // Each pane is a grid of its own: the one that comes up fades in over the backdrop
              // (v2 §11, a 120 ms state change) and the cells start fresh with it.
              key={pane}
              ref={(el) => {
                scrollRef.current = el
                return fadeGrid(el)
              }}
              className="zen-overview-grid zen-overview-pane min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-1"
              data-pane={pane}
              // The card the page morphs into is scrolled into view: keep it clear of the fades.
              style={{
                touchAction: 'pan-y',
                overscrollBehavior: 'contain',
                scrollPaddingBlock: 16
              }}
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
                {groupCards.map(({ folder, tabs, gone }) => (
                  <GroupCard
                    key={folder.id}
                    folder={folder}
                    tabs={tabs}
                    card={card}
                    columns={columns}
                    onMenu={(f) => setSheet({ kind: 'group', folderId: f.id })}
                    forming={tabs.length > 0 && forming(folder, tabs)}
                    dissolving={tabs.length === 0}
                    held={gone?.count}
                    onDissolved={dissolvedGroup}
                    onRelease={subscribeRelease}
                  />
                ))}
                {loose.map(card)}
                <NewTabCard pane={pane} />
              </div>
            </div>
          )}
        </div>
        <Departures state={state} activeTabId={active?.id ?? null} />
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
            <TabPreview tab={hero} scale={1 - 0.2 * p} cover />
          </div>
        </div>
      )}
      {interactive && sheet?.kind === 'tab' && state.tabs[sheet.tabId] && (
        <TabSheet
          state={state}
          tab={state.tabs[sheet.tabId]}
          groups={groups}
          groupable={!privatePane}
          others={regular.length - 1}
          onClose={() => setSheet(null)}
          onNewGroup={(tab) => void makeGroup([tab.id], true)}
          onCloseTab={(tab) => closeTabs([tab])}
          onCloseOthers={closeOthers}
        />
      )}
      {interactive && sheet?.kind === 'group' && state.folders[sheet.folderId] && (
        <GroupSheet
          folder={state.folders[sheet.folderId]}
          count={membersOf(sheet.folderId).length}
          onClose={() => setSheet(null)}
          onCloseGroup={closeGroup}
        />
      )}
      {interactive && sheet?.kind === 'menu' && (
        <OverviewMenuSheet
          title={privatePane ? 'Private' : space.name}
          privateTabs={privatePane}
          open={regular.length}
          closed={sheet.closed.length}
          onClose={() => leaveSheet('menu')}
          onRecentlyClosed={() => setSheet({ kind: 'recently-closed', closed: sheet.closed })}
          onCloseAll={closeAllAsked}
        />
      )}
      {interactive && sheet?.kind === 'close-all' && (
        <CloseAllSheet
          count={regular.length}
          spaceName={space.name}
          privateTabs={privatePane}
          onClose={() => leaveSheet('close-all')}
          onConfirm={(askAgain) => {
            if (!askAgain) run('settings.update', { confirmCloseAll: false })
            closeAll()
          }}
        />
      )}
      {interactive && sheet?.kind === 'recently-closed' && (
        <RecentlyClosedSheet
          initial={sheet.closed}
          onClose={() => leaveSheet('recently-closed')}
          onRestore={restoreClosed}
        />
      )}
    </>
  )
}

/**
 * The header's menu: the recently closed list (matrix TAB-22, TAB-23) and "Close All Tabs" (TAB-06);
 * "Close other tabs" stays on a card's own menu, where it names the card it keeps. The rows are
 * menu items, so Title Case (v2 §9.1; the card menus' rows from #94/#147 take the rule in a
 * follow-up); a row with nothing to act on keeps no count and is disabled, never hidden (§9.17).
 * The private pane's menu is the one row "Close Private Tabs", named as the app menu names it:
 * no recently closed list applies there (Chrome's Incognito switcher has no Recent tabs either),
 * so the row is not there, not greyed – §9.17's rule is for a count of zero.
 */
function OverviewMenuSheet({
  title,
  privateTabs,
  open,
  closed,
  onClose,
  onRecentlyClosed,
  onCloseAll
}: {
  title: string
  /** Whether this is the private pane's menu. */
  privateTabs: boolean
  /** How many tabs "Close All Tabs" would close (the unpinned ones). */
  open: number
  /** How many tabs the recently closed list holds. */
  closed: number
  onClose: () => void
  onRecentlyClosed: () => void
  onCloseAll: () => void
}): JSX.Element {
  const counted = (label: string): string => (open > 0 ? `${label} (${open})` : label)
  const actions: SheetAction[] = privateTabs
    ? [
        {
          id: 'close-all',
          label: counted('Close Private Tabs'),
          destructive: true,
          disabled: open === 0,
          onPick: onCloseAll
        }
      ]
    : [
        {
          id: 'recently-closed',
          label: closed > 0 ? `Recently Closed (${closed})` : 'Recently Closed',
          disabled: closed === 0,
          onPick: onRecentlyClosed
        },
        {
          id: 'close-all',
          label: counted('Close All Tabs'),
          destructive: true,
          disabled: open === 0,
          onPick: onCloseAll
        }
      ]
  return <OverviewSheet title={title} actions={actions} onClose={onClose} />
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

function TabSheet({
  state,
  tab,
  groups,
  groupable,
  others,
  onClose,
  onNewGroup,
  onCloseTab,
  onCloseOthers
}: {
  state: UIState
  tab: Tab
  groups: Folder[]
  /** Whether the pane groups its cards (the private pane does not). */
  groupable: boolean
  /** How many other tabs "Close other tabs" would close. */
  others: number
  onClose: () => void
  onNewGroup: (tab: Tab) => void
  onCloseTab: (tab: Tab) => void
  onCloseOthers: (tab: Tab) => void
}): JSX.Element {
  const current = tab.folderId && state.folders[tab.folderId] ? tab.folderId : null
  const actions: SheetAction[] = []
  if (groupable && !tab.pinned && !tab.essential) {
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
  if (!tab.pinned && !tab.essential && others > 0)
    actions.push({
      id: 'close-others',
      label: `Close other tabs (${others})`,
      destructive: true,
      onPick: () => onCloseOthers(tab)
    })
  actions.push({
    id: 'close',
    label: 'Close tab',
    destructive: true,
    onPick: () => onCloseTab(tab)
  })
  return <OverviewSheet title={tabTitle(tab)} actions={actions} onClose={onClose} />
}

function GroupSheet({
  folder,
  count,
  onClose,
  onCloseGroup
}: {
  folder: Folder
  count: number
  onClose: () => void
  onCloseGroup: (folder: Folder) => void
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
      onPick: () => onCloseGroup(folder)
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

/**
 * The last card of the grid, a cell like the others (`data-cell`): when cards are rearranged,
 * closed or grouped it glides to its new place on the same spring as they do. On the private
 * pane it opens a private tab (INC-01).
 */
function NewTabCard({ pane }: { pane: OverviewPane }): JSX.Element {
  const isPrivate = pane === 'private'
  return (
    <button
      type="button"
      className="zen-overview-new flex flex-col items-center justify-center gap-2 text-[var(--zen-muted)] active:text-[var(--zen-fg)]"
      style={{ aspectRatio: '3 / 4' }}
      data-cell={NEW_TAB_CELL}
      data-testid={isPrivate ? 'overview-new-private-tab' : 'overview-new-tab'}
      onClick={() => newTabOn(pane)}
    >
      {isPrivate ? (
        <VenetianMask className="h-6 w-6" strokeWidth={1.75} />
      ) : (
        <Plus className="h-6 w-6" />
      )}
      <span className="text-[13px] font-medium">{isPrivate ? 'New Private Tab' : 'New Tab'}</span>
    </button>
  )
}

/** Ask for a new tab of the pane's mode: the phone's new tab page comes up over the overview. */
function newTabOn(pane: OverviewPane): void {
  window.dispatchEvent(
    new CustomEvent('zen-new-tab', {
      detail: pane === 'private' ? { containerId: PRIVATE_CONTAINER_ID } : {}
    })
  )
}

/**
 * The overview's two panes as a tab bar above the grid (TAB-02): "Tabs" and "Private", text in
 * the window family – the picked one in the window ink with the 2 px accent line under it, the
 * other at 69% – switching on a tap with a 120 ms state change (v2 §11); not a segmented pill
 * (§9.14 has none). Its row is 40 tall at the 16 gutter, each label a 44 target.
 */
function PaneSegment({
  pane,
  onPick
}: {
  pane: OverviewPane
  onPick: (pane: OverviewPane) => void
}): JSX.Element {
  const panes: Array<{ id: OverviewPane; label: string }> = [
    { id: 'tabs', label: 'Tabs' },
    { id: 'private', label: 'Private' }
  ]
  return (
    <div
      role="tablist"
      aria-label="Tabs and private tabs"
      className="zen-overview-segment flex h-10 shrink-0 items-stretch gap-2 px-3"
    >
      {panes.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={pane === id}
          data-pane={id}
          data-testid={`overview-pane-${id}`}
          className="zen-overview-segment-tab relative flex min-w-[44px] items-center px-2 text-[15px]"
          onClick={() => {
            if (pane !== id) onPick(id)
          }}
        >
          <span className="relative">
            {label}
            <span className="zen-overview-segment-indicator absolute inset-x-0 -bottom-2 h-0.5 rounded-[1px]" />
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The private pane with nothing in it (TAB-03): a page's empty state (v2 §9.17 – title 22/600,
 * one 15 description at 69%, one button, the block centred with its middle at 45% of the
 * pane), in the window family on the private theme's backdrop.
 */
function PrivateEmpty(): JSX.Element {
  return (
    <div
      className="zen-overview-pane relative min-h-0 flex-1"
      data-pane="private"
      data-testid="overview-private-empty"
    >
      <div
        className="absolute inset-x-0 flex -translate-y-1/2 flex-col items-center px-8 text-center"
        style={{ top: '45%' }}
      >
        <h2 className="text-[22px] font-semibold leading-7 tracking-[-0.012em]">No private tabs</h2>
        <p className="mt-2 max-w-[360px] text-[15px] leading-5 text-[rgb(var(--zen-fg-rgb)/0.69)]">
          Pages you open here leave no history, cookies or site data once the last private tab
          closes
        </p>
        <button
          type="button"
          className="zen-v2-button mt-4"
          data-testid="overview-private-empty-new"
          onClick={() => newTabOn('private')}
        >
          New private tab
        </button>
      </div>
    </div>
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

/** The first browser state `pick` answers for, within `ms`; null once that time has passed. */
function whenState<T>(pick: (state: UIState) => T | null, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: T | null): void => {
      if (done) return
      done = true
      unsubscribe()
      clearTimeout(timer)
      resolve(value)
    }
    const check = (): void => {
      const s = browserStore.get().state
      const value = s ? pick(s) : null
      if (value !== null) finish(value)
    }
    const unsubscribe = browserStore.subscribe(check)
    const timer = setTimeout(() => finish(null), ms)
    check()
  })
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

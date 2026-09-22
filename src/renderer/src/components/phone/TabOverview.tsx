import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Ellipsis,
  Group,
  PanelLeft,
  PanelRight,
  Search,
  Share2,
  Star,
  VenetianMask,
  X
} from 'lucide-react'
import type {
  Folder,
  FolderColor,
  PhoneBarPosition,
  Rect,
  Space,
  SyncRemoteTab,
  Tab,
  UIState
} from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { defaultBookmarkFolderId } from '@shared/bookmarks'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { announce } from '@renderer/lib/announce'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { closeWithUndo } from '@renderer/lib/closeUndo'
import { useViewport } from '@renderer/lib/formFactor'
import { openSpacesDrawer } from '@renderer/lib/gestures/drawer'
import type { DropOutcome } from '@renderer/lib/gestures/dropTarget'
import {
  closeOverview,
  overviewInteractive,
  type OverviewState
} from '@renderer/lib/gestures/stage'
import { groupRows, isPrivateGroup, type GroupRow } from '@renderer/lib/groupRows'
import { groupColorHex, groupsOf, nextGroupColor } from '@renderer/lib/groups'
import { historyAdapter, type ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import { overviewColumns } from '@renderer/lib/layout'
import { FRAME_SHADOW, cardShadow, lerpShadow, shadowCss } from '@renderer/lib/motion/elevation'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import {
  reducedMotion,
  SPRING_GENTLE,
  SPRING_SNAPPY,
  SpringAnimation
} from '@renderer/lib/motion/spring'
import { tabCardLabel } from '@renderer/lib/overviewLabels'
import {
  filterTabs,
  normalizeQuery,
  searchResultAnnouncement,
  tabMatchesQuery
} from '@renderer/lib/overviewSearch'
import {
  NO_SELECTION,
  allSelected,
  bookmarkFolderTitle,
  bookmarkedMessage,
  deselectAll,
  endSelection,
  groupableTabs,
  isSelected,
  pageTabs,
  pruneSelection,
  selectAll,
  selectedTabs,
  selectionTitle,
  shareTabsPayload,
  startSelection,
  toggleSelected,
  type OverviewSelection
} from '@renderer/lib/overviewSelection'
import { PRIVATE_TAB_PLACEHOLDER, privateLockStore } from '@renderer/lib/privateLock'
import {
  isPrivateTab,
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
import { browserStore, openOverlay, pushToast, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { SpaceGlyph } from '../SpaceGlyph'
import { CloseAllSheet } from './CloseAllSheet'
import { Departures } from './Departures'
import {
  clearDepartures,
  depart,
  departed,
  departStore,
  rectOf,
  releaseDepartures,
  type Departure
} from './departureStore'
import { DEFAULT_FOLDER_ICON, GroupCard } from './GroupCard'
import { DeleteGroupSheet, GroupColorPalette, GroupRowSheet, GroupsPane } from './GroupsPane'
import { CARD_RADIUS, CardBody, NewTabFace, OverviewCard } from './OverviewCard'
import { cardHeaderHeight } from './overviewCardHeader'
import { OVERVIEW_SEARCH_ID, OverviewSearchField, OverviewSearchReach } from './OverviewSearch'
import { OverviewSheet, type SheetAction } from './OverviewSheet'
import { PaneSlot, PaneStills, type PaneStill } from './PaneSlot'
import { noteSheetOpener } from './phonePanel'
import { PrivateLockCover } from './PrivateLockCover'
import { RecentlyClosedSheet } from './RecentlyClosedSheet'
import { TabPreview } from './TabPreview'
import { cancelLift, liftStore, retargetLift, settleLift, type LiftHover } from './useCardLift'
import { useFlip } from './useFlip'
import { useOverviewHandle } from './usePillGestures'
import { useSearchReach } from './useSearchReach'

/** Name a group gets when a gesture makes it; the header renames it in a tap. */
const NEW_GROUP_NAME = 'Group'
/** Cell key of the New Tab card: the last cell of the grid, in the glide with the rest. */
export const NEW_TAB_CELL = 'new-tab'
/** How long a dropped card waits for the browser to confirm its new place before it lands anyway. */
const DROP_TIMEOUT_MS = 900
/** How long a restored tab is waited for before the overview leaves on whatever tab is active. */
const RESTORE_TIMEOUT_MS = 800
/**
 * How long a tab opened for another device's page is waited for before the overview leaves on
 * whatever tab is active (the tab search's rows from the other devices, TAB-21 / TAB-02).
 */
const OPEN_TIMEOUT_MS = 800
/** Travel (px) of the entrance spring of a card the search lets back in: the exit's, run backwards. */
const ENTER_TRAVEL = 120
/** How far such a card grows on its way in (the exit's shrink). */
const ENTER_SCALE = 0.1
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
/** How long the search waits after a keystroke before its count is announced. */
const SEARCH_ANNOUNCE_MS = 500
/**
 * How long the Tabs pane waits for a group's card to show – a saved group's pages coming back as
 * tabs (`folder.open`) – before a "show the group" request from the Groups pane is dropped.
 */
const REVEAL_TIMEOUT_MS = 800
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
 * closed list as the menu read it), the close-all question, the recently closed list, the
 * select-tabs mode's group picker, a Groups pane row's menu and the delete-group question.
 */
type Sheet =
  | { kind: 'tab'; tabId: string }
  | { kind: 'group'; folderId: string }
  | { kind: 'menu'; closed: ClosedEntrySummary[] }
  | { kind: 'close-all' }
  | { kind: 'recently-closed'; closed: ClosedEntrySummary[] }
  | { kind: 'group-picker' }
  | { kind: 'group-row'; folderId: string }
  | { kind: 'delete-group'; folderId: string }

/** A group the Groups pane asked the Tabs pane to show: scrolled to once its card is there. */
interface Reveal {
  folderId: string
  /** When to give up waiting for the card (`performance.now()`). */
  deadline: number
}

/**
 * The tab search (TAB-21): whether the field is pinned under the header, and what it holds. Off
 * whenever the overview opens – the field never takes the keyboard on its own – and off again
 * with the overview, so no query outlives the grid it narrowed.
 */
interface SearchState {
  open: boolean
  query: string
}
const SEARCH_OFF: SearchState = { open: false, query: '' }

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
 * The overview's panes stand under a segment (TAB-02, TAB-03, TAB-16): the space's tabs; its
 * tab GROUPS as rows (`GroupsPane`, Chrome's "Tab groups" pane) – the open ones, and the SAVED
 * ones whose tabs have closed but whose pages the group kept, to be opened again; and, on a host
 * with private tabs, the private ones – the private session is one across the spaces, so that
 * pane lists every private tab, as loose cards on the private theme's backdrop (the window
 * surfaces blend to it while the pane is up, §9.29), with an explainer when there are none. A
 * private card never shows in the regular pane, nor a regular one in the private pane
 * (`tabsOnPane`); the overview opens on the pane of the tab in view.
 *
 * The header's magnifier opens the TAB SEARCH (TAB-21, `lib/overviewSearch.ts`): a field pinned
 * under the header that narrows the pane's cards to the ones whose title or address holds what
 * is typed – the cards the query drops depart in place as closing cards do while the rest glide
 * into their slots (§11.4), and come back as the exit run backwards when the query lets them.
 * On the Tabs pane the search reaches past the cards (the #316 gate): this device's recently
 * closed tabs and the other devices' open ones – History's two groups (TAB-02, history-07) – list
 * as rows under headings beneath the matching cards (`OverviewSearchReach`), as Chrome's tab
 * search lists its recently closed matches; a row brings its tab to the front and the overview
 * leaves on it.
 */
export function TabOverview({ state, overview, area, edge }: Props): JSX.Element {
  const { progress, phase, heroTabId } = overview
  const space = activeSpace(state)
  const active = activeTab(state)
  const picked = privateTabsStore.use((s) => s.pane)
  const hasPrivate = state.capabilities.privateTabs
  // A host without private tabs has no Private pane to follow a private tab onto.
  const followed = overviewPane(state, picked)
  const pane: OverviewPane = followed === 'private' && !hasPrivate ? 'tabs' : followed
  const privatePane = pane === 'private'
  const groupsPane = pane === 'groups'
  // The private tabs are locked (INC-05): the Private pane is under the lock cover, its cards
  // blurred beneath it; the Tabs pane and the header are not.
  const locked = privateLockStore.use((s) => s.locked)
  // Taps work as soon as the overview is heading open; layout tracking waits for it to rest.
  const interactive = overviewInteractive(overview)
  // The tab search (TAB-21): open from the header's magnifier, off with the overview – the
  // field is reset in the render that takes it off, as the select-tabs mode's scope is. It is
  // the card panes' – Tabs and Private – as Chrome's Hub search box is: the Groups pane lists
  // groups as rows, not tabs as cards, so it has no magnifier, and a pick of it closes the search.
  const [search, setSearch] = useState<SearchState>(SEARCH_OFF)
  const searchable = interactive && !groupsPane
  if (search.open && !searchable) setSearch(SEARCH_OFF)
  const searchOpen = search.open && searchable
  const query = searchOpen ? normalizeQuery(search.query) : ''
  const searching = query.length > 0
  // The private pane is a session, not a workspace: its cards are neither pinned nor grouped
  // here – a drag rearranges them and nothing more (`hoverAt`, `dropCard`), as Chrome's incognito
  // grid lets it; the regular pane keeps its structure. The `all` lists are the pane's; the
  // grid's are the ones the search leaves (the same lists with no query).
  const essentialsAll = privatePane ? [] : tabsOnPane(essentialsFor(state, space), 'tabs')
  const pinnedAll = privatePane ? [] : tabsOnPane(pinnedOf(state, space), 'tabs')
  const regularAll = privatePane
    ? privateTabsOf(state)
    : tabsOnPane(regularOf(state, space), 'tabs')
  const essentials = searching ? filterTabs(essentialsAll, query) : essentialsAll
  const pinned = searching ? filterTabs(pinnedAll, query) : pinnedAll
  const regular = searching ? filterTabs(regularAll, query) : regularAll
  // The space's groups, less the PRIVATE ones (`isPrivateGroup`: private tabs alone live in
  // them, nothing saved) – the Private pane's, whose existence and name no regular surface
  // shows: not the Tabs pane's group sheets, not the Groups pane, not its count. `liveOf` names
  // a group's live members, private ones included, the way the space holds them.
  const liveOf = (folderId: string): Tab[] =>
    regularOf(state, space).filter((t) => t.folderId === folderId)
  const groups = privatePane
    ? []
    : groupsOf(state, space.id).filter((f) => !isPrivateGroup(f, liveOf(f.id)))
  const count = essentialsAll.length + pinnedAll.length + regularAll.length
  const found = essentials.length + pinned.length + regular.length
  // Past the cards, on the Tabs pane: the recently closed tabs and the other devices' tabs the
  // query finds, as rows under the grid; nothing on the Private pane (a private tab is never
  // filed, and the other devices' pages are not private ones).
  const reach = useSearchReach(state, query, searching && !privatePane)
  const foundAll = found + reach.closed.length + reach.remote.length

  // The last private tab closing ends the session, and the overview returns to the Tabs pane
  // whether the Private pane was picked or followed (Chrome's switcher does the same); the
  // empty explainer stays a pick away, for whoever picks Private with none open.
  const privateCount = hasPrivate ? privateTabsOf(state).length : 0
  const privateCountBefore = useRef(privateCount)
  useEffect(() => {
    const before = privateCountBefore.current
    privateCountBefore.current = privateCount
    if (before > 0 && privateCount === 0 && picked === 'private') pickOverviewPane('tabs')
  }, [privateCount, picked])

  // A pane switch is a cross-fade (v2 §11.4): the pane that leaves is kept in view as a still
  // fading out over its slot while the next fades in – `PaneSlot` takes the still as the pane
  // goes, `PaneStills` draws it until its 120 ms are up.
  const [stills, setStills] = useState<PaneStill[]>([])
  const leavePane = useCallback((still: PaneStill) => setStills((s) => [...s, still]), [])
  const stillDone = useCallback(
    (key: number) => setStills((s) => s.filter((still) => still.key !== key)),
    []
  )

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
  // A group's members on this pane: the grid's (`membersOf`: the ones a query leaves, what its
  // card shows and departs with) and the pane's whole (`liveMembersOf`: what "Close Group"
  // closes, what a whole-group close reads, the count on the sheets' rows – a query narrows what
  // is shown, not what a group is).
  const membersOf = (folderId: string): Tab[] => regular.filter((t) => t.folderId === folderId)
  const liveMembersOf = (folderId: string): Tab[] =>
    regularAll.filter((t) => t.folderId === folderId)
  const loose = shown(
    privatePane ? regular : regular.filter((t) => !t.folderId || !state.folders[t.folderId]),
    null
  )
  const members = new Map(groups.map((f) => [f.id, shown(membersOf(f.id), f.id)] as const))
  const hero = heroTabId ? (state.tabs[heroTabId] ?? null) : null
  // The hero of the morph from a locked private tab reads the placeholder, as its card does
  // (§9.19): the real title never rises into view under the cover.
  const lifting = privateLockStore.use((s) => s.lifting)
  const heroMasked = hero !== null && (locked || lifting) && isPrivateTab(hero)
  const p = Math.min(1, Math.max(0, progress))
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
  // The select-tabs mode (TAB-08, `lib/overviewSelection.ts`): on from the header's menu or a
  // card's hold sheet, off by Done, back, Escape or an action. It belongs to the grid it was
  // entered on – this pane of this space, with the overview open – and is off the moment that
  // grid is another (a pane or space switch, the overview leaving): the mode is kept with the
  // scope it was entered in and read as off, and reset, under any other, in the render that
  // brings the other grid. The picks are pruned against the cards on show the same way.
  const scope = interactive ? `${pane}|${space.id}` : null
  const [kept, setKept] = useState<{ scope: string | null; selection: OverviewSelection }>({
    scope,
    selection: NO_SELECTION
  })
  if (kept.scope !== scope) setKept({ scope, selection: NO_SELECTION })
  const selection = kept.scope === scope ? kept.selection : NO_SELECTION
  const selecting = selection.on
  const setSelection = useCallback(
    (next: OverviewSelection | ((current: OverviewSelection) => OverviewSelection)): void =>
      setKept((k) => ({
        scope: k.scope,
        selection: typeof next === 'function' ? next(k.selection) : next
      })),
    []
  )
  const exitSelection = useCallback(() => setSelection(endSelection()), [setSelection])
  useBackSurface(selecting ? { name: 'overview-selection', onCommit: exitSelection } : null)
  const handle = useOverviewHandle({ edge })
  // Every `data-cell` under the grid – page and blank-tab cards, group cards, the New Tab card –
  // is one set on one spring; the same set answers where a card is for the morph and the exits.
  const flip = useFlip(scrollRef, settled)

  // The tab search's field (TAB-21). The query is taken as it is typed: the cards it drops are
  // departed first, from where they stand on the grid – the cards a collapsed group folds away,
  // or an earlier query dropped, have no element and nothing to leave from – so their exits
  // start in the commit that unmounts them, the survivors gliding on the same frame (§11.4).
  // The New Tab card goes with them while a query stands (§9.34: it is not a match, and a tap
  // on it would open a blank page under a query), and comes back as they do when it clears.
  const searchInput = useRef<HTMLInputElement>(null)
  const changeQuery = (next: string): void => {
    const q = normalizeQuery(next)
    const leaving = [...pinnedAll, ...regularAll].filter((tab) => !tabMatchesQuery(tab, q))
    const exits: Departure[] = leaving.flatMap((tab) => {
      const rect = rectOf(flip.element(tab.id))
      return rect ? [{ key: tab.id, kind: 'tab', tab, rect, filtered: true }] : []
    })
    const newTab = q ? rectOf(flip.element(NEW_TAB_CELL)) : null
    if (newTab)
      exits.push({ key: NEW_TAB_CELL, kind: 'new-tab', isPrivate: privatePane, rect: newTab })
    depart(exits)
    setSearch({ open: true, query: next })
  }
  const openSearch = (): void => setSearch((s) => (s.open ? s : { open: true, query: '' }))
  const closeSearch = (): void => setSearch(SEARCH_OFF)
  /** The X on a query: the query goes, the field stays, with the keyboard. */
  const clearQuery = (): void => {
    changeQuery('')
    searchInput.current?.focus()
  }
  /** Escape, back, or the X on an empty field: a query is cleared first; an empty field closes. */
  const backSearch = (): void => {
    if (normalizeQuery(search.query)) clearQuery()
    else closeSearch()
  }
  // The Escape listener below is bound once per state it depends on, and reads the latest here.
  const searchBack = useRef(backSearch)
  useEffect(() => {
    searchBack.current = backSearch
  })
  // The field is the user's ask (the magnifier's tap): it takes the focus, and the keyboard with
  // it through the host's policy on `focusin`. Nothing else ever focuses it – the overview opens
  // with the field closed – so the keyboard never comes up with the overview.
  useLayoutEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])
  useBackSurface(searchOpen ? { name: 'overview-search', onCommit: backSearch } : null)
  // What a screen reader is told of the narrowing (TalkBack, the chrome's status region): the
  // count once the typing has paused, not per letter.
  useEffect(() => {
    const text = searchResultAnnouncement(query, foundAll)
    if (!text) return
    const timer = setTimeout(() => announce(text), SEARCH_ANNOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, foundAll])

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
  // surface takes the key, and the next Escape reaches the overview. The search field takes it
  // first (its query, then the field itself), then the select-tabs mode ends, as back does.
  const sheetOpen = sheet !== null
  const drawerOpen = uiStore.use((s) => s.drawerOpen)
  useEffect(() => {
    if (!interactive || sheetOpen || drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (searchOpen) searchBack.current()
        else if (selecting) exitSelection()
        else closeOverview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [interactive, sheetOpen, drawerOpen, selecting, exitSelection, searchOpen])

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
  // The Groups pane draws rows, not cards: nothing there is held, so nothing lingers.
  for (const folder of groupsPane ? [] : groups) {
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
  /**
   * The pane's tabs shown in a group (or loose, for null), in the browser's order: the regular
   * pane's are the space's regular tabs of that group, the private ones aside; the private pane's
   * list is the session's, across the spaces (it makes no groups).
   */
  const listIn = (s: UIState, folderId: string | null): Tab[] =>
    privatePane
      ? privateTabsOf(s)
      : tabsOnPane(regularOf(s, activeSpace(s)), 'tabs').filter((t) => groupIdOf(t, s) === folderId)

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
    const inside = (r: DOMRect | null): r is DOMRect =>
      r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    // Member cards of an expanded group and the loose cards, as shown right now (the private
    // pane's cards are all loose: it makes no groups, a session being no workspace, so a drag
    // there only rearranges, as Chrome's incognito grid lets it).
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
      if (
        !privatePane &&
        x > r.left + ix &&
        x < r.right - ix &&
        y > r.top + iy &&
        y < r.bottom - iy
      )
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
    /**
     * Move the tab right before `before` (or right after `after`, or to the end of the regular
     * tabs), into `folderId`. The browser's index counts a space's whole regular section – both
     * modes' tabs, since a space's track holds its private tabs too – so the neighbour's place is
     * looked up there, not in the pane's list; a private neighbour filed in another space takes
     * the tab into that space (the private session is one across the spaces).
     */
    const moveTo = (folderId: string | null, before: Tab | undefined, after?: Tab): void => {
      const anchor = before ?? after
      const into = state.spaces.find((s) => s.id === anchor?.spaceId) ?? space
      const track = regularOf(state, into).filter((t) => t.id !== tab.id)
      const index = before ? track.indexOf(before) : after ? track.indexOf(after) + 1 : track.length
      run('tab.move', { tabId: tab.id, spaceId: into.id, section: 'regular', index })
      if (!privatePane && groupIdOf(tab) !== folderId)
        run('tab.moveToFolder', { tabId: tab.id, folderId })
    }
    const target = outcome.kind === 'target' ? outcome.target : null
    const slot = outcome.kind === 'slot' ? outcome.slot : null
    // The private pane never targets a card or a group (`hoverAt`): only its slots move anything.
    if (privatePane && target) return unchanged()
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
        index:
          regularOf(state, space)
            .filter((t) => t.id !== tab.id)
            .indexOf(other) + 1
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
  /**
   * Close `tabs` at once, with the one undo, and run `after` with them. The tabs that make up a
   * whole group among them – every live member of it – close as the group does ("Close Group",
   * the core's `folder.close`), so the group stays SAVED with all their pages (TAB-16) rather
   * than with the last one closed, which is what closing them one by one would leave it; the
   * rest close one by one. A card's own close, Close Other Tabs, Close All Tabs and the
   * select-tabs mode's Close all read this one rule.
   */
  const closeSet = (tabs: Tab[], after?: () => void): void => {
    const ids = new Set(tabs.map((t) => t.id))
    const whole = groups.filter((f) => {
      const live = liveMembersOf(f.id)
      return live.length > 0 && live.every((t) => ids.has(t.id))
    })
    const asGroup = new Set(whole.flatMap((f) => liveMembersOf(f.id).map((t) => t.id)))
    undoable(tabs, () => {
      for (const f of whole) run('folder.close', { folderId: f.id })
      for (const t of tabs) if (!asGroup.has(t.id)) run('tab.close', { tabId: t.id })
      after?.()
    })
  }
  const closeTabs = (tabs: Tab[]): void => {
    departAll(tabs)
    closeSet(tabs)
  }
  // "Close other tabs" closes the other cards of this pane – the core's `tab.closeOthers` takes
  // the whole space, private tabs included, and would end the private session from the regular
  // pane (or take the space's regular tabs with it from the private one) – then keeps `tab` in
  // view, as the core's does. The pane's, not the search's: a query narrows what is shown, not
  // what "other tabs" and "all tabs" mean (their counts on the rows say so).
  const closeOthers = (tab: Tab): void => {
    const others = regularAll.filter((t) => t.id !== tab.id)
    departAll(others)
    closeSet(others, () => run('tab.activate', { tabId: tab.id }))
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
    departAll(regularAll)
    if (privatePane) {
      run('tab.closePrivate', undefined)
      return
    }
    if (hasPrivate) closeSet(regularAll)
    else undoable(regularAll, () => run('space.closeUnpinned', { spaceId: space.id }))
  }
  const closeAllAsked = (): void => {
    if (regularAll.length === 0) return
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
  /**
   * A search row from another device leaves the overview on the tab it brings to the front: the
   * device's page in a new tab of this space, or the tab this device already holds. Either way
   * the tab in view changes, and the leave waits for the browser to show which it is.
   */
  const leaveOn = (ask: () => void): void => {
    const before = active?.id ?? null
    ask()
    void whenState((s) => {
      const now = activeTab(s)?.id ?? null
      return now !== before ? now : null
    }, OPEN_TIMEOUT_MS).then((tabId) => closeOverview(tabId ?? undefined))
  }
  /**
   * Another device's tab found by the search (TAB-21 / TAB-02): its address in a new tab of this
   * space – or, when this device already holds that very tab (the Open tabs scope carries the
   * records too, ID-10), that tab to the front rather than a second one, as Settings › Sync's
   * and History's rows do (#314, `OtherDevicesGroup`).
   */
  const openRemote = (tab: SyncRemoteTab): void =>
    leaveOn(() =>
      tab.tabId in state.tabs
        ? run('tab.activate', { tabId: tab.tabId })
        : run('tab.create', { url: tab.url, spaceId: space.id, active: true })
    )
  /** A group's card leaves the grid visibly, with its cards, where it stands (the Groups pane has none). */
  const departGroup = (folder: Folder): void => {
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
  }
  /**
   * "Close Group" (TAB-16): the group's tabs close – with the one Undo, as any close here – and
   * the group stays, SAVED with their pages, on the Groups pane; the core's `folder.close`.
   */
  const closeGroup = (folder: Folder): void => {
    departGroup(folder)
    undoable(liveMembersOf(folder.id), () => run('folder.close', { folderId: folder.id }))
  }
  // The Groups pane's rows (TAB-16, `lib/groupRows.ts`): the space's groups by state, a group's
  // private members counting for nothing (a group with pages saved and private tabs alone live
  // is a saved group).
  const rows = groupRows(groups, liveOf)
  const rowOf = (folderId: string): GroupRow | null =>
    [...rows.open, ...rows.saved].find((row) => row.folder.id === folderId) ?? null
  const renamingId = uiStore.use((s) => s.renamingFolderId)
  // The header's count on the Groups pane: every group listed, open, saved or empty.
  const groupCount = rows.open.length + rows.saved.length
  /**
   * "Delete Group": the group's record goes, its live tabs closing with it (undoable, loose) or
   * its saved pages forgotten. It asks first (§9.23, `DeleteGroupSheet`) when there is anything
   * to lose; an empty group just goes.
   */
  const deleteGroupAsked = (row: GroupRow): void => {
    if (row.count > 0) setSheet({ kind: 'delete-group', folderId: row.folder.id })
    else run('folder.delete', { folderId: row.folder.id, unpack: false })
  }
  const deleteGroup = (row: GroupRow): void => {
    const live = liveMembersOf(row.folder.id)
    const remove = (): void => run('folder.delete', { folderId: row.folder.id, unpack: false })
    if (live.length === 0) {
      remove()
      return
    }
    departGroup(row.folder)
    undoable(live, remove)
  }
  /**
   * The Groups pane's tap (TAB-16): the group is shown in the Tabs pane, expanded and scrolled
   * to – a saved one opened first, its pages coming back as tabs of the group (`folder.open`),
   * the Tabs pane catching its card as the tabs arrive (`reveal`); an empty group has nothing to
   * show and its row takes no tap.
   */
  const reveal = useRef<Reveal | null>(null)
  const showGroup = (row: GroupRow): void => {
    if (row.kind === 'empty') return
    if (row.kind === 'saved') void cmd('folder.open', { folderId: row.folder.id }).catch(() => null)
    else if (row.folder.collapsed)
      run('folder.update', { folderId: row.folder.id, patch: { collapsed: false } })
    reveal.current = { folderId: row.folder.id, deadline: performance.now() + REVEAL_TIMEOUT_MS }
    pickOverviewPane('tabs')
  }
  useLayoutEffect(() => {
    const asked = reveal.current
    if (!asked) return
    const card = pane === 'tabs' ? flip.element(`group:${asked.folderId}`) : null
    // Not there yet: the next commit (the opened group's tabs arriving) has another look, up to
    // the deadline; past it the request is dropped on whichever commit finds it stale.
    if (card) card.scrollIntoView({ block: 'start' })
    if (card || performance.now() > asked.deadline) reveal.current = null
  })
  /** A card swiped off the grid is already out of sight: just close the tab. */
  const swipedAway = (tab: Tab): void => undoable([tab], () => run('tab.close', { tabId: tab.id }))

  // The pane's tabs in the order the grid shows them, for what TalkBack says of each card
  // ("tab 2 of 7", `tabCardLabel`): the essentials' row, the pinned cards, the groups' members
  // group by group, then the loose cards – the visual order, which is also the DOM's.
  const ordered = [...essentials, ...pinned, ...groupCards.flatMap((g) => g.tabs), ...loose]
  const placeOf = (tab: Tab): number => ordered.findIndex((t) => t.id === tab.id) + 1

  // The select-tabs mode's cards: what is on show as a card can be picked – the pinned cards,
  // the members of the groups that are open, the loose cards; a folded group's members and the
  // essentials' row are not cards and take no check, and the Groups pane shows no card at all.
  // A pick whose card has left this set (its tab closed elsewhere, its group folded) goes in
  // this same render.
  const checkable = groupsPane
    ? []
    : [...pinned, ...groupCards.flatMap((g) => (g.folder.collapsed ? [] : g.tabs)), ...loose]
  // The search's departures and returns (TAB-21). A card the query dropped is off the grid in
  // this commit: its exit runs from here (`Departures` waits for the browser to show a close;
  // this close is the grid's own). A card a shorter query lets back in is drawn again: the exit
  // still running for it is dropped, and the card enters as that exit run backwards – growing
  // from .9 as it fades in on the exit's spring, a 120 ms fade under reduced motion (§11.3).
  // The New Tab card is one of them: off with the first letter, back with the query cleared.
  const shownCards = useRef<{ query: string; ids: ReadonlySet<string> }>({
    query: '',
    ids: new Set()
  })
  const entrances = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    const was = shownCards.current
    const ids = new Set(checkable.map((t) => t.id))
    if (!searching) ids.add(NEW_TAB_CELL)
    shownCards.current = { query, ids }
    const released: string[] = []
    for (const item of departStore.get().items) {
      const dropped = item.kind === 'new-tab' || (item.kind === 'tab' && item.filtered)
      if (!dropped) continue
      if (flip.element(item.key)) departed(item.key)
      else released.push(item.key)
    }
    if (released.length) releaseDepartures(released)
    if (was.query === query || !settled) return
    for (const id of ids) {
      const el = was.ids.has(id) ? null : flip.element(id)
      if (el) enterCard(el, entrances.current)
    }
  })
  useEffect(() => {
    const running = entrances.current
    if (!interactive) for (const cancel of [...running]) cancel()
    return () => {
      for (const cancel of [...running]) cancel()
    }
  }, [interactive])
  const pruned = pruneSelection(selection, new Set(checkable.map((t) => t.id)))
  if (pruned !== selection) setSelection(pruned)
  const chosen = selectedTabs(pruned, checkable)
  const toggleCard = (tab: Tab): void => setSelection((s) => toggleSelected(s, tab.id))
  const everyPicked = allSelected(
    pruned,
    checkable.map((t) => t.id)
  )
  const toggleAll = (): void =>
    setSelection((s) =>
      everyPicked
        ? deselectAll(s)
        : selectAll(
            s,
            checkable.map((t) => t.id)
          )
    )
  /**
   * The action row's targets (`lib/overviewSelection.ts`): Group takes the picks a group can
   * hold and is not offered on the private pane, which makes no groups; Bookmark and Share take
   * the pages among the picks – a private page's address is the user's to share, as Chrome lets
   * an Incognito tab be shared. Each action ends the mode as it runs; the cards it leaves keep
   * their places (§11.4: nothing reflows on a pick or on Done).
   */
  const groupable = privatePane ? [] : groupableTabs(chosen)
  const pages = pageTabs(chosen)
  const closeSelected = (): void => {
    exitSelection()
    closeTabs(chosen)
  }
  const groupSelected = (folderId: string | null): void => {
    exitSelection()
    const ids = groupable.map((t) => t.id)
    if (folderId) groupTabs(ids, folderId)
    else void makeGroup(ids, true)
  }
  /**
   * Bookmark all (TAB-35): the pages go into one new folder "Tabs from <date>" under the
   * phone's default folder through the core's own `bookmark.createFromTabs` – quietly, so the
   * toast is this one (§9.33): the count, the folder, and Open, which leaves the overview and
   * shows the folder in the Bookmarks panel.
   */
  const bookmarkSelected = async (): Promise<void> => {
    exitSelection()
    const tabIds = pages.map((t) => t.id)
    const folder = await cmd('bookmark.createFromTabs', {
      tabIds,
      title: bookmarkFolderTitle(new Date()),
      parentId: defaultBookmarkFolderId(state.platform),
      quiet: true
    }).catch(() => null)
    if (!folder) return
    const activeId = active?.id ?? null
    pushToast(bookmarkedMessage(tabIds.length, folder.title), 'info', {
      icon: 'star',
      action: {
        label: 'Open',
        onPick: () => {
          closeOverview()
          void openOverlay('bookmarks', activeId, null, folder.id)
        }
      }
    })
  }
  /** Share (SH-12): the pages as a text list through the system share sheet. */
  const shareSelected = (): void => {
    exitSelection()
    run('app.share', shareTabsPayload(pages))
  }
  // An action's name counts the picks IT acts on, the number the picker's title and the
  // bookmark toast will say: Close every pick, Group the groupable ones, Bookmark and Share the
  // pages (a pinned pick among five reads "Group 4 tabs"; a blank tab, "Bookmark 4 tabs").
  const named = (verb: string, count: number): string =>
    `${verb} ${count} ${count === 1 ? 'tab' : 'tabs'}`
  const selectionActions: SelectionAction[] = [
    {
      id: 'close',
      label: 'Close',
      name: named('Close', chosen.length),
      glyph: <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />,
      disabled: chosen.length === 0,
      run: closeSelected
    },
    ...(privatePane
      ? []
      : [
          {
            id: 'group',
            label: 'Group',
            name: named('Group', groupable.length),
            glyph: <Group className="h-5 w-5" strokeWidth={1.75} aria-hidden />,
            disabled: groupable.length === 0,
            run: () => setSheet({ kind: 'group-picker' })
          }
        ]),
    {
      id: 'bookmark',
      label: 'Bookmark',
      name: named('Bookmark', pages.length),
      glyph: <Star className="h-5 w-5" strokeWidth={1.75} aria-hidden />,
      disabled: pages.length === 0,
      run: () => void bookmarkSelected()
    },
    {
      id: 'share',
      label: 'Share',
      name: named('Share', pages.length),
      glyph: <Share2 className="h-5 w-5" strokeWidth={1.75} aria-hidden />,
      disabled: pages.length === 0,
      run: shareSelected
    }
  ]

  const card = (tab: Tab): JSX.Element => (
    <OverviewCard
      key={tab.id}
      tab={tab}
      active={tab.id === active?.id}
      position={placeOf(tab)}
      count={ordered.length}
      hidden={tab.id === heroTabId && p < 1}
      onPick={pick}
      onClose={(t) => closeTabs([t])}
      onSwipeClose={swipedAway}
      lift={{
        // A card in the select-tabs mode is neither picked up nor swiped away: a tap is a pick.
        // Nor is one picked up while a query narrows the grid: the slots a drop would count
        // are the whole pane's, not the grid's; a swipe still closes it.
        enabled: interactive && !tab.pinned && !selecting && !searching,
        swipeable: interactive && closesForReal(tab) && !selecting,
        scroller: () => scrollRef.current,
        onMenu: (t) => setSheet({ kind: 'tab', tabId: t.id }),
        onHover: hoverAt,
        onDrop: dropCard
      }}
      selection={
        selecting ? { selected: isSelected(pruned, tab.id), onToggle: toggleCard } : undefined
      }
    />
  )

  // A Groups pane row's sheet and the delete question read their row live: a group gone from
  // under them (deleted elsewhere) leaves them nothing to show.
  const rowSheet = sheet?.kind === 'group-row' ? rowOf(sheet.folderId) : null
  const deleteSheet = sheet?.kind === 'delete-group' ? rowOf(sheet.folderId) : null

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
            {selecting ? (
              <SelectionHeader
                count={chosen.length}
                everyPicked={everyPicked}
                selectable={checkable.length > 0}
                onToggleAll={toggleAll}
                onDone={exitSelection}
              />
            ) : (
              <>
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
                  {groupsPane
                    ? `${groupCount} group${groupCount === 1 ? '' : 's'}`
                    : `${count} tab${count === 1 ? '' : 's'}`}
                </span>
                <span className="flex-1" />
                {!groupsPane && (
                  <button
                    type="button"
                    className="zen-toolbar-button h-9 w-9"
                    aria-label="Search tabs"
                    aria-expanded={searchOpen}
                    aria-controls={searchOpen ? OVERVIEW_SEARCH_ID : undefined}
                    data-testid="overview-search-toggle"
                    onClick={() => (searchOpen ? closeSearch() : openSearch())}
                  >
                    <Search className="h-[18px] w-[18px]" />
                  </button>
                )}
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
              </>
            )}
          </header>
          {searchOpen && (
            <OverviewSearchField
              value={search.query}
              inputRef={searchInput}
              onChange={changeQuery}
              onClear={clearQuery}
              onClose={closeSearch}
            />
          )}
          <PaneSegment pane={pane} hasPrivate={hasPrivate} onPick={pickOverviewPane} />
          <PaneSlot
            // Each pane is a slot's worth of its own – the space strip, the grid, the groups'
            // rows or the empty explainer – coming up fresh on a 120 ms fade in while the still
            // of the pane before fades out over the same slot (v2 §11.4); the cells start fresh
            // with it.
            pane={pane}
            root={rootRef}
            onLeave={leavePane}
            className="zen-overview-pane relative flex min-h-0 flex-1 flex-col"
          >
            {pane === 'tabs' && state.spaces.length > 1 && (
              <SpaceStrip spaces={state.spaces} activeId={space.id} />
            )}
            {groupsPane ? (
              <GroupsPane
                rows={rows}
                renamingId={renamingId}
                onOpen={showGroup}
                onMenu={(row) => {
                  noteSheetOpener()
                  setSheet({ kind: 'group-row', folderId: row.folder.id })
                }}
              />
            ) : privatePane && count === 0 ? (
              <PrivateEmpty />
            ) : (
              <div
                ref={(el) => {
                  scrollRef.current = el
                  return fadeGrid(el)
                }}
                className="zen-overview-grid min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-1"
                data-pane={pane}
                // The Private pane under the lock cover (INC-05): its grid is out of reach – no
                // focus, no touch, nothing for a screen reader – until the cover lifts; the
                // cards read the placeholder meanwhile (`CardBody`), in case a reader reaches one.
                inert={(privatePane && locked) || undefined}
                aria-hidden={(privatePane && locked) || undefined}
                // The card the page morphs into is scrolled into view: keep it clear of the fades.
                style={{
                  touchAction: 'pan-y',
                  overscrollBehavior: 'contain',
                  scrollPaddingBlock: 16
                }}
                onScroll={measure}
              >
                {searching && found === 0 && (
                  // No card matches (§9.34): §9.17's sentence where the grid was, the reach's
                  // lists beneath it when they have rows – then the sentence names what is
                  // missing, since the rows under it are tabs too.
                  <p className="zen-overview-search-empty" data-testid="overview-search-empty">
                    {foundAll === 0 ? 'No tabs found' : 'No open tabs found'}
                  </p>
                )}
                {essentials.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {essentials.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        className="zen-essential h-12 w-12"
                        data-active={tab.id === active?.id}
                        data-discarded={tab.discarded}
                        aria-label={tabCardLabel(
                          tabTitle(tab),
                          placeOf(tab),
                          ordered.length,
                          tab.id === active?.id
                        )}
                        // An essential is no card: while tabs are being selected it takes no
                        // pick and no tap (§9.30, laid out as it was).
                        disabled={selecting}
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
                  {!searching && <NewTabCard pane={pane} disabled={selecting} />}
                </div>
                {searching && !privatePane && (
                  <OverviewSearchReach
                    reach={reach}
                    onRestore={restoreClosed}
                    onOpenTab={openRemote}
                  />
                )}
              </div>
            )}
            {privatePane && count > 0 && <PrivateLockCover shown={locked} />}
          </PaneSlot>
          <PaneStills stills={stills} onDone={stillDone} />
          <SelectionActions shown={selecting} actions={selectionActions} />
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
            style={{ height: cardHeaderHeight() * p, opacity: p }}
          >
            {heroActive && (
              <div
                className="absolute inset-0"
                style={{ background: 'rgb(var(--zen-accent-rgb) / 0.14)' }}
              />
            )}
            {heroMasked ? (
              <VenetianMask
                className="relative h-4 w-4 shrink-0 opacity-60"
                strokeWidth={1.75}
                aria-hidden
              />
            ) : (
              <Favicon tab={hero} size={16} className="relative" />
            )}
            <span className="zen-overview-card-title relative min-w-0 flex-1 truncate text-[13px] font-medium">
              {heroMasked ? PRIVATE_TAB_PLACEHOLDER : tabTitle(hero)}
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
          others={regularAll.length - 1}
          onClose={() => setSheet(null)}
          onSelect={(tab) => setSelection(startSelection(tab.id))}
          onNewGroup={(tab) => void makeGroup([tab.id], true)}
          onCloseTab={(tab) => closeTabs([tab])}
          onCloseOthers={closeOthers}
        />
      )}
      {interactive && sheet?.kind === 'group-picker' && (
        <GroupPickerSheet
          count={groupable.length}
          groups={groups.map((folder) => ({ folder, count: liveMembersOf(folder.id).length }))}
          onClose={() => leaveSheet('group-picker')}
          onPick={groupSelected}
        />
      )}
      {interactive && sheet?.kind === 'group' && state.folders[sheet.folderId] && (
        <GroupSheet
          folder={state.folders[sheet.folderId]}
          count={liveMembersOf(sheet.folderId).length}
          onClose={() => leaveSheet('group')}
          onCloseGroup={closeGroup}
          onDelete={(folder) => {
            const row = rowOf(folder.id)
            if (row) deleteGroupAsked(row)
          }}
        />
      )}
      {interactive && rowSheet && (
        <GroupRowSheet
          row={rowSheet}
          onClose={() => leaveSheet('group-row')}
          onOpen={showGroup}
          onCloseGroup={closeGroup}
          onDelete={deleteGroupAsked}
        />
      )}
      {interactive && deleteSheet && (
        <DeleteGroupSheet
          row={deleteSheet}
          onClose={() => leaveSheet('delete-group')}
          onConfirm={deleteGroup}
        />
      )}
      {interactive && sheet?.kind === 'menu' && (
        <OverviewMenuSheet
          title={privatePane ? 'Private' : space.name}
          privateTabs={privatePane}
          selectable={checkable.length}
          open={regularAll.length}
          closed={sheet.closed.length}
          onClose={() => leaveSheet('menu')}
          onSelect={() => setSelection(startSelection())}
          onRecentlyClosed={() => setSheet({ kind: 'recently-closed', closed: sheet.closed })}
          onCloseAll={closeAllAsked}
        />
      )}
      {interactive && sheet?.kind === 'close-all' && (
        <CloseAllSheet
          count={regularAll.length}
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
 * The header's menu: "Select Tabs" (TAB-08, the select-tabs mode's entry from the header, as
 * Chrome's tab switcher menu carries it; the header itself keeps its two icon buttons, §9.3),
 * the recently closed list (matrix TAB-22, TAB-23) and "Close All Tabs" (TAB-06); "Close Other
 * Tabs" stays on a card's own menu, where it names the card it keeps. The rows are menu items,
 * so Title Case (v2 §9.1), as the card and group menus' rows are; a row with nothing to act on
 * keeps its count, at zero ("Recently Closed (0)"), and is disabled at .4, never hidden (§9.17)
 * – Select Tabs the same, with no card to pick.
 * The private pane's menu is "Select Tabs" and the one row "Close Private Tabs", named as the
 * app menu names it: no recently closed list applies there (Chrome's Incognito switcher has no
 * Recent tabs either), so the row is not there, not greyed – §9.17's rule is for a count of zero.
 */
function OverviewMenuSheet({
  title,
  privateTabs,
  selectable,
  open,
  closed,
  onClose,
  onSelect,
  onRecentlyClosed,
  onCloseAll
}: {
  title: string
  /** Whether this is the private pane's menu. */
  privateTabs: boolean
  /** How many cards the select-tabs mode could pick. */
  selectable: number
  /** How many tabs "Close All Tabs" would close (the unpinned ones). */
  open: number
  /** How many tabs the recently closed list holds. */
  closed: number
  onClose: () => void
  onSelect: () => void
  onRecentlyClosed: () => void
  onCloseAll: () => void
}): JSX.Element {
  const counted = (label: string, n: number): string => `${label} (${n})`
  const select: SheetAction = {
    id: 'select',
    label: 'Select Tabs',
    disabled: selectable === 0,
    onPick: onSelect
  }
  const actions: SheetAction[] = privateTabs
    ? [
        select,
        {
          id: 'close-all',
          label: counted('Close Private Tabs', open),
          destructive: true,
          disabled: open === 0,
          onPick: onCloseAll
        }
      ]
    : [
        select,
        {
          id: 'recently-closed',
          label: counted('Recently Closed', closed),
          disabled: closed === 0,
          onPick: onRecentlyClosed
        },
        {
          id: 'close-all',
          label: counted('Close All Tabs', open),
          destructive: true,
          disabled: open === 0,
          onPick: onCloseAll
        }
      ]
  return <OverviewSheet title={title} actions={actions} onClose={onClose} />
}

/**
 * The header while tabs are being selected (TAB-08; v2 §9.6): Android's contextual action bar
 * in the overview's own 56 header – its content REPLACES the header row's (the space's name and
 * count, Spaces, More), never stacks under it, and the Tabs | Private segment stays beneath as
 * before. The leading X is the platform's action-mode close, named "Done" as Android names it
 * (the back gesture does the same; a trailing Done is iOS's and is not drawn), the count in the
 * title's place as a live region ("3 selected"; "Select tabs" before the first pick, so the
 * mode announces itself), and Select all – Deselect all once every card is picked – as the one
 * trailing §9.18 secondary `zen-v2-button`, in the window family (§9.29, the overview's button
 * rule; the app has no text button). The panels' selection header (`PhoneSelectionHeader`) is
 * the same shape; this one sits in the overview's header element, on the overview's handle, so
 * it cannot be that component.
 */
function SelectionHeader({
  count,
  everyPicked,
  selectable,
  onToggleAll,
  onDone
}: {
  count: number
  /** Every card the grid offers is picked: the action reads Deselect all. */
  everyPicked: boolean
  /** The grid has cards to pick; without them Select all is disabled (§9.30). */
  selectable: boolean
  onToggleAll: () => void
  onDone: () => void
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="zen-toolbar-button -ml-1.5 h-9 w-9"
        aria-label="Done"
        data-testid="overview-select-done"
        onClick={onDone}
      >
        <X className="h-5 w-5" strokeWidth={1.75} />
      </button>
      <span
        className="zen-title min-w-0 flex-1 truncate tabular-nums"
        aria-live="polite"
        data-testid="overview-selected-count"
      >
        {selectionTitle(count)}
      </span>
      <button
        type="button"
        className="zen-v2-button"
        disabled={!selectable}
        data-testid="overview-select-all"
        onClick={onToggleAll}
      >
        {everyPicked ? 'Deselect all' : 'Select all'}
      </button>
    </>
  )
}

/** One action of the select-tabs mode's row (`SelectionActions`). */
interface SelectionAction {
  id: string
  /** The one word under the glyph. */
  label: string
  /** What the button is called for assistive technology: the verb with the count ("Close 3 tabs"). */
  name: string
  glyph: ReactNode
  /** Nothing among the picks for this action to act on: disabled at .4, laid out as it was (§9.30). */
  disabled: boolean
  run: () => void
}

/**
 * The select-tabs mode's action row (TAB-08): a window-family strip (v2 §9.29) at the foot of
 * the overview, above the bar – one band in the window fill, the group strip's tray at the
 * card's radius, holding the actions as glyph-over-label buttons that share its width, named
 * with their count for TalkBack. The strip's slot takes its height the moment the mode is on
 * (one layout change; the grid's cells glide if the shorter grid moves them, §11.4) and the
 * band slides up into the slot on `SPRING_GENTLE`, back down as the mode ends, the slot
 * clipping it; the spring writes the transform per frame, promoted for those frames only.
 * Under reduced motion the band fades its 120 ms in place instead (§11.3), on its own opacity
 * transition, and leaves once that has run.
 */
function SelectionActions({
  shown,
  actions
}: {
  shown: boolean
  actions: SelectionAction[]
}): JSX.Element | null {
  const [mounted, setMounted] = useState(shown)
  if (shown && !mounted) setMounted(true)
  const band = useRef<HTMLDivElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const unmount = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    const el = band.current
    if (!el) return
    if (unmount.current !== null) {
      clearTimeout(unmount.current)
      unmount.current = null
    }
    spring.current ??= new SpringAnimation(
      SPRING_GENTLE,
      (x) => {
        const b = band.current
        if (!b) return
        if (reducedMotion()) {
          b.style.transform = ''
          b.style.opacity = String(x)
        } else {
          b.style.transform = `translateY(${(1 - x) * 100}%)`
          b.style.opacity = ''
        }
      },
      (x) => {
        const b = band.current
        if (b) b.style.willChange = ''
        if (x < 0.5)
          unmount.current = setTimeout(() => setMounted(false), reducedMotion() ? 120 : 0)
      }
    )
    const s = spring.current
    // The band was just laid out at its start (below the slot, or unpainted): make sure the
    // engine has seen it there, so the reduced-motion opacity transition has a from-value.
    void el.getBoundingClientRect()
    el.style.willChange = 'transform'
    const { x, v } = s.current
    s.start(x, v, shown ? 1 : 0)
    return () => {
      if (unmount.current !== null) {
        clearTimeout(unmount.current)
        unmount.current = null
      }
    }
  }, [shown, mounted])
  useEffect(
    () => () => {
      spring.current?.stop()
    },
    []
  )
  if (!mounted) return null
  return (
    <div className="zen-overview-actions" data-testid="overview-actions">
      <div
        ref={band}
        className="zen-overview-actions-band"
        style={reducedMotion() ? { opacity: 0 } : { transform: 'translateY(100%)' }}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="zen-overview-action"
            aria-label={action.name}
            disabled={action.disabled}
            data-testid={`overview-action-${action.id}`}
            onClick={action.run}
          >
            {action.glyph}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Group's picker (TAB-08): a 9.13 sheet of the pane's groups – "New group" first, then each
 * group by its name and colour, with how many cards it holds – for the picks a group can take;
 * the rows are the card menu's own ("Add to <name>"), so the two ways of grouping read alike.
 * A picker's option row is sentence case (§9.1; the card menu's "New Group" is a menu item and
 * Title Case, the design gate on #304). It is the overview's action sheet, on the frame's
 * dialog host over the grid.
 */
function GroupPickerSheet({
  count,
  groups,
  onClose,
  onPick
}: {
  /** How many of the picked tabs will be grouped. */
  count: number
  groups: HeldGroup[]
  onClose: () => void
  /** A group was picked: its folder id, or null for a new group. */
  onPick: (folderId: string | null) => void
}): JSX.Element {
  const actions: SheetAction[] = [
    { id: 'new-group', label: 'New group', onPick: () => onPick(null) },
    ...groups.map(({ folder, count: held }): SheetAction => ({
      id: `group-${folder.id}`,
      label: `Add to ${folder.name} (${held})`,
      icon: <GroupDot color={folder.color} />,
      onPick: () => onPick(folder.id)
    }))
  ]
  return (
    <OverviewSheet
      title={`Group ${count} ${count === 1 ? 'tab' : 'tabs'}`}
      actions={actions}
      onClose={onClose}
    />
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

function TabSheet({
  state,
  tab,
  groups,
  groupable,
  others,
  onClose,
  onSelect,
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
  /** "Select Tabs": the select-tabs mode, with this card picked (TAB-08). */
  onSelect: (tab: Tab) => void
  onNewGroup: (tab: Tab) => void
  onCloseTab: (tab: Tab) => void
  onCloseOthers: (tab: Tab) => void
}): JSX.Element {
  const current = tab.folderId && state.folders[tab.folderId] ? tab.folderId : null
  // The rows are menu items, so Title Case (v2 §9.1, the #207 ruling): "New Group", "Close Other
  // Tabs (3)"; a group's own name is written as the user gave it. Select Tabs leads: it is the
  // way to act on several cards, and the rows under it act on this one.
  const actions: SheetAction[] = [
    { id: 'select', label: 'Select Tabs', onPick: () => onSelect(tab) }
  ]
  if (groupable && !tab.pinned && !tab.essential) {
    actions.push({ id: 'new-group', label: 'New Group', onPick: () => onNewGroup(tab) })
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
        label: 'Remove from Group',
        onPick: () => run('tab.moveToFolder', { tabId: tab.id, folderId: null })
      })
  }
  if (!tab.pinned && !tab.essential && others > 0)
    actions.push({
      id: 'close-others',
      label: `Close Other Tabs (${others})`,
      destructive: true,
      onPick: () => onCloseOthers(tab)
    })
  actions.push({
    id: 'close',
    label: 'Close Tab',
    destructive: true,
    onPick: () => onCloseTab(tab)
  })
  return <OverviewSheet title={tabTitle(tab)} actions={actions} onClose={onClose} />
}

/**
 * A group card's hold sheet (the header's menu): the colour swatches (`GroupColorPalette`, the
 * Groups pane's row sheet shares them), Rename, Collapse / Expand, Ungroup, then Close Group –
 * its tabs close and the group stays saved with their pages on the Groups pane (TAB-16) – and
 * Delete Group, which asks first (§9.23) since the group holds tabs. Menu items, so Title Case
 * (v2 §9.1): the count keeps its unit, capitalised with the rest.
 */
function GroupSheet({
  folder,
  count,
  onClose,
  onCloseGroup,
  onDelete
}: {
  folder: Folder
  count: number
  onClose: () => void
  onCloseGroup: (folder: Folder) => void
  onDelete: (folder: Folder) => void
}): JSX.Element {
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
    // Close Group destroys nothing the saved group does not keep (`folder.close`): the plain
    // ink, as on the Groups pane's row sheet and the tablet's menu; Delete Group alone is danger.
    {
      id: 'close',
      label: `Close Group (${count} ${count === 1 ? 'Tab' : 'Tabs'})`,
      onPick: () => onCloseGroup(folder)
    },
    {
      id: 'delete',
      label: 'Delete Group',
      destructive: true,
      onPick: () => onDelete(folder)
    }
  ]
  return (
    <OverviewSheet
      title={folder.name}
      header={<GroupColorPalette folder={folder} />}
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
 * pane it opens a private tab (INC-01). While tabs are being selected it is no card to pick and
 * takes no tap (§9.30, in its place). While a query stands it is off the grid with the cards
 * that do not match (§9.34), its face leaving as theirs do (`NewTabFace`, `Departures`).
 */
function NewTabCard({ pane, disabled }: { pane: OverviewPane; disabled?: boolean }): JSX.Element {
  const isPrivate = pane === 'private'
  return (
    <button
      type="button"
      className="zen-overview-new flex flex-col items-center justify-center gap-2 text-[var(--zen-muted)] active:text-[var(--zen-fg)]"
      style={{ aspectRatio: '3 / 4' }}
      data-cell={NEW_TAB_CELL}
      data-testid={isPrivate ? 'overview-new-private-tab' : 'overview-new-tab'}
      disabled={disabled}
      onClick={() => newTabOn(pane)}
    >
      <NewTabFace isPrivate={isPrivate} />
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
 * The overview's panes as a tab bar above the grid (TAB-02, TAB-16): "Tabs", "Groups" and –
 * where the host has private tabs – "Private" on the shared `.zen-v2-segment` primitive (design
 * language v2 §9.34): text tabs in the window family – the picked one in the window ink with the
 * 2 px accent line under it, the others at 69% – switching on a tap with a 120 ms state change
 * (§11.4); not a segmented pill (§9.14 has none). The class is the truth for its geometry and
 * inks (a row tall at the 16 gutter, each label a 44 target); the markup carries the roles.
 */
function PaneSegment({
  pane,
  hasPrivate,
  onPick
}: {
  pane: OverviewPane
  hasPrivate: boolean
  onPick: (pane: OverviewPane) => void
}): JSX.Element {
  const panes: Array<{ id: OverviewPane; label: string }> = [
    { id: 'tabs', label: 'Tabs' },
    { id: 'groups', label: 'Groups' }
  ]
  if (hasPrivate) panes.push({ id: 'private', label: 'Private' })
  return (
    <div
      role="tablist"
      // The list's name says what it holds: Private only where the host has it.
      aria-label={hasPrivate ? 'Tabs, groups and private tabs' : 'Tabs and groups'}
      className="zen-v2-segment"
    >
      {panes.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={pane === id}
          data-pane={id}
          data-testid={`overview-pane-${id}`}
          onClick={() => {
            if (pane !== id) onPick(id)
          }}
        >
          {label}
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
      className="relative min-h-0 flex-1"
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

/**
 * A card the search lets back into the grid enters as a closing card's exit run backwards
 * (§11.4, `Departures`): from `scale(1 − .1)` and opacity 0 to rest on `SPRING_SNAPPY` over the
 * exit's 120 px of travel – written to the cell's own `scale` and `opacity`, beside the
 * `transform` the FLIP set writes for its glide, and cleared at rest; under reduced motion a
 * 120 ms fade in place (§11.3). `running` holds the way to cut it short: the styles are cleared
 * and the card stands as laid out.
 */
function enterCard(el: HTMLElement, running: Set<() => void>): void {
  if (reducedMotion()) {
    el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE_MS, easing: EASE })
    return
  }
  const settle = (): void => {
    el.style.scale = ''
    el.style.opacity = ''
    el.style.willChange = ''
    running.delete(cancel)
  }
  const spring = new SpringAnimation(
    SPRING_SNAPPY,
    (x) => {
      const t = x / ENTER_TRAVEL
      el.style.scale = String(1 - ENTER_SCALE * t)
      el.style.opacity = String(Math.max(0, 1 - t))
    },
    settle
  )
  const cancel = (): void => {
    spring.stop()
    settle()
  }
  running.add(cancel)
  el.style.willChange = 'transform, opacity'
  spring.start(ENTER_TRAVEL, 0, 0)
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

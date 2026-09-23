import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brush, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { dropStore, listMotions } from '@renderer/lib/drag'
import { viewportStore } from '@renderer/lib/formFactor'
import { openGroupEditor } from '@renderer/lib/groupEditor'
import { groupColorChannels, groupColorHex, groupsOf } from '@renderer/lib/groups'
import { isPrivateGroup, regularMembers } from '@renderer/lib/groupRows'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import {
  isPrivateWindow,
  pinnedOf,
  regularOf,
  rowKey,
  stripRows,
  type StripRow
} from '@renderer/lib/selectors'
import { hint, useHint } from '@renderer/lib/shortcuts'
import { stripFocusIn, stripFocusOut, stripKeyDown, useStripTabIndex } from '@renderer/lib/tabStrip'
import type { StripSlot } from '@renderer/lib/tabStripLayout'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { SpaceGlyph } from '../SpaceGlyph'
import { DEFAULT_FOLDER_ICON } from '../phone/GroupCard'
import { useLongPress } from '../phone/useLongPress'
import { TOOLBAR_STROKE, V2_TRAILING_GLYPH } from '../v2/controls'
import { ListMotionContext } from './listMotion'
import { SplitGroupRow } from './SplitGroupRow'
import { useStripAxis } from './stripAxis'
import { TabItem } from './TabItem'
import { useGroupFold } from './useGroupFold'

interface Props {
  state: UIState
  space: Space
  isActive: boolean
  compact: boolean
}

/** More rows than this arriving in one commit is a restore, placed without motion. */
const ENTER_BATCH = 6

/** One space's tab list: space header, pinned tabs, separator, folders + regular tabs, new tab. */
export function SpacePanel({ state, space, isActive, compact }: Props): JSX.Element {
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const zones = dropStore.use((s) => s.zones)
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  // The space's groups as rows. On a host that keeps private browsing in tabs the space holds
  // its private tabs among the regular ones, and this panel is a REGULAR surface (a private
  // window's is private mode itself, and lists its own groups whole): a PRIVATE group
  // (`isPrivateGroup` – private tabs alone live in it, nothing saved) is no row of it, so no
  // private group's existence or name shows outside private mode, and a group's private members
  // are not its rows or its count here (the Groups pane's rule); they list among the loose rows,
  // where the panel lists the space's private tabs. The desktop's regular spaces hold no private
  // tab (a private window's live in its own space), so its rows are as they were.
  const regularSurface = !isPrivateWindow(state)
  const liveOf = (folderId: string): Tab[] => regular.filter((t) => t.folderId === folderId)
  const membersOf = (folderId: string): Tab[] =>
    regularSurface ? regularMembers(liveOf(folderId)) : liveOf(folderId)
  const folders = groupsOf(state, space.id).filter(
    (f) => !regularSurface || !isPrivateGroup(f, liveOf(f.id))
  )
  const listed = new Set(folders.map((f) => f.id))
  const loose = regular.filter(
    (t) => !t.folderId || !listed.has(t.folderId) || (regularSurface && isPrivateTab(t))
  )
  const activeTabId = space.activeTabId
  const showSeparator = state.settings.showTabSeparator && (pinned.length > 0 || regular.length > 0)
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })

  // The rows' motion (design-language §7): neighbours slide open for a lifted row, rows whose
  // slot moved spring there, new rows grow into their slot. One per panel, keyed by its scroller
  // so lib/drag.ts finds it from a row.
  const [motion] = useState(() => new SlideMotion('y', { enter: true, batch: ENTER_BATCH }))
  useEffect(() => () => motion.dispose(), [motion])
  const scroller = useCallback(
    (el: HTMLDivElement | null) => {
      const teardown = fade(el)
      motion.setScroller(el)
      if (el) listMotions.set(el, motion)
      return () => {
        if (typeof teardown === 'function') teardown()
        motion.setScroller(null)
      }
    },
    [fade, motion]
  )
  const orderKey = [
    space.pinnedCollapsed ? 'c' : 'o',
    ...pinned.map((t) => t.id),
    ...folders.map((f) => `${f.id}${f.collapsed ? '-' : '+'}`),
    ...regular.map((t) => `${t.id}${t.folderId ?? ''}`)
  ].join('|')
  useLayoutEffect(() => {
    // The row whose ghost is still gliding into its slot is placed, not animated. The rows also
    // glide when a drop zone above the panel takes its room (`zones`), rather than jumping.
    motion.flip(uiStore.get().drag?.tabId ?? null, isActive)
  }, [motion, orderKey, isActive, zones])

  const pinnedHeaderKey = `header:${space.id}`
  const activePinnedHidden = space.pinnedCollapsed && pinned.some((t) => t.id === activeTabId)

  return (
    <ListMotionContext.Provider value={motion}>
      {/* The panels of the other spaces are off to the side: out of the tab order and the
          accessibility tree (`inert`) until the strip slides them in. */}
      <div
        className="flex h-full w-full shrink-0 flex-col"
        aria-hidden={!isActive}
        inert={!isActive}
      >
        <div
          ref={scroller}
          data-tab-scroller
          data-active={isActive}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-1"
          onDoubleClick={(e) => {
            // Zen: double-clicking empty sidebar space opens a new tab.
            if (e.target === e.currentTarget) window.dispatchEvent(new CustomEvent('zen-new-tab'))
          }}
          onContextMenu={(e) => {
            // The strip's own menu on its empty space (tabs-35, BUG-049): the room below the
            // rows, the gaps between them, the list's padding. A row, header or the New Tab
            // row that opened its own menu has claimed the event by now.
            if (e.isDefaultPrevented()) return
            e.preventDefault()
            run('newtab.contextMenu', contextMenuAnchor(e))
          }}
        >
          {/* The tab list (a11y-07, a11y-31): the pinned header and rows, folder headers and
              rows, loose rows – one tablist per space, vertical; the New Tab button is the
              strip's next control after it. */}
          <div
            className="flex flex-col"
            role="tablist"
            aria-orientation="vertical"
            aria-label={`${space.name} tabs`}
          >
            {pinned.length > 0 && (
              <>
                <SpaceHeader space={space} compact={compact} fallback={activePinnedHidden} />
                {!space.pinnedCollapsed && (
                  <div className="relative flex flex-col gap-0.5" data-tab-list="pinned">
                    {stripRows(pinned, state.splitGroups).map((row) => (
                      <StripRowItem
                        key={rowKey(row)}
                        row={row}
                        activeTabId={activeTabId}
                        compact={compact}
                        parent={pinnedHeaderKey}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
            {showSeparator && (
              <div className="group/sep relative my-1.5 flex items-center gap-2 px-1">
                <div className="h-px flex-1 bg-[var(--zen-border)]" />
                {regular.length > 0 && !compact && (
                  // Pointer-only (it shows on hover); the keyboard has the space menu's
                  // "Close Unpinned Tabs" and the action's shortcut.
                  <button
                    type="button"
                    tabIndex={-1}
                    className="zen-toolbar-button h-5 w-5 opacity-0 group-hover/sep:opacity-70"
                    title={hint('Clear unpinned tabs', state, 'space.closeUnpinned')}
                    onClick={() => run('space.closeUnpinned', { spaceId: space.id })}
                  >
                    <Brush className="h-3 w-3" />
                  </button>
                )}
                {/* Pinning by drag: the separator is the target, over its own margins, so nothing
                    in the list moves when a drag starts (an appearing zone would shift the rows). */}
                {drag && (
                  <DropZone
                    dropKey={`section:pinned:${space.id}`}
                    activeKey={dropKey}
                    label="Pin here"
                    overlay
                  />
                )}
              </div>
            )}
            <div className="flex flex-col gap-0.5" data-tab-list="regular">
              {folders.map((folder) => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  tabs={membersOf(folder.id)}
                  activeTabId={activeTabId}
                  compact={compact}
                  dropKey={dropKey}
                  dragging={Boolean(drag)}
                  live={Boolean(state.liveFolders[folder.id])}
                  liveError={state.liveFolders[folder.id]?.lastError ?? null}
                  splitGroups={state.splitGroups}
                />
              ))}
              {stripRows(loose, state.splitGroups).map((row) => (
                <StripRowItem
                  key={rowKey(row)}
                  row={row}
                  activeTabId={activeTabId}
                  compact={compact}
                />
              ))}
            </div>
          </div>
          <NewTabButton
            compact={compact}
            spaced={folders.length > 0 || regular.length > 0}
            dropInto={dropKey === `newtab:${space.id}`}
          />
          <div
            className="relative min-h-6 flex-1"
            data-strip-empty
            onDoubleClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
          >
            {drag && <DropZone dropKey={`section:regular:${space.id}`} activeKey={dropKey} tall />}
          </div>
        </div>
      </div>
    </ListMotionContext.Provider>
  )
}

/**
 * One row of a tab list: a tab's own row, or a split group's row (§9.35). The horizontal strip
 * (§9.37) lays the same rows along the caption band and passes each its trailing `slot`.
 */
export function StripRowItem({
  row,
  activeTabId,
  compact,
  indent,
  parent,
  slot
}: {
  row: StripRow
  activeTabId: string | null
  compact: boolean
  indent?: boolean
  parent?: string
  slot?: (tab: Tab, active: boolean) => StripSlot
}): JSX.Element {
  if (row.kind === 'tab') {
    const active = row.tab.id === activeTabId
    return (
      <TabItem
        tab={row.tab}
        active={active}
        compact={compact}
        indent={indent}
        parent={parent}
        slot={slot?.(row.tab, active)}
      />
    )
  }
  return (
    <SplitGroupRow
      group={row.group}
      anchor={row.anchor}
      tabs={row.tabs}
      activeTabId={activeTabId}
      compact={compact}
      indent={indent}
      parent={parent}
    />
  )
}

/**
 * The pinned section's header: the space's name, folding its pinned rows. A strip item
 * (lib/tabStrip.ts): Enter, Space, Left and Right fold and unfold it; `fallback` makes it the
 * strip's tab stop while it hides the active row. A row of the strip (§5's 32, radius 8, the
 * window hover fill) with the name as §4's small label – 13/600, the sidebar "Space" form – in
 * full ink: a Space's name in the strip is a name, never deemphasised (§9.29).
 */
function SpaceHeader({
  space,
  compact,
  fallback
}: {
  space: Space
  compact: boolean
  fallback: boolean
}): JSX.Element {
  const key = `header:${space.id}`
  const tabIndex = useStripTabIndex(key, fallback)
  return (
    <button
      type="button"
      className="mb-1 flex h-[var(--zen-tab-row)] w-full items-center gap-2 rounded-lg px-2 text-[13px] font-semibold text-[var(--zen-fg)] hover:bg-[var(--v2-window-fill-hover)]"
      title={space.pinnedCollapsed ? 'Show pinned tabs' : 'Collapse pinned tabs'}
      aria-label={`${space.name} pinned tabs`}
      aria-expanded={!space.pinnedCollapsed}
      data-strip-item={key}
      tabIndex={tabIndex}
      onFocus={stripFocusIn}
      onBlur={stripFocusOut}
      onKeyDown={stripKeyDown}
      onClick={() => run('space.togglePinnedCollapsed', { spaceId: space.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        run('space.contextMenu', { spaceId: space.id, ...contextMenuAnchor(e) })
      }}
    >
      <SpaceGlyph icon={space.icon} size={14} />
      {!compact && <span className="min-w-0 flex-1 truncate text-left">{space.name}</span>}
      {!compact &&
        (space.pinnedCollapsed ? (
          <ChevronRight className={V2_TRAILING_GLYPH} />
        ) : (
          <ChevronDown className={V2_TRAILING_GLYPH} />
        ))}
    </button>
  )
}

/**
 * A drop target that takes no room of its own: `tall` fills the empty space under the rows,
 * `overlay` covers the separator and its margins. Both light up (fill, inset outline, label)
 * only while the pointer is over them.
 */
function DropZone({
  dropKey,
  activeKey,
  label,
  tall,
  overlay
}: {
  dropKey: string
  activeKey: string | null
  label?: string
  tall?: boolean
  overlay?: boolean
}): JSX.Element {
  const active = activeKey === dropKey
  return (
    <div
      data-drop={dropKey}
      data-drop-into={active || undefined}
      className={cn(
        'absolute z-10 flex items-center justify-center rounded-lg text-[11px] text-[var(--v2-control-text-deemphasized)]',
        tall && 'inset-0',
        overlay && 'inset-x-0 -inset-y-1.5'
      )}
    >
      {label && active ? label : null}
    </div>
  )
}

/**
 * The New Tab row under the list; `spaced` keeps the list's 2 px gap above it when it has rows.
 * An address dragged from outside opens in a new tab at the end of the list when dropped on it
 * (lib/dnd.ts, `data-new-tab`), and the button shows it will (§9.4). In the horizontal strip
 * (§9.37) it is a 28 `zen-toolbar-button` 4 after the last tab (`button`), the same event, the
 * same menu and the same drop.
 */
export function NewTabButton({
  compact,
  spaced,
  dropInto,
  button
}: {
  compact: boolean
  spaced: boolean
  dropInto: boolean
  /** The strip's 28 icon button rather than the sidebar's row. */
  button?: boolean
}): JSX.Element {
  const title = useHint('New Tab', 'tab.new')
  return (
    <button
      type="button"
      className={cn(
        button
          ? 'zen-toolbar-button zen-no-drag shrink-0'
          : ['zen-tab text-[var(--zen-fg)]', compact && 'justify-center px-0', spaced && 'mt-0.5']
      )}
      data-new-tab
      data-strip-new-tab={button || undefined}
      data-drop-into={dropInto || undefined}
      title={title}
      aria-label={button ? 'New Tab' : undefined}
      onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
      onContextMenu={(e) => {
        e.preventDefault()
        run('newtab.contextMenu', contextMenuAnchor(e))
      }}
    >
      <Plus className="h-4 w-4 shrink-0" strokeWidth={button ? TOOLBAR_STROKE : undefined} />
      {!compact && !button && <span>New Tab</span>}
    </button>
  )
}

interface FolderRowProps {
  folder: Folder
  tabs: Tab[]
  activeTabId: string | null
  compact: boolean
  dropKey: string | null
  dragging: boolean
  /** Zen Live Folder: contents come from GitHub / RSS / a REST API. */
  live: boolean
  liveError: string | null
  splitGroups: UIState['splitGroups']
  /** The horizontal strip's trailing slot for each member row (§9.37). */
  slot?: (tab: Tab, active: boolean) => StripSlot
}

/**
 * A group's header and its member rows. In the sidebar the header is a folder row – icon,
 * colour swatch, name, count, chevron – with the members indented beneath it; on the tablet the
 * full-width group row (§9.36). In the horizontal strip (§9.37, the list's axis `x`) the header
 * is the group's chip – 32 tall at radius 8, the 8 colour dot, the name at 13/600 – ahead of its
 * members, and the group's colour runs as one continuous 2 px line in the band's top inset from
 * the chip's start to the last member's end, bridging the gaps (`.zen-strip-group-line` on the
 * shell, never a dash per pill); the fold runs the shell's width on the spring.
 */
export function FolderRow({
  folder,
  tabs,
  activeTabId,
  compact,
  dropKey,
  dragging,
  live,
  liveError,
  splitGroups,
  slot
}: FolderRowProps): JSX.Element {
  const horizontal = useStripAxis() === 'x'
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const editing = uiStore.use((s) => s.groupEditor?.folderId === folder.id)
  // The tablet's row (TABLET-04, v2 §9.36): the group as a full-width 44 row like Zen's folder –
  // the colour dot or the saved ring in the glyph slot, the name, the count as a 13 aside, the
  // chevron trailing, the tabs indented beneath while open – the phone overview's own group
  // header on the sidebar's grid; the fold on a spring (`useGroupFold`); a SAVED group – its
  // tabs closed, its pages kept (TAB-16) – as a row whose tap opens it. The desktop's row is as
  // it was.
  const tablet = viewportStore.use((v) => v.formFactor === 'tablet')
  const saved = tablet && tabs.length === 0 && Boolean(folder.savedTabs?.length)
  const lastClick = useRef(0)
  const collapsedBeforeClick = useRef(folder.collapsed)
  const containsActive = tabs.some((t) => t.id === activeTabId)
  const isDropTarget = dropKey === `folder:${folder.id}`
  const toggle = (): void =>
    run('folder.update', { folderId: folder.id, patch: { collapsed: !folder.collapsed } })
  // The header is a tab group's (tabs-14): a press folds or unfolds it; the second press of a
  // double-click undoes the first's fold and opens the group editor bubble (tabs-13) instead, as
  // does the folder menu's Edit Folder… (the tablet's tap always folds: its menu, on the hold,
  // has the group's name and colour). It is a strip item (lib/tabStrip.ts) – Chrome's group
  // header: Enter, Space, Left and Right fold it, the arrows reach it from the rows (§9.22) – and
  // the strip's tab stop while it stands for the active tab (folded around it).
  const key = `folder:${folder.id}`
  const tabIndex = useStripTabIndex(key, containsActive && folder.collapsed)
  const shell = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLDivElement>(null)
  const drawn = useGroupFold(
    shell,
    header,
    folder.collapsed,
    tabs,
    tablet || horizontal,
    horizontal ? 'x' : 'y'
  )
  const count = saved ? (folder.savedTabs?.length ?? 0) : tabs.length
  const unit = count === 1 ? 'tab' : 'tabs'
  const description =
    tablet || horizontal
      ? `Tab group, ${saved ? 'saved, ' : ''}${count} ${unit}`
      : `${live ? 'Live folder' : 'Folder'}, ${count} ${unit}`
  // The tablet row's hold (the phone's group card's, `useLongPress`: a haptic tick at 380 ms, the
  // menu on the release, the click after it swallowed): the group's menu as a §9.36 popover at
  // the finger.
  const press = useLongPress(({ x, y }) =>
    run('folder.contextMenu', { folderId: folder.id, x: Math.round(x), y: Math.round(y) })
  )
  const { onContextMenu: holdMenu, ...hold } = press.handlers
  return (
    <div
      ref={shell}
      className={cn(
        'zen-group-fold',
        horizontal
          ? 'zen-strip-group relative flex h-full shrink-0 items-end gap-1'
          : 'flex flex-col gap-0.5'
      )}
      data-strip-group-shell={horizontal ? folder.id : undefined}
    >
      <div
        ref={header}
        className={cn(
          'zen-tab',
          compact && !horizontal && 'justify-center px-0',
          tablet && 'zen-group-row',
          horizontal && 'zen-strip-group-chip'
        )}
        role="button"
        aria-label={folder.name}
        aria-description={description}
        aria-expanded={saved ? undefined : !folder.collapsed}
        data-strip-item={key}
        tabIndex={tabIndex}
        data-active={containsActive && folder.collapsed}
        data-editing={editing || undefined}
        data-drop-into={isDropTarget || undefined}
        data-tab-folder={folder.id}
        data-strip-group={horizontal ? folder.id : undefined}
        data-saved={saved || undefined}
        onFocus={stripFocusIn}
        onBlur={stripFocusOut}
        onKeyDown={stripKeyDown}
        onClick={() => {
          if (tablet) {
            // A hold's release is the menu's, not a tap; the name being edited takes the taps;
            // a saved group's tap brings its pages back.
            if (press.swallowsClick() || renaming) return
            if (saved) run('folder.open', { folderId: folder.id })
            else toggle()
            return
          }
          const now = performance.now()
          if (now - lastClick.current < 400) {
            lastClick.current = 0
            run('folder.update', {
              folderId: folder.id,
              patch: { collapsed: collapsedBeforeClick.current }
            })
            openGroupEditor(folder.id)
            return
          }
          lastClick.current = now
          collapsedBeforeClick.current = folder.collapsed
          toggle()
        }}
        onContextMenu={(e) => {
          // The tablet's is the hold's (Chromium raises it during the hold): the menu at the
          // finger, once.
          if (tablet) return holdMenu(e)
          e.preventDefault()
          run('folder.contextMenu', { folderId: folder.id, ...contextMenuAnchor(e) })
        }}
        {...(tablet ? hold : {})}
        title={compact ? folder.name : undefined}
      >
        {dragging && <div data-drop={`folder:${folder.id}`} className="absolute inset-0 z-10" />}
        {horizontal ? (
          <>
            {/* The chip's dot: the group's colour with the ink's 20 % hairline (a11y-30). */}
            <span
              className="h-2 w-2 shrink-0 rounded-full border border-[rgb(var(--zen-fg-rgb)/0.2)]"
              style={{ background: groupColorHex(folder.color) }}
              data-strip-group-dot
              aria-hidden
            />
            {renaming ? (
              <FolderRename folder={folder} />
            ) : (
              <span
                className="min-w-0 truncate text-[13px] font-semibold"
                data-strip-group-name
                data-testid="group-chip-name"
              >
                {folder.name}
              </span>
            )}
            {live && (
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  liveError ? 'bg-[var(--v2-danger)]' : 'zen-live-dot bg-[var(--v2-control-accent)]'
                )}
                title={liveError ?? 'Live folder – updates automatically'}
              />
            )}
          </>
        ) : tablet ? (
          <>
            <GroupRowGlyph folder={folder} saved={saved} />
            {!compact &&
              (renaming ? (
                <FolderRename folder={folder} />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate" data-testid="group-row-name">
                    {folder.name}
                  </span>
                  <span className="zen-group-row-count" data-testid="group-row-count">
                    {count}
                  </span>
                  {/* A saved group has nothing to fold: its chevron's box stays, empty, so the
                      counts of saved and open rows share one edge. */}
                  {saved ? (
                    <span className="zen-group-row-chevron" aria-hidden />
                  ) : folder.collapsed ? (
                    <ChevronRight className="zen-group-row-chevron" aria-hidden />
                  ) : (
                    <ChevronDown className="zen-group-row-chevron" aria-hidden />
                  )}
                </>
              ))}
          </>
        ) : (
          <>
            <span className="text-sm leading-none">{folder.icon}</span>
            {folder.color && !compact && (
              // The folder's colour as a swatch with the ink's 20 % hairline (a11y-30, §9.14; the
              // space glyph's rule), so it keeps an edge on a like-coloured window.
              <span
                className="h-2 w-2 shrink-0 rounded-full border border-[rgb(var(--zen-fg-rgb)/0.2)]"
                style={{ background: FOLDER_COLORS[folder.color] }}
              />
            )}
            {!compact &&
              (renaming ? (
                <FolderRename folder={folder} />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  {live && (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        liveError
                          ? 'bg-[var(--v2-danger)]'
                          : 'zen-live-dot bg-[var(--v2-control-accent)]'
                      )}
                      title={liveError ?? 'Live folder – updates automatically'}
                    />
                  )}
                  {/* The count and the chevron are supplementary: the deemphasised ink (§9.29). */}
                  <span className="text-[13px] tabular-nums text-[var(--v2-control-text-deemphasized)]">
                    {tabs.length}
                  </span>
                  {folder.collapsed ? (
                    <ChevronRight
                      className={cn(
                        V2_TRAILING_GLYPH,
                        'text-[var(--v2-control-text-deemphasized)]'
                      )}
                    />
                  ) : (
                    <ChevronDown
                      className={cn(
                        V2_TRAILING_GLYPH,
                        'text-[var(--v2-control-text-deemphasized)]'
                      )}
                    />
                  )}
                </>
              ))}
          </>
        )}
      </div>
      {stripRows(drawn, splitGroups).map((row) => (
        <StripRowItem
          key={rowKey(row)}
          row={row}
          activeTabId={activeTabId}
          compact={compact}
          indent={!horizontal}
          parent={key}
          slot={slot}
        />
      ))}
      {horizontal && (
        <span
          className="zen-strip-group-line"
          data-strip-group-line={folder.id}
          style={{ background: groupColorHex(folder.color) }}
          aria-hidden
        />
      )}
    </div>
  )
}

/**
 * What stands for a group in the tablet row's glyph slot (the favicon's 16 box): a 10 px dot of
 * its colour for an open group, a 2 px ring of it for a saved one – the Groups pane's two
 * states – or the folder's own icon where the desktop gave it one, as the phone card's
 * `GroupBadge` keeps it. `.zen-group-row-glyph` in main.css draws it.
 */
function GroupRowGlyph({ folder, saved }: { folder: Folder; saved: boolean }): JSX.Element {
  const own = folder.icon && folder.icon !== DEFAULT_FOLDER_ICON ? folder.icon : null
  return (
    <span
      className="zen-group-row-glyph"
      data-saved={saved || undefined}
      data-testid="group-row-glyph"
      style={{ '--zen-group-rgb': groupColorChannels(folder.color) } as CSSProperties}
      aria-hidden
    >
      {own ? (
        <span className="zen-group-row-icon">{own}</span>
      ) : (
        <span className="zen-group-row-dot" />
      )}
    </span>
  )
}

function FolderRename({ folder }: { folder: Folder }): JSX.Element {
  const [value, setValue] = useState(folder.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (save: boolean): void => {
    uiStore.set({ renamingFolderId: null })
    if (save && value.trim())
      run('folder.update', { folderId: folder.id, patch: { name: value.trim() } })
  }
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(true)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
        e.stopPropagation()
      }}
      className="min-w-0 flex-1 rounded-md bg-[var(--v2-control-fill)] px-1.5 py-0.5 outline-none ring-1 ring-[var(--v2-control-accent)]"
    />
  )
}

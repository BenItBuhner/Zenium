import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brush, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { dropStore, listMotions } from '@renderer/lib/drag'
import { openGroupEditor } from '@renderer/lib/groupEditor'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { pinnedOf, regularOf, stripRows, type StripRow } from '@renderer/lib/selectors'
import { hint, useHint } from '@renderer/lib/shortcuts'
import { stripFocusIn, stripFocusOut, stripKeyDown, useStripTabIndex } from '@renderer/lib/tabStrip'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { SpaceGlyph } from '../SpaceGlyph'
import { ListMotionContext } from './listMotion'
import { SplitGroupRow } from './SplitGroupRow'
import { TabItem } from './TabItem'

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
  const folders = Object.values(state.folders).filter((f) => f.spaceId === space.id)
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
                  tabs={regular.filter((t) => t.folderId === folder.id)}
                  activeTabId={activeTabId}
                  compact={compact}
                  dropKey={dropKey}
                  dragging={Boolean(drag)}
                  live={Boolean(state.liveFolders[folder.id])}
                  liveError={state.liveFolders[folder.id]?.lastError ?? null}
                  splitGroups={state.splitGroups}
                />
              ))}
              {stripRows(
                regular.filter((t) => !t.folderId || !state.folders[t.folderId]),
                state.splitGroups
              ).map((row) => (
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

/** A row's React key: the tab's id, or the split row's anchor (the slot it stands in). */
const rowKey = (row: StripRow): string => (row.kind === 'tab' ? row.tab.id : row.anchor.id)

/** One row of a tab list: a tab's own row, or a split group's row (§9.35). */
function StripRowItem({
  row,
  activeTabId,
  compact,
  indent,
  parent
}: {
  row: StripRow
  activeTabId: string | null
  compact: boolean
  indent?: boolean
  parent?: string
}): JSX.Element {
  if (row.kind === 'tab')
    return (
      <TabItem
        tab={row.tab}
        active={row.tab.id === activeTabId}
        compact={compact}
        indent={indent}
        parent={parent}
      />
    )
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
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
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
 * (lib/dnd.ts, `data-new-tab`), and the button shows it will (§9.4).
 */
function NewTabButton({
  compact,
  spaced,
  dropInto
}: {
  compact: boolean
  spaced: boolean
  dropInto: boolean
}): JSX.Element {
  const title = useHint('New Tab', 'tab.new')
  return (
    <button
      type="button"
      className={cn(
        'zen-tab text-[var(--zen-fg)]',
        compact && 'justify-center px-0',
        spaced && 'mt-0.5'
      )}
      data-new-tab
      data-drop-into={dropInto || undefined}
      title={title}
      onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
      onContextMenu={(e) => {
        e.preventDefault()
        run('newtab.contextMenu', contextMenuAnchor(e))
      }}
    >
      <Plus className="h-4 w-4 shrink-0" />
      {!compact && <span>New Tab</span>}
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
}

function FolderRow({
  folder,
  tabs,
  activeTabId,
  compact,
  dropKey,
  dragging,
  live,
  liveError,
  splitGroups
}: FolderRowProps): JSX.Element {
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const editing = uiStore.use((s) => s.groupEditor?.folderId === folder.id)
  const lastClick = useRef(0)
  const collapsedBeforeClick = useRef(folder.collapsed)
  const containsActive = tabs.some((t) => t.id === activeTabId)
  const isDropTarget = dropKey === `folder:${folder.id}`
  const toggle = (): void =>
    run('folder.update', { folderId: folder.id, patch: { collapsed: !folder.collapsed } })
  // The header is a tab group's (tabs-14): a press folds or unfolds it; the second press of a
  // double-click undoes the first's fold and opens the group editor bubble (tabs-13) instead, as
  // does the folder menu's Edit Folder…. It is a strip item (lib/tabStrip.ts) – Chrome's group
  // header: Enter, Space, Left and Right fold it, the arrows reach it from the rows (§9.22) – and
  // the strip's tab stop while it stands for the active tab (folded around it).
  const key = `folder:${folder.id}`
  const tabIndex = useStripTabIndex(key, containsActive && folder.collapsed)
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn('zen-tab', compact && 'justify-center px-0')}
        role="button"
        aria-label={folder.name}
        aria-description={`${live ? 'Live folder' : 'Folder'}, ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`}
        aria-expanded={!folder.collapsed}
        data-strip-item={key}
        tabIndex={tabIndex}
        data-active={containsActive && folder.collapsed}
        data-editing={editing || undefined}
        data-drop-into={isDropTarget || undefined}
        data-tab-folder={folder.id}
        onFocus={stripFocusIn}
        onBlur={stripFocusOut}
        onKeyDown={stripKeyDown}
        onClick={() => {
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
          e.preventDefault()
          run('folder.contextMenu', { folderId: folder.id, ...contextMenuAnchor(e) })
        }}
        title={compact ? folder.name : undefined}
      >
        {dragging && <div data-drop={`folder:${folder.id}`} className="absolute inset-0 z-10" />}
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
                <ChevronRight className="h-3.5 w-3.5 text-[var(--v2-control-text-deemphasized)]" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-[var(--v2-control-text-deemphasized)]" />
              )}
            </>
          ))}
      </div>
      {!folder.collapsed &&
        stripRows(tabs, splitGroups).map((row) => (
          <StripRowItem
            key={rowKey(row)}
            row={row}
            activeTabId={activeTabId}
            compact={compact}
            indent
            parent={key}
          />
        ))}
    </div>
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

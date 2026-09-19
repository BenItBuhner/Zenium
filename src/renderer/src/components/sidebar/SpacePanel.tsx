import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brush, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { dropStore, listMotions } from '@renderer/lib/drag'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { pinnedOf, regularOf } from '@renderer/lib/selectors'
import { useHint } from '@renderer/lib/shortcuts'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { SpaceGlyph } from '../SpaceGlyph'
import { ListMotionContext } from './listMotion'
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

  return (
    <ListMotionContext.Provider value={motion}>
      <div className="flex h-full w-full shrink-0 flex-col" aria-hidden={!isActive}>
        <div
          ref={scroller}
          data-tab-scroller
          data-active={isActive}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-1"
          onDoubleClick={(e) => {
            // Zen: double-clicking empty sidebar space opens a new tab.
            if (e.target === e.currentTarget) window.dispatchEvent(new CustomEvent('zen-new-tab'))
          }}
        >
          {pinned.length > 0 && (
            <>
              <SpaceHeader space={space} compact={compact} />
              {!space.pinnedCollapsed && (
                <div className="relative flex flex-col gap-0.5" data-tab-list="pinned">
                  {pinned.map((tab) => (
                    <TabItem
                      key={tab.id}
                      tab={tab}
                      active={tab.id === activeTabId}
                      compact={compact}
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
                <button
                  type="button"
                  className="zen-toolbar-button h-5 w-5 opacity-0 group-hover/sep:opacity-70"
                  title="Clear unpinned tabs"
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
              />
            ))}
            {regular
              .filter((t) => !t.folderId || !state.folders[t.folderId])
              .map((tab) => (
                <TabItem key={tab.id} tab={tab} active={tab.id === activeTabId} compact={compact} />
              ))}
            <NewTabButton compact={compact} dropInto={dropKey === `newtab:${space.id}`} />
          </div>
          <div
            className="relative min-h-6 flex-1"
            onDoubleClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
          >
            {drag && <DropZone dropKey={`section:regular:${space.id}`} activeKey={dropKey} tall />}
          </div>
        </div>
      </div>
    </ListMotionContext.Provider>
  )
}

function SpaceHeader({ space, compact }: { space: Space; compact: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="mb-1 flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[12px] font-medium text-[var(--zen-muted)] hover:bg-[var(--zen-element-bg)]"
      title={space.pinnedCollapsed ? 'Show pinned tabs' : 'Collapse pinned tabs'}
      onClick={() => run('space.togglePinnedCollapsed', { spaceId: space.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        run('space.contextMenu', { spaceId: space.id })
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
 * The list's new-tab button. An address dragged from outside opens in a new tab at the end of
 * the list when dropped on it (lib/dnd.ts, `data-new-tab`), and the button shows it will (§9.4).
 */
function NewTabButton({ compact, dropInto }: { compact: boolean; dropInto: boolean }): JSX.Element {
  const title = useHint('New Tab', 'tab.new')
  return (
    <button
      type="button"
      className={cn(
        'zen-tab h-8 text-[var(--zen-muted)] hover:text-[var(--zen-fg)]',
        compact && 'justify-center px-0'
      )}
      data-new-tab
      data-drop-into={dropInto || undefined}
      title={title}
      onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
      onContextMenu={(e) => {
        e.preventDefault()
        run('newtab.contextMenu', undefined)
      }}
    >
      <Plus className="h-4 w-4 shrink-0" />
      {!compact && <span className="text-[13px]">New Tab</span>}
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
}

function FolderRow({
  folder,
  tabs,
  activeTabId,
  compact,
  dropKey,
  dragging,
  live,
  liveError
}: FolderRowProps): JSX.Element {
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const lastClick = useRef(0)
  const containsActive = tabs.some((t) => t.id === activeTabId)
  const isDropTarget = dropKey === `folder:${folder.id}`
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn('zen-tab h-8', compact && 'justify-center px-0')}
        data-active={containsActive && folder.collapsed}
        data-drop-into={isDropTarget || undefined}
        data-tab-folder={folder.id}
        onClick={() => {
          const now = performance.now()
          if (now - lastClick.current < 400) {
            lastClick.current = 0
            uiStore.set({ renamingFolderId: folder.id })
            return
          }
          lastClick.current = now
          run('folder.update', { folderId: folder.id, patch: { collapsed: !folder.collapsed } })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          run('folder.contextMenu', { folderId: folder.id })
        }}
        title={compact ? folder.name : undefined}
      >
        {dragging && <div data-drop={`folder:${folder.id}`} className="absolute inset-0 z-10" />}
        <span className="text-sm leading-none">{folder.icon}</span>
        {folder.color && !compact && (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
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
                    liveError ? 'bg-red-500' : 'zen-live-dot bg-[var(--zen-accent)]'
                  )}
                  title={liveError ?? 'Live folder – updates automatically'}
                />
              )}
              <span className="text-[11px] text-[var(--zen-muted)]">{tabs.length}</span>
              {folder.collapsed ? (
                <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              )}
            </>
          ))}
      </div>
      {!folder.collapsed &&
        tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            compact={compact}
            indent
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
      className="min-w-0 flex-1 rounded-md bg-[var(--zen-element-bg)] px-1.5 py-0.5 text-[13px] outline-none ring-1 ring-[var(--zen-accent)]"
    />
  )
}

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Brush, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { dropStore } from '@renderer/lib/drag'
import { pinnedOf, regularOf } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { TabItem } from './TabItem'

interface Props {
  state: UIState
  space: Space
  isActive: boolean
  compact: boolean
}

/** One space's tab list: space header, pinned tabs, separator, folders + regular tabs, new tab. */
export function SpacePanel({ state, space, isActive, compact }: Props): JSX.Element {
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  const folders = Object.values(state.folders).filter((f) => f.spaceId === space.id)
  const activeTabId = space.activeTabId
  const showSeparator = state.settings.showTabSeparator && (pinned.length > 0 || regular.length > 0)

  return (
    <div className="flex h-full w-full shrink-0 flex-col" aria-hidden={!isActive}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-1">
        {(pinned.length > 0 || Boolean(drag)) && (
          <>
            <SpaceHeader space={space} compact={compact} />
            {!space.pinnedCollapsed && (
              <div className="relative flex flex-col gap-0.5">
                {pinned.map((tab) => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    compact={compact}
                  />
                ))}
                {drag && (
                  <DropZone
                    dropKey={`section:pinned:${space.id}`}
                    activeKey={dropKey}
                    label="Pin here"
                  />
                )}
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
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {folders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              tabs={regular.filter((t) => t.folderId === folder.id)}
              activeTabId={activeTabId}
              compact={compact}
              dropKey={dropKey}
              dragging={Boolean(drag)}
            />
          ))}
          {regular
            .filter((t) => !t.folderId || !state.folders[t.folderId])
            .map((tab) => (
              <TabItem key={tab.id} tab={tab} active={tab.id === activeTabId} compact={compact} />
            ))}
          <NewTabButton compact={compact} />
        </div>
        <div className="relative min-h-6 flex-1">
          {drag && <DropZone dropKey={`section:regular:${space.id}`} activeKey={dropKey} tall />}
        </div>
      </div>
    </div>
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
      <span className="text-sm leading-none">{space.icon || '◦'}</span>
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

function DropZone({
  dropKey,
  activeKey,
  label,
  tall
}: {
  dropKey: string
  activeKey: string | null
  label?: string
  tall?: boolean
}): JSX.Element {
  const active = activeKey === dropKey
  return (
    <div
      data-drop={dropKey}
      className={cn(
        'relative flex items-center justify-center rounded-lg text-[11px] text-[var(--zen-muted)] transition-colors',
        tall ? 'absolute inset-0' : 'h-6',
        active && 'bg-[var(--zen-accent)]/15 ring-1 ring-[var(--zen-accent)]/50'
      )}
    >
      {label && active ? label : null}
    </div>
  )
}

function NewTabButton({ compact }: { compact: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'zen-tab h-8 text-[var(--zen-muted)] hover:text-[var(--zen-fg)]',
        compact && 'justify-center px-0'
      )}
      title="New Tab (Ctrl+T)"
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
}

function FolderRow({
  folder,
  tabs,
  activeTabId,
  compact,
  dropKey,
  dragging
}: FolderRowProps): JSX.Element {
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const lastClick = useRef(0)
  const containsActive = tabs.some((t) => t.id === activeTabId)
  const isDropTarget = dropKey === `folder:${folder.id}`
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn(
          'zen-tab h-8',
          isDropTarget && 'ring-2 ring-[var(--zen-accent)]/60',
          compact && 'justify-center px-0'
        )}
        data-active={containsActive && folder.collapsed}
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
        {!compact &&
          (renaming ? (
            <FolderRename folder={folder} />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-[13px]">{folder.name}</span>
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

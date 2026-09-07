import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MonitorSmartphone, RotateCcw, Volume2, VolumeX, X } from 'lucide-react'
import type { Tab } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS } from '@shared/defaults'
import { run } from '@renderer/lib/api'
import { dropStore, startTabDrag } from '@renderer/lib/drag'
import { activeTab, containerOf, tabTitle } from '@renderer/lib/selectors'
import {
  browserStore,
  clearTabSelection,
  selectTabRange,
  toggleTabSelection,
  uiStore
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from './Favicon'

interface Props {
  tab: Tab
  active: boolean
  compact: boolean
  indent?: boolean
}

export function TabItem({ tab, active, compact, indent }: Props): JSX.Element {
  const dragging = uiStore.use((s) => s.drag)
  const renaming = uiStore.use((s) => s.renamingTabId === tab.id)
  const dropKey = dropStore.use((s) => s.key)
  const foreign = browserStore.use((s) => s.state?.foreignTabIds.includes(tab.id) ?? false)
  const containerColor = browserStore.use((s) => {
    if (
      !s.state ||
      tab.containerId === DEFAULT_CONTAINER_ID ||
      tab.containerId === PRIVATE_CONTAINER_ID
    )
      return null
    const c = containerOf(s.state, tab.containerId)
    return c ? CONTAINER_COLORS[c.color] : null
  })
  const selected = uiStore.use((s) => s.selectedTabIds.includes(tab.id))
  const isDragSource = dragging?.tabId === tab.id
  const showDropZones = Boolean(dragging) && !isDragSource
  const title = tabTitle(tab)
  const pinnedChanged = tab.pinned && tab.pinnedUrl !== null && tab.url !== tab.pinnedUrl

  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    if (e.button === 1) {
      e.preventDefault()
      return
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    startTabDrag(tab, e)
  }

  // Activating a tab moves keyboard focus into the page, which resets Chromium's click counter,
  // so a native `dblclick` never fires here. Detect the second click ourselves instead.
  const lastClick = useRef(0)
  const onClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    if (dragging) return
    if (e.altKey) {
      // Zen 1.19: Alt+click splits the tab with the active one (again: separates it).
      e.preventDefault()
      run('tab.altClick', { tabId: tab.id })
      return
    }
    const current = browserStore.get().state
    const activeId = current ? (activeTab(current)?.id ?? null) : null
    if (e.ctrlKey || e.metaKey) {
      // Zen: Ctrl+click builds a multi-selection to split / move / close tabs together.
      e.preventDefault()
      toggleTabSelection(tab.id, activeId)
      return
    }
    if (e.shiftKey) {
      e.preventDefault()
      selectTabRange(tab.id, activeId)
      return
    }
    clearTabSelection()
    uiStore.set({ selectionAnchorId: tab.id })
    const now = performance.now()
    if (now - lastClick.current < 400 && !compact) {
      lastClick.current = 0
      uiStore.set({ renamingTabId: tab.id })
      return
    }
    lastClick.current = now
    run('tab.activate', { tabId: tab.id })
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const ids = uiStore.get().selectedTabIds
    if (ids.length > 1 && ids.includes(tab.id)) {
      run('tab.selectionContextMenu', { tabIds: ids })
      return
    }
    clearTabSelection()
    run('tab.contextMenu', { tabId: tab.id })
  }

  const onAuxClick = (e: React.MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault()
      run('tab.close', { tabId: tab.id })
    }
  }

  return (
    <div
      className={cn(
        'zen-tab group',
        compact && 'justify-center px-0',
        indent && 'ml-5',
        isDragSource && 'opacity-40'
      )}
      data-active={active}
      data-selected={selected || undefined}
      data-discarded={tab.discarded}
      data-tab-id={tab.id}
      title={compact ? title : undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
    >
      {showDropZones && (
        <>
          <div data-drop={`tab:${tab.id}:before`} className="absolute inset-x-0 top-0 h-1/2 z-10" />
          <div
            data-drop={`tab:${tab.id}:after`}
            className="absolute inset-x-0 bottom-0 h-1/2 z-10"
          />
        </>
      )}
      {dropKey === `tab:${tab.id}:before` && <DropLine position="top" />}
      {dropKey === `tab:${tab.id}:after` && <DropLine position="bottom" />}
      {containerColor && (
        <span
          className="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full"
          style={{ background: containerColor }}
          aria-hidden
        />
      )}
      {tab.loading && !tab.discarded && <span className="zen-tab-progress" aria-hidden />}
      <Favicon tab={tab} />
      {!compact && (
        <>
          {renaming ? (
            <RenameInput tab={tab} />
          ) : (
            <span className="zen-tab-title min-w-0 flex-1 truncate">{title}</span>
          )}
          {foreign && active && (
            <MonitorSmartphone
              className="h-3.5 w-3.5 shrink-0 opacity-60"
              aria-label="Shown in another window"
            />
          )}
          {(tab.audible || tab.muted) && (
            <button
              type="button"
              className="zen-toolbar-button h-6 w-6 shrink-0"
              title={tab.muted ? 'Unmute tab' : 'Mute tab'}
              onClick={() => run('tab.toggleMute', { tabId: tab.id })}
            >
              {tab.muted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {pinnedChanged ? (
            <button
              type="button"
              className="zen-toolbar-button h-6 w-6 shrink-0"
              title="Reset pinned tab to its original URL"
              onClick={(e) => {
                e.stopPropagation()
                run('tab.resetPinned', { tabId: tab.id })
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              className="zen-tab-close zen-toolbar-button h-6 w-6 shrink-0"
              title={tab.pinned ? 'Close (keep pinned)' : 'Close tab'}
              onClick={(e) => {
                e.stopPropagation()
                run('tab.close', { tabId: tab.id })
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  )
}

function DropLine({ position }: { position: 'top' | 'bottom' }): JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-[var(--zen-accent)]',
        position === 'top' ? '-top-px' : '-bottom-px'
      )}
    />
  )
}

function RenameInput({ tab }: { tab: Tab }): JSX.Element {
  const [value, setValue] = useState(tabTitle(tab))
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (save: boolean): void => {
    uiStore.set({ renamingTabId: null })
    if (!save) return
    const trimmed = value.trim()
    run('tab.rename', { tabId: tab.id, title: trimmed && trimmed !== tab.title ? trimmed : null })
  }
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
        e.stopPropagation()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="zen-no-drag zen-squircle min-w-0 flex-1 rounded-md bg-[var(--zen-element-bg)] px-1.5 py-0.5 text-[13px] outline-none ring-1 ring-[var(--zen-accent)]"
    />
  )
}

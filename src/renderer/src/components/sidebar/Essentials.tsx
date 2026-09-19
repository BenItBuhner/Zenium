import type { JSX } from 'react'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { dropStore, startTabDrag } from '@renderer/lib/drag'
import { activeTab, tabTitle, tabTooltip } from '@renderer/lib/selectors'
import { stripFocusIn, stripFocusOut, stripKeyDown, useStripTabIndex } from '@renderer/lib/tabStrip'
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
  essentials: Tab[]
  activeTabId: string | null
  compact: boolean
}

/** Zen's Essentials: a grid of favicon tiles pinned to the very top of the sidebar. */
export function Essentials({ essentials, activeTabId, compact }: Props): JSX.Element | null {
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const zones = dropStore.use((s) => s.zones)
  const dragged = drag ? essentials.find((t) => t.id === drag.tabId) : undefined
  const showZone = Boolean(drag) && !dragged

  // With no tiles the grid has no room of its own: its "Drop here" mounts once the pointer has
  // gone above the tab panel (lib/drag.ts `zones`), never under a pointer that is over the rows.
  if (essentials.length === 0 && !(showZone && zones)) return null

  return (
    // `data-essentials`: the grid an address dropped from outside lands in (lib/dnd.ts).
    <div
      className="relative mx-2 mb-1 rounded-xl p-1"
      data-essentials
      data-drop-into={dropKey === 'section:essential:' || undefined}
    >
      {showZone && (
        <div data-drop="section:essential:" className="absolute inset-0 z-10 rounded-xl" />
      )}
      {/* The tiles are tabs too (a11y-07, a11y-31): their own tablist ahead of the space's, walked
          with the arrows as part of the strip (lib/tabStrip.ts) – Left and Right along a line. */}
      <div
        className={cn(
          'grid gap-1.5',
          compact ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(52px,1fr))]'
        )}
        role={essentials.length > 0 ? 'tablist' : undefined}
        aria-label={essentials.length > 0 ? 'Essentials' : undefined}
      >
        {essentials.map((tab) => (
          <EssentialTile
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            lifted={drag?.tabId === tab.id}
            showDropZones={Boolean(drag) && drag?.tabId !== tab.id}
            dropKey={dropKey}
          />
        ))}
        {essentials.length === 0 && showZone && (
          <div className="col-span-full rounded-lg border border-dashed border-[var(--zen-border)] py-3 text-center text-xs text-[var(--zen-muted)]">
            Drop here to add to Essentials
          </div>
        )}
      </div>
    </div>
  )
}

function EssentialTile({
  tab,
  active,
  lifted,
  showDropZones,
  dropKey
}: {
  tab: Tab
  active: boolean
  /** The tile is in the hand: its slot stays open under the ghost. */
  lifted: boolean
  showDropZones: boolean
  dropKey: string | null
}): JSX.Element {
  const selected = uiStore.use((s) => s.selectedTabIds.includes(tab.id))
  const tabIndex = useStripTabIndex(`tile:${tab.id}`, active)
  return (
    <div
      className="zen-essential relative"
      role="tab"
      aria-selected={active}
      aria-label={tabTitle(tab)}
      data-active={active}
      data-selected={selected || undefined}
      data-discarded={tab.discarded}
      data-tab-id={tab.id}
      data-strip-item={`tile:${tab.id}`}
      tabIndex={tabIndex}
      data-frozen={tab.frozen}
      data-lifted={lifted || undefined}
      data-drop-into={dropKey === `tab:${tab.id}:into` || undefined}
      title={tabTooltip(tab)}
      onFocus={stripFocusIn}
      onBlur={stripFocusOut}
      onKeyDown={stripKeyDown}
      onPointerDown={(e) => {
        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
          startTabDrag(tab, e)
      }}
      onClick={(e) => {
        if (uiStore.get().drag) return
        const current = browserStore.get().state
        const activeId = current ? (activeTab(current)?.id ?? null) : null
        if (e.ctrlKey || e.metaKey) return toggleTabSelection(tab.id, activeId)
        if (e.shiftKey) return selectTabRange(tab.id, activeId)
        if (e.altKey) return run('tab.altClick', { tabId: tab.id })
        clearTabSelection()
        uiStore.set({ selectionAnchorId: tab.id })
        run('tab.activate', { tabId: tab.id })
      }}
      onAuxClick={(e) => {
        if (e.button === 1) run('tab.close', { tabId: tab.id })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        const ids = uiStore.get().selectedTabIds
        if (ids.length > 1 && ids.includes(tab.id))
          return run('tab.selectionContextMenu', { tabIds: ids })
        clearTabSelection()
        run('tab.contextMenu', { tabId: tab.id })
      }}
    >
      {showDropZones && (
        <>
          <div
            data-drop={`tab:${tab.id}:before`}
            className="absolute inset-y-0 left-0 w-1/2 z-10"
          />
          <div
            data-drop={`tab:${tab.id}:after`}
            className="absolute inset-y-0 right-0 w-1/2 z-10"
          />
        </>
      )}
      {dropKey === `tab:${tab.id}:before` && (
        <span className="zen-tab-caret-grid -left-1" aria-hidden />
      )}
      {dropKey === `tab:${tab.id}:after` && (
        <span className="zen-tab-caret-grid -right-1" aria-hidden />
      )}
      <Favicon tab={tab} size={20} />
      {tab.audible && !tab.muted && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--zen-accent)]" />
      )}
      {tab.frozen && (
        <span className="zen-frozen-dot absolute bottom-1 right-1 h-2 w-2 rounded-full" />
      )}
    </div>
  )
}

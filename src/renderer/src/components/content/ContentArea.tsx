import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MonitorSmartphone, Plus } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { activeTab, isForeignTab } from '@renderer/lib/selectors'
import { captureActiveTab, uiStore, type UiState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { dropStore } from '@renderer/lib/drag'
import { Urlbar } from '../urlbar/Urlbar'
import { OverlayHost } from '../overlays/OverlayHost'
import { FindBar } from './FindBar'
import { GlanceFrame } from './GlanceFrame'
import { SplitChrome } from './SplitChrome'
import { useLayoutReporter } from './useLayoutReporter'

interface Props {
  state: UIState
  ui: UiState
}

/**
 * The area where tab views live. Everything rendered here is chrome that shows *around* or
 * *instead of* the web content (split gutters, glance frame, URL bar, panels, empty state).
 */
export function ContentArea({ state, ui }: Props): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const tab = activeTab(state)
  const group = tab?.splitGroupId ? (state.splitGroups[tab.splitGroupId] ?? null) : null
  const glanceActive = ui.glanceActive
  const glanceTabId = state.glance?.tabId ?? null
  const glanceParentId = state.glance?.parentTabId ?? null

  // Glance: freeze the parent behind a snapshot, animate the card in, then show the view.
  useEffect(() => {
    if (!glanceTabId) {
      uiStore.set({ glanceActive: false, glanceReady: false })
      return
    }
    let cancelled = false
    void captureActiveTab(glanceParentId).then(() => {
      if (cancelled) return
      uiStore.set({ glanceActive: true })
      setTimeout(() => {
        if (!cancelled) uiStore.set({ glanceReady: true })
      }, 210)
    })
    return () => {
      cancelled = true
    }
  }, [glanceTabId, glanceParentId])

  const { area, contentHidden } = useLayoutReporter(viewportRef, state, ui, glanceActive)
  const local: Rect | null = area ? { x: 0, y: 0, width: area.width, height: area.height } : null
  const showSnapshot = (contentHidden || glanceActive) && Boolean(tab)
  const dropKey = dropStore.use((s) => s.key)
  const foreign = isForeignTab(state, tab?.id)

  return (
    <div className="zen-content-frame relative flex h-full min-h-0 flex-col overflow-hidden">
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!tab && !ui.urlbar.open && ui.overlay === 'none' && <EmptyState />}
        {tab && foreign && !contentHidden && !glanceActive && <ForeignTabPreview tabId={tab.id} />}
        {showSnapshot && (
          <div className="absolute inset-0">
            {ui.snapshot && ui.snapshotTabId === (glanceActive ? glanceParentId : tab?.id) ? (
              <img
                src={ui.snapshot}
                alt=""
                className="h-full w-full object-cover object-top"
                draggable={false}
              />
            ) : null}
            <div
              className={cn(
                'absolute inset-0 bg-black/35 transition-opacity',
                ui.drag && 'bg-black/20'
              )}
            />
          </div>
        )}
        {group && local && !contentHidden && !glanceActive && (
          <SplitChrome state={state} group={group} area={local} activeTabId={tab?.id ?? null} />
        )}
        {ui.drag && local && tab && <SplitDropZones dropKey={dropKey} />}
        {glanceActive && state.glance && local && (
          <GlanceFrame state={state} glance={state.glance} area={local} ready={ui.glanceReady} />
        )}
        {ui.urlbar.open && local && (
          <Urlbar
            key={`${ui.urlbar.mode}-${ui.urlbar.tabId ?? 'new'}`}
            state={state}
            urlbar={ui.urlbar}
            area={local}
          />
        )}
        {ui.overlay !== 'none' && <OverlayHost state={state} ui={ui} />}
      </div>
      {ui.findOpen && ui.findTabId && state.tabs[ui.findTabId] && (
        <FindBar state={state} tabId={ui.findTabId} />
      )}
    </div>
  )
}

/**
 * Zen window sync: a tab selected in two windows keeps a single live page. The window that does
 * not hold it shows a dimmed preview; focusing (or clicking) brings the page over.
 */
function ForeignTabPreview({ tabId }: { tabId: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const capture = (): void => {
      void cmd('overlay.snapshot', { tabId })
        .then((data) => {
          if (!cancelled && data) setSnapshot(data)
        })
        .catch(() => undefined)
    }
    capture()
    const timer = setInterval(capture, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [tabId])
  return (
    <div
      className="absolute inset-0 z-10 cursor-pointer"
      onClick={() => run('tab.activate', { tabId })}
      title="Click to show this tab here"
    >
      {snapshot && (
        <img
          src={snapshot}
          alt=""
          className="h-full w-full object-cover object-top"
          draggable={false}
        />
      )}
      <div className="absolute inset-0 bg-black/40" />
      <div className="zen-panel zen-animate-in absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 px-4 py-2.5 text-[13px]">
        <MonitorSmartphone className="h-4 w-4 opacity-70" />
        <span>Open in another window</span>
        <span className="text-[var(--zen-muted)]">· click to bring it here</span>
      </div>
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[var(--zen-muted)]">
      <div className="text-lg font-medium text-[var(--zen-fg)]">This space is empty</div>
      <p className="text-[13px]">Open a new tab to start browsing.</p>
      <button
        type="button"
        className="mt-2 inline-flex h-9 items-center gap-2 rounded-full bg-[var(--zen-element-bg)] px-4 text-[13px] text-[var(--zen-fg)] hover:bg-[var(--zen-element-bg-hover)]"
        onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
      >
        <Plus className="h-4 w-4" /> New Tab
        <kbd className="zen-kbd zen-kbd-hint ml-1">Ctrl T</kbd>
      </button>
    </div>
  )
}

/** Zen: drop a dragged tab on the edge of the content area to split it with the active tab. */
function SplitDropZones({ dropKey }: { dropKey: string | null }): JSX.Element {
  const zone = (key: string, className: string, label: string): JSX.Element => (
    <div
      data-drop={`split:${key}`}
      className={cn(
        'absolute flex items-center justify-center rounded-xl border-2 border-dashed border-white/30 text-[13px] font-medium text-white/80 transition-colors',
        className,
        dropKey === `split:${key}` && 'border-white bg-white/20'
      )}
    >
      {label}
    </div>
  )
  return (
    <div className="absolute inset-0 z-20 p-4">
      <div className="relative h-full w-full">
        {zone('left', 'left-0 top-[20%] bottom-[20%] w-[22%]', 'Split left')}
        {zone('right', 'right-0 top-[20%] bottom-[20%] w-[22%]', 'Split right')}
        {zone('top', 'top-0 left-[26%] right-[26%] h-[18%]', 'Split top')}
        {zone('bottom', 'bottom-0 left-[26%] right-[26%] h-[18%]', 'Split bottom')}
      </div>
    </div>
  )
}

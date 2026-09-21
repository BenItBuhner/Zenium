import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  MonitorSmartphone,
  Moon,
  PictureInPicture2,
  RotateCcw,
  ScreenShare,
  Snowflake,
  Turtle,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { AgentInfo, Tab } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS } from '@shared/defaults'
import { tabAlertTooltip, type TabAlert } from '@shared/captureState'
import { run } from '@renderer/lib/api'
import { dropStore, startTabDrag } from '@renderer/lib/drag'
import { viewportStore } from '@renderer/lib/formFactor'
import { hoverCard, measureRow } from '@renderer/lib/hoverCard'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { activeTab, containerOf, tabTitle, tabTooltip } from '@renderer/lib/selectors'
import {
  browserStore,
  clearTabSelection,
  selectTabRange,
  toggleTabSelection,
  uiStore
} from '@renderer/lib/ui'
import { stripFocusIn, stripFocusOut, stripKeyDown, useStripTabIndex } from '@renderer/lib/tabStrip'
import { cn } from '@renderer/lib/utils'
import { useTabTouch } from '../tablet/useTabTouch'
import { Favicon } from './Favicon'
import { useListMotion } from './listMotion'

interface Props {
  tab: Tab
  active: boolean
  compact: boolean
  indent?: boolean
  /** The strip header that folds this row away (`folder:<id>`, `header:<spaceId>`), if any. */
  parent?: string
  /**
   * A pane of a split group's row (`SplitGroupRow`, design language v2 §9.35): the row's segment
   * `index` of `count`. The segment keeps the row's favicon, title, close and the state the user
   * cannot otherwise see (audio, an alert) and drops the rest of the trailing slot; the group's
   * row is the list's slot (its motion and its hover fill), not the segment.
   */
  segment?: { index: number; count: number }
}

export function TabItem({ tab, active, compact, indent, parent, segment }: Props): JSX.Element {
  const dragging = uiStore.use((s) => s.drag)
  const renaming = uiStore.use((s) => s.renamingTabId === tab.id)
  const tabIndex = useStripTabIndex(`tab:${tab.id}`, active)
  const motion = useListMotion()
  const inSegment = Boolean(segment)
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      // The list's slot is the split row's, attached by `SplitGroupRow`; a segment is not one.
      const slot = inSegment ? null : motion
      slot?.attach(tab.id, el)
      return () => slot?.attach(tab.id, null)
    },
    [motion, tab.id, inSegment]
  )
  const foreign = browserStore.use((s) => s.state?.foreignTabIds.includes(tab.id) ?? false)
  const agent = browserStore.use(
    (s) => s.state?.agents.find((a) => a.tabIds.includes(tab.id)) ?? null
  )
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
  // An address dragged over the row (lib/dnd.ts): the row takes it, and shows so (§9.4).
  const dropInto = dropStore.use((s) => s.key === `tab:${tab.id}:into`)
  const isDragSource = dragging?.tabId === tab.id
  const showDropZones = Boolean(dragging) && !isDragSource
  const title = tabTitle(tab)
  const pinnedChanged = tab.pinned && tab.pinnedUrl !== null && tab.url !== tab.pinnedUrl
  // The indicator slot shows one state, Chrome's priority: recording > capturing > PiP > audio.
  const alert = !tab.discarded ? (tab.alert ?? null) : null

  // On the tablet a finger's hold lifts the row (TABLET-02: the menu on release, the reorder on
  // a move) and takes the browser's long-press menu; elsewhere the hook does nothing.
  const tabletTouch = viewportStore.use((v) => v.formFactor === 'tablet')
  const touch = useTabTouch(tab, tabletTouch)

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (touch.onPointerDown(e)) return
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
    if (touch.swallowsClick()) return
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

  const onContextMenu = (e: React.MouseEvent<HTMLElement>): void => {
    if (touch.onContextMenu(e)) return
    e.preventDefault()
    // At the pointer, or – Shift+F10, the Menu key on the focused row – at the row, in
    // keyboard mode (lib/menuKeys.ts).
    const anchor = contextMenuAnchor(e)
    const ids = uiStore.get().selectedTabIds
    if (ids.length > 1 && ids.includes(tab.id)) {
      run('tab.selectionContextMenu', { tabIds: ids, ...anchor })
      return
    }
    clearTabSelection()
    run('tab.contextMenu', { tabId: tab.id, ...anchor })
  }

  const onAuxClick = (e: React.MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault()
      run('tab.close', { tabId: tab.id })
    }
  }

  // The hover card (lib/hoverCard.ts) replaces the row's native tooltip: it shows after the
  // pointer rests on the row, or at once when keyboard focus lands on it (§9.22), never for the
  // focus a click leaves behind; the controller holds it back while a popover, a menu, a dialog
  // or an overlay has the chrome. The row's buttons keep their own tooltips.
  const cardUp = uiStore.use((s) => s.hoverCard.tabId === tab.id)
  const onPointerEnter = (e: React.PointerEvent): void => {
    if (e.pointerType !== 'mouse' || renaming || dragging) return
    const el = e.currentTarget as HTMLElement
    hoverCard.pointerEnter(tab.id, () => measureRow(el))
  }
  const onPointerLeave = (): void => hoverCard.pointerLeave(tab.id)
  const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
    stripFocusIn(e)
    const el = e.currentTarget
    if (e.target !== el || !el.matches(':focus-visible')) return
    hoverCard.focus(tab.id, () => measureRow(el))
  }
  const onBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    stripFocusOut(e)
    if (e.target === e.currentTarget) hoverCard.blur(tab.id)
  }

  // Keyboard reach (§9.22, a11y-07): the strip is one tab stop; arrows, Home/End, Enter/Space,
  // Delete and Escape are the strip's (lib/tabStrip.ts). The row's own buttons stay out of the
  // tab order: Delete closes, the row's context menu has the rest.
  // In a split row a segment keeps what names the tab and what it must show – the favicon, the
  // title, the close, a live audio or alert state – and not the trailing slot's other buttons,
  // whose room a segment does not have (§9.35); their states stay in the row's fade, its tooltip
  // and its context menu.
  const trailing = !segment
  return (
    <div
      ref={attach}
      className={cn(
        'zen-tab group',
        segment && 'zen-split-seg',
        compact && 'justify-center px-0',
        indent && 'ml-5'
      )}
      role="tab"
      aria-selected={active}
      aria-label={title}
      aria-description={
        segment ? `Split view, pane ${segment.index + 1} of ${segment.count}` : undefined
      }
      data-active={active}
      data-selected={selected || undefined}
      data-discarded={tab.discarded}
      data-frozen={tab.frozen}
      data-agent={agent ? true : undefined}
      data-lifted={isDragSource || undefined}
      data-drop-into={dropInto || undefined}
      data-tab-id={tab.id}
      data-strip-item={`tab:${tab.id}`}
      data-strip-parent={parent}
      tabIndex={tabIndex}
      aria-describedby={cardUp ? 'zen-tab-hover-card' : undefined}
      data-testid="tab"
      style={agent ? { boxShadow: `inset 0 0 0 1.5px ${agent.color}80` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={touch.onPointerMove}
      onPointerUp={touch.onPointerUp}
      onPointerCancel={touch.onPointerCancel}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={stripKeyDown}
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
      {containerColor && (
        <span
          className="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full"
          style={{ background: containerColor }}
          aria-hidden
        />
      )}
      {tab.loading && !tab.discarded && <span className="zen-tab-progress" aria-hidden />}
      {agent && compact && (
        <span
          className="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-1 ring-white/70"
          style={{ background: agent.color }}
          aria-hidden
        />
      )}
      {compact && alert && (
        <span
          className="zen-tab-audio-dot zen-tab-alert-dot"
          data-alert={alert}
          role="img"
          aria-label={tabAlertTooltip(alert)}
        />
      )}
      {compact && !alert && (tab.audible || tab.muted) && (
        <span
          className="zen-tab-audio-dot"
          data-muted={tab.muted || undefined}
          aria-label={tab.muted ? 'Muted' : 'Playing audio'}
        />
      )}
      <Favicon tab={tab} />
      {!compact && (
        <>
          {renaming ? (
            <RenameInput tab={tab} />
          ) : (
            <span className="zen-tab-title min-w-0 flex-1 truncate" data-testid="tab-title">
              {title}
            </span>
          )}
          {trailing && agent && !renaming && <AgentBadge agent={agent} tabId={tab.id} />}
          {trailing && foreign && active && (
            <MonitorSmartphone
              className="h-3.5 w-3.5 shrink-0 text-[var(--v2-control-text-deemphasized)]"
              aria-label="Shown in another window"
            />
          )}
          {trailing && tab.discarded && !renaming && (
            <button
              type="button"
              tabIndex={-1}
              className="zen-toolbar-button zen-tab-sleeping h-6 w-6 shrink-0"
              title={tabTooltip(tab)}
              aria-label="Sleeping – click to wake"
              onClick={(e) => {
                e.stopPropagation()
                run('tab.activate', { tabId: tab.id })
              }}
            >
              <Moon className="h-3.5 w-3.5" />
            </button>
          )}
          {trailing && tab.frozen && !renaming && (
            <button
              type="button"
              tabIndex={-1}
              className="zen-toolbar-button h-6 w-6 shrink-0 text-[var(--v2-control-text-deemphasized)]"
              title="Frozen by the resource governor – click to wake"
              onClick={(e) => {
                e.stopPropagation()
                run('tab.wake', { tabId: tab.id })
              }}
            >
              <Snowflake className="h-3.5 w-3.5" />
            </button>
          )}
          {trailing && !tab.frozen && tab.cpuThrottle > 1 && !renaming && (
            <button
              type="button"
              tabIndex={-1}
              className="zen-toolbar-button h-6 w-6 shrink-0 text-[var(--v2-control-text-deemphasized)]"
              title={`CPU throttled ×${tab.cpuThrottle} by the resource governor – click to lift`}
              onClick={(e) => {
                e.stopPropagation()
                run('tab.wake', { tabId: tab.id })
              }}
            >
              <Turtle className="h-3.5 w-3.5" />
            </button>
          )}
          {alert && !renaming && <AlertIndicator alert={alert} />}
          {!alert && (tab.audible || tab.muted) && !renaming && (
            <button
              type="button"
              tabIndex={-1}
              className="zen-toolbar-button zen-tab-audio h-6 w-6 shrink-0"
              data-muted={tab.muted || undefined}
              title={tab.muted ? 'Unmute tab' : 'Mute tab'}
              aria-pressed={tab.muted}
              onClick={(e) => {
                e.stopPropagation()
                run('tab.toggleMute', { tabId: tab.id })
              }}
            >
              {tab.muted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {trailing && pinnedChanged ? (
            <button
              type="button"
              tabIndex={-1}
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
              tabIndex={-1}
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

/**
 * The tab's alert indicator (tabs-43), in the slot the audio indicator takes otherwise: Chrome's
 * red dot for a camera or microphone in use, the sharing glyph for a screen, window or tab being
 * shared (Chrome draws its desktop capture in the same red), the picture-in-picture glyph in the
 * row's ink. Not a control – the tooltip says what it is – so it sits in the 24 px slot without
 * the button's hover fill; the context menu keeps Mute Site.
 */
function AlertIndicator({ alert }: { alert: TabAlert }): JSX.Element {
  const label = tabAlertTooltip(alert)
  return (
    <span
      className={cn(
        'zen-tab-alert flex h-6 w-6 shrink-0 items-center justify-center',
        alert === 'pip' ? 'text-[var(--v2-control-text-deemphasized)]' : 'text-[var(--v2-danger)]'
      )}
      data-alert={alert}
      role="img"
      title={label}
      aria-label={label}
    >
      {alert === 'recording' && (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" aria-hidden focusable="false">
          <circle cx="12" cy="12" r="7" fill="currentColor" />
        </svg>
      )}
      {alert === 'capturing' && <ScreenShare className="h-3.5 w-3.5" aria-hidden />}
      {alert === 'pip' && <PictureInPicture2 className="h-3.5 w-3.5" aria-hidden />}
    </span>
  )
}

/** Marks a tab an AI agent is driving; click to take the tab back. */
function AgentBadge({ agent, tabId }: { agent: AgentInfo; tabId: string }): JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="zen-toolbar-button flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-white"
      style={{ background: agent.color }}
      title={`Driven by ${agent.name} (${agent.mode} mode) — click to take this tab back`}
      onClick={(e) => {
        e.stopPropagation()
        run('agent.releaseTab', { tabId })
      }}
    >
      <Bot className="h-3 w-3" />
    </button>
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
      className="zen-no-drag zen-squircle min-w-0 flex-1 rounded-md bg-[var(--v2-control-fill)] px-1.5 py-0.5 outline-none ring-1 ring-[var(--v2-control-accent)]"
    />
  )
}

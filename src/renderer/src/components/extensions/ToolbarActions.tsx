import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, PinOff, Puzzle, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { ExtensionInfo, Rect, UIState } from '@shared/types'
import { anchorOf } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { badgeLabel, badgeStyle } from '@renderer/lib/extensions/badge'
import { closeExtensionPopup, openExtensionPopup } from '@renderer/lib/extensions/popup'
import { anchorBelow } from '@renderer/lib/extensions/popupPlacement'
import {
  actionIcon,
  actionTitle,
  actionable,
  fitToolbarActions,
  pinnedActions
} from '@renderer/lib/extensions/toolbar'
import { activeTab } from '@renderer/lib/selectors'
import { openOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { LocalMenu, type LocalMenuEntry } from '../menus/LocalMenu'
import { ExtensionIcon } from './ExtensionIcon'

const PANEL_WIDTH = 320

interface Props {
  state: UIState
  /** Width of the row the actions share with the address pill; null in a column layout. */
  rowWidth: number | null
  /** Buttons always present in the row (navigation, menu); the puzzle button is counted here. */
  fixedButtons: number
  /** The row has no address pill (compact column), so nothing needs a width floor. */
  compact: boolean
}

/**
 * Pinned extension actions as 28 toolbar buttons with their badges, and the puzzle-piece button
 * that holds the rest (design-language.md §8.3 icon buttons, §8.1 panel, §8.8 rows). Actions that
 * do not fit beside the address pill fold into the panel in pin order.
 */
export function ToolbarActions({
  state,
  rowWidth,
  fixedButtons,
  compact
}: Props): JSX.Element | null {
  const all = actionable(state.extensions)
  const pinned = pinnedActions(state.extensions)
  // A column (compact sidebar) or an unmeasured row shows every pinned action.
  const fit =
    compact || rowWidth === null || rowWidth === 0
      ? { shown: pinned.length, hidden: 0 }
      : fitToolbarActions({ rowWidth, fixedButtons, pinned: pinned.length })
  const shown = pinned.slice(0, fit.shown)
  const [panelAnchor, setPanelAnchor] = useState<Rect | null>(null)
  if (all.length === 0) return null
  return (
    <>
      {shown.map((ext) => (
        <ActionButton key={ext.id} ext={ext} state={state} />
      ))}
      <button
        type="button"
        className="zen-toolbar-button"
        title="Extensions"
        aria-label="Extensions"
        aria-haspopup="dialog"
        aria-expanded={panelAnchor !== null}
        data-active={panelAnchor !== null || undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          closeExtensionPopup()
          setPanelAnchor(panelAnchor ? null : anchorOf(e.currentTarget))
        }}
      >
        <Puzzle className="h-4 w-4" />
      </button>
      {panelAnchor && (
        <ExtensionsPanel
          state={state}
          anchor={panelAnchor}
          extensions={all}
          onClose={() => setPanelAnchor(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One pinned action
// ---------------------------------------------------------------------------

function ActionButton({ ext, state }: { ext: ExtensionInfo; state: UIState }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<Rect | null>(null)
  const open = uiStore.use((s) => s.extensionPopup?.id === ext.id)
  // A click on the button whose popup is up closes it (main's blur handler closes it too, but
  // the click would otherwise reopen it straight away).
  const closing = useRef(false)
  const badge = ext.action ? badgeLabel(ext.action.badgeText) : ''
  const badgeColours = ext.action ? badgeStyle(ext.action) : null
  const disabled = ext.action?.enabled === false
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="zen-toolbar-button relative"
        title={actionTitle(ext)}
        aria-label={actionTitle(ext)}
        aria-haspopup={ext.popup ? 'dialog' : undefined}
        aria-expanded={ext.popup ? open : undefined}
        data-active={open || undefined}
        disabled={disabled}
        onMouseDown={(e) => {
          closing.current = uiStore.get().extensionPopup?.id === ext.id
          // Keep the app-wide "mousedown closes the popup" from racing this button's own click.
          if (closing.current) e.stopPropagation()
        }}
        onClick={() => {
          if (closing.current) {
            closing.current = false
            closeExtensionPopup()
            return
          }
          const r = ref.current
          if (r) openExtensionPopup(ext.id, anchorOf(r), Boolean(ext.action?.popup ?? ext.popup))
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu(anchorOf(e.currentTarget))
        }}
      >
        <ExtensionIcon icon={actionIcon(ext)} size={16} box={16} />
        {badge && badgeColours && (
          <span
            className="zen-ext-badge"
            style={{ background: badgeColours.background, color: badgeColours.color }}
            aria-label={`Badge ${badge}`}
          >
            {badge}
          </span>
        )}
      </button>
      {menu && (
        <LocalMenu
          anchor={menu}
          title={ext.name}
          items={actionMenu(ext, state)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

/** Right-click on a toolbar action. */
function actionMenu(ext: ExtensionInfo, state: UIState): LocalMenuEntry[] {
  const items: LocalMenuEntry[] = []
  if (ext.optionsPage) {
    items.push({
      id: 'options',
      label: 'Options',
      icon: SlidersHorizontal,
      onSelect: () => run('extension.openOptions', { id: ext.id })
    })
  }
  items.push({
    id: 'unpin',
    label: 'Unpin from toolbar',
    icon: PinOff,
    onSelect: () => run('extension.setPinned', { id: ext.id, pinned: false })
  })
  items.push({
    id: 'manage',
    label: 'Manage extensions',
    icon: Puzzle,
    onSelect: () => void openOverlay('addons', activeTab(state)?.id ?? null)
  })
  items.push({ id: 'sep', type: 'separator' })
  items.push({
    id: 'remove',
    label: 'Remove',
    icon: Trash2,
    danger: true,
    onSelect: () => run('extension.remove', { id: ext.id })
  })
  return items
}

// ---------------------------------------------------------------------------
// The puzzle-piece panel
// ---------------------------------------------------------------------------

function ExtensionsPanel({
  state,
  anchor,
  extensions,
  onClose
}: {
  state: UIState
  anchor: Rect
  extensions: ExtensionInfo[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; side: 'left' | 'right' } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const placed = anchorBelow(
      anchor,
      { width: PANEL_WIDTH, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPos({ left: placed.x, top: placed.y, side: placed.side })
  }, [anchor, extensions.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const openFromPanel = (ext: ExtensionInfo): void => {
    onClose()
    openExtensionPopup(ext.id, anchor, Boolean(ext.action?.popup ?? ext.popup))
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[90]"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-label="Extensions"
        className="zen-panel zen-ext-panel zen-animate-pop"
        style={{
          left: pos?.left ?? anchor.x,
          top: pos?.top ?? anchor.y + anchor.height + 8,
          visibility: pos ? 'visible' : 'hidden',
          transformOrigin: pos?.side === 'right' ? '100% 0' : '0 0'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="zen-ext-panel-heading">Extensions</div>
        <ul className="flex flex-col">
          {extensions.map((ext) => (
            <li key={ext.id} className="zen-ext-panel-row">
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                title={actionTitle(ext)}
                onClick={() => openFromPanel(ext)}
              >
                <ExtensionIcon icon={actionIcon(ext)} size={16} box={16} />
                <span className="min-w-0 flex-1 truncate">{ext.name}</span>
              </button>
              <button
                type="button"
                className={cn('zen-toolbar-button', ext.pinned && 'text-[var(--zen-accent-ink)]')}
                title={ext.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
                aria-label={ext.pinned ? `Unpin ${ext.name}` : `Pin ${ext.name} to toolbar`}
                aria-pressed={Boolean(ext.pinned)}
                onClick={() => run('extension.setPinned', { id: ext.id, pinned: !ext.pinned })}
              >
                {ext.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col">
          <button
            type="button"
            className="zen-ext-panel-row"
            onClick={() => {
              onClose()
              void openOverlay('addons', activeTab(state)?.id ?? null)
            }}
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-[var(--zen-muted)]" />
            <span className="min-w-0 flex-1 truncate">Manage extensions</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, PinOff, Puzzle, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { ExtensionInfo, Rect, UIState } from '@shared/types'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { anchorOf } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { badgeLabel, badgeStyle } from '@renderer/lib/extensions/badge'
import { closeExtensionPopup, openExtensionPopup } from '@renderer/lib/extensions/popup'
import { anchorBelow } from '@renderer/lib/extensions/popupPlacement'
import {
  actionEnabled,
  actionIcon,
  actionTitle,
  actionable,
  fitToolbarActions,
  pinnedActions
} from '@renderer/lib/extensions/toolbar'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay, openOverlay, uiStore } from '@renderer/lib/ui'
import { LocalMenu, type LocalMenuEntry } from '../menus/LocalMenu'
import { ExtensionIcon } from './ExtensionIcon'
import { V2IconButton } from './v2'

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
 * Pinned extension actions as toolbar buttons (the shipped `.zen-toolbar-button`, so they match
 * their neighbours until the v2 pass moves the toolbar) with their badges, and the puzzle-piece
 * button that holds the rest in a v2 panel of 32 rows. Actions that do not fit beside the
 * address pill fold into the panel in pin order.
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
  // Off for this tab (`chrome.action.disable`): the button stays, dimmed (§9.3), a click does
  // nothing, the context menu still opens – so `aria-disabled` rather than `disabled`.
  const off = !actionEnabled(ext)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="zen-toolbar-button zen-ext-action relative"
        title={actionTitle(ext)}
        aria-label={actionTitle(ext)}
        aria-haspopup={ext.popup ? 'dialog' : undefined}
        aria-expanded={ext.popup ? open : undefined}
        aria-disabled={off || undefined}
        data-active={open || undefined}
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
          if (off) return
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
          context
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
      // The options page opens in a tab; an overlay that is up (Add-ons, Settings) would hide it.
      onSelect: () => {
        closeOverlay()
        run('extension.openOptions', { id: ext.id })
      }
    })
  }
  items.push({
    id: 'unpin',
    label: 'Unpin from Toolbar',
    icon: PinOff,
    onSelect: () => run('extension.setToolbarPinned', { id: ext.id, pinned: false })
  })
  items.push({
    id: 'manage',
    label: 'Manage Extensions',
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
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  // The panel overhangs the content frame: it paints once the page's capture is in place.
  const ready = useFloatingChrome()
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
  }, [anchor, extensions.length, ready])
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
    if (!actionEnabled(ext)) return
    onClose()
    openExtensionPopup(ext.id, anchor, Boolean(ext.action?.popup ?? ext.popup))
  }
  if (!ready) return null
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
        className="zen-v2 zen-v2-panel zen-ext-panel zen-animate-pop"
        style={{
          left: pos?.left ?? anchor.x,
          top: pos?.top ?? anchor.y + anchor.height + 8,
          visibility: pos ? 'visible' : 'hidden',
          transformOrigin: pos?.side === 'right' ? '100% 0' : '0 0'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ul className="flex flex-col">
          {extensions.map((ext) => (
            <li key={ext.id} className="zen-ext-panel-row">
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                title={actionTitle(ext)}
                aria-disabled={!actionEnabled(ext) || undefined}
                onClick={() => openFromPanel(ext)}
              >
                <ExtensionIcon icon={actionIcon(ext)} size={16} box={16} />
                <span className="min-w-0 flex-1 truncate">{ext.name}</span>
              </button>
              <V2IconButton
                icon={ext.toolbarPinned ? PinOff : Pin}
                label={ext.toolbarPinned ? `Unpin ${ext.name}` : `Pin ${ext.name} to toolbar`}
                title={ext.toolbarPinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
                aria-pressed={ext.toolbarPinned}
                onClick={() =>
                  run('extension.setToolbarPinned', { id: ext.id, pinned: !ext.toolbarPinned })
                }
              />
            </li>
          ))}
        </ul>
        <div className="zen-v2-menu-separator" role="separator" />
        <button
          type="button"
          className="zen-ext-panel-row"
          onClick={() => {
            onClose()
            void openOverlay('addons', activeTab(state)?.id ?? null)
          }}
        >
          <SlidersHorizontal className="zen-v2-deemphasized" />
          <span className="min-w-0 flex-1 truncate">Manage Extensions</span>
        </button>
      </div>
    </div>,
    document.body
  )
}

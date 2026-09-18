import type { JSX, RefObject } from 'react'
import { useRef, useState } from 'react'
import { Pin, PinOff, Puzzle, SlidersHorizontal } from 'lucide-react'
import type { ExtensionInfo, UIState } from '@shared/types'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { usePopover } from '@renderer/hooks/usePopover'
import { anchorOf, placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { badgeLabel, badgeStyle } from '@renderer/lib/extensions/badge'
import { closeExtensionPopup, openExtensionPopup } from '@renderer/lib/extensions/popup'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { ChromePortal, POPOVER_WIDTH } from '@renderer/lib/portals'
import {
  actionEnabled,
  actionIcon,
  actionTitle,
  actionable,
  fitToolbarActions,
  pinnedActions
} from '@renderer/lib/extensions/toolbar'
import { activeTab } from '@renderer/lib/selectors'
import { openOverlay, uiStore } from '@renderer/lib/ui'
import { ExtensionIcon } from './ExtensionIcon'
import { V2IconButton, V2TitleBlock } from './v2'

/** Rows with a trailing pin button: the 400 of §9.20's three widths. */
const PANEL_WIDTH = POPOVER_WIDTH.form

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
 * button that holds the rest in a v2 popover (§9.20) of 36 rows. Actions that do not fit beside
 * the address pill fold into the panel in pin order.
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
  const puzzle = useRef<HTMLButtonElement>(null)
  const [panelAnchor, setPanelAnchor] = useState<Anchor | null>(null)
  if (all.length === 0) return null
  return (
    <>
      {shown.map((ext) => (
        <ActionButton key={ext.id} ext={ext} />
      ))}
      <button
        ref={puzzle}
        type="button"
        className="zen-toolbar-button zen-ext-puzzle"
        title="Extensions"
        aria-label="Extensions"
        aria-haspopup="dialog"
        aria-expanded={panelAnchor !== null}
        data-active={panelAnchor !== null || undefined}
        // An open popup's layer takes the press before it reaches this button (§9.20); the
        // panel's claim on the popover slot closes one still pending its capture.
        onClick={(e) => setPanelAnchor(panelAnchor ? null : anchorOf(e.currentTarget))}
      >
        <Puzzle className="h-4 w-4" />
      </button>
      {panelAnchor && (
        <ExtensionsPanel
          state={state}
          anchor={panelAnchor}
          extensions={all}
          opener={puzzle}
          onClose={() => setPanelAnchor(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One pinned action
// ---------------------------------------------------------------------------

/**
 * While its popup is up the button sits under the popup's dismiss layer (§9.20): a press on it
 * closes the popup and does not reopen it, and never reaches this handler.
 */
function ActionButton({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const open = uiStore.use((s) => s.extensionPopup?.id === ext.id)
  const badge = ext.action ? badgeLabel(ext.action.badgeText) : ''
  // The extension's own colours when it set them; otherwise none inline, and the badge takes the
  // accent of the surface it sits on – here the toolbar's `--zen-accent` (§9.29).
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
        onClick={() => {
          if (off) return
          const r = ref.current
          if (r) openExtensionPopup(ext.id, anchorOf(r), Boolean(ext.action?.popup ?? ext.popup))
        }}
        onContextMenu={(e) => {
          // The core's menu (#104): the extension's own `contextMenus` items, then Zenium's.
          e.preventDefault()
          closeExtensionPopup()
          run('extension.actionContextMenu', { id: ext.id, x: e.clientX, y: e.clientY })
        }}
      >
        <ExtensionIcon icon={actionIcon(ext)} size={16} box={16} />
        {badge && (
          <span
            className="zen-ext-badge"
            style={
              badgeColours
                ? { background: badgeColours.background, color: badgeColours.color }
                : undefined
            }
            aria-label={`Badge ${badge}`}
          >
            {badge}
          </span>
        )}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// The puzzle-piece panel
// ---------------------------------------------------------------------------

/**
 * The puzzle-piece popover (§9.20): 400 wide, flush under the toolbar's bar and aligned with
 * the button (`placePopover`, through the chrome layer), a title block (§9.23) over rows of 36
 * – icon, name and a pin button (§9.21) – then Manage Extensions behind a hairline. Past 60% of
 * the window's height the rows scroll under the title. Focus lands on the first row and returns
 * to the button on Escape (§9.22).
 */
function ExtensionsPanel({
  state,
  anchor,
  extensions,
  opener,
  onClose
}: {
  state: UIState
  anchor: Anchor
  extensions: ExtensionInfo[]
  /** The puzzle button: where focus returns on Escape (§9.22). */
  opener: RefObject<HTMLElement | null>
  onClose: () => void
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  // Opened from the keyboard (the button shows its focus ring) the page did not have focus and
  // does not get it back on close: focus stays on the button the panel returns it to (§9.22).
  const [fromKeyboard] = useState(openedFromKeyboard)
  // The panel overhangs the content frame: it paints once the page's capture is in place.
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  const [scrolled, setScrolled] = useState(false)
  usePopover(ref, { onClose, active: ready, returnTo: opener })
  const openFromPanel = (ext: ExtensionInfo): void => {
    if (!actionEnabled(ext)) return
    onClose()
    openExtensionPopup(ext.id, anchor, Boolean(ext.action?.popup ?? ext.popup))
  }
  if (!ready) return null
  const box = placeUnder(anchor, PANEL_WIDTH)
  // The layer under the panel is the light dismiss (§9.20): a press anywhere outside it – the
  // page, the bar, another anchor – closes the panel on pointerdown and goes no further. (The
  // chrome layer supplies no dismiss of its own; this one is kept until it does.)
  return (
    <ChromePortal>
      <div
        className="fixed inset-0"
        onPointerDown={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-labelledby="zen-ext-panel-title"
          className="zen-v2 zen-v2-panel zen-ext-panel zen-animate-pop"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            maxHeight: box.maxHeight,
            transformOrigin: popOrigin(anchor, box)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <V2TitleBlock id="zen-ext-panel-title" title="Extensions" scrolled={scrolled} />
          <div
            className="zen-ext-panel-body"
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
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
        </div>
      </div>
    </ChromePortal>
  )
}

import type { JSX } from 'react'
import type { Rect, UIState } from '@shared/types'
import { defaultSearchEngineOf } from '@shared/search'
import { urlbarFieldBox } from '@renderer/lib/layout'
import { openTabPicker } from '@renderer/lib/tabSearch'
import { openUrlbar, type UiState } from '@renderer/lib/ui'

interface Props {
  state: UIState
  ui: UiState
  /** The blank tab shown in the pane. */
  tabId: string
  /** The split the pane belongs to. */
  groupId: string
  /** The pane's box under its header, relative to the content viewport (as `SplitChrome` draws). */
  rect: Rect
  /** The content viewport's box in window coordinates: `rect` translated by it is the pane's window box. */
  viewport: Rect
}

/** Box to box from the field's bottom edge to the button (§4). */
const FIELD_TO_BUTTON = 16

/**
 * An empty pane of a split (split-04; Edge's empty right pane): the chrome's own surface where
 * the blank tab's view would be – the layout reporter places none there – carrying the pane's
 * URL field and, centred 16 under it, a "Choose a tab" secondary (§9.34, at 32) that opens the
 * tab search popover in its pick mode (`openTabPicker`). The field is the desktop URL bar's own
 * box in the pane (`urlbarFieldBox`): at rest it is drawn here as the bar looks at rest – the
 * surface, the engine glyph, the placeholder – and a press opens the bar for the pane's tab on
 * the same box (`urlbar.pane`), so typing an address or a search into the pane works as it
 * always has; while the bar is up it stands in for the field and this draws the button alone.
 * The pane is the window's surface (`data-surface="window"`, §9.29): the frame it lies in.
 */
export function EmptyPane({ state, ui, tabId, groupId, rect, viewport }: Props): JSX.Element {
  const attached = state.settings.urlbarBehavior === 'normal'
  const field = urlbarFieldBox({ x: 0, y: 0, width: rect.width, height: rect.height }, !attached)
  const barOpen = ui.urlbar.open && ui.urlbar.pane && ui.urlbar.tabId === tabId
  // The picker up for this pane: the request names the pane it hangs from (`openTabPicker`).
  const pickerOpen = ui.tabSearch?.pick?.paneTabId === tabId
  const engine = defaultSearchEngineOf(
    state.searchEngines,
    state.settings.searchEngineId,
    state.searchEngineControl
  )
  return (
    <div
      className="absolute"
      data-surface="window"
      data-empty-pane={tabId}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      {!barOpen && (
        <button
          type="button"
          className="zen-omnibox zen-empty-pane-field absolute flex items-center"
          data-attached={attached}
          aria-label="Search or enter address"
          style={{ left: field.x, top: field.y, width: field.width, height: field.height }}
          onClick={() => void openUrlbar('edit', tabId, { attached, pane: true })}
        >
          <span className="zen-omnibox-engine" aria-hidden>
            {engine.glyph}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">Search or enter address</span>
        </button>
      )}
      <div
        className="absolute inset-x-0 flex justify-center"
        style={{ top: field.y + field.height + FIELD_TO_BUTTON }}
      >
        <button
          type="button"
          className="zen-v2-button"
          data-pick-tab={tabId}
          // The picker is a popover (`role="dialog"`): the button is its anchor (§9.20, §9.22 –
          // the anchor says both what it opens and whether that is up).
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() =>
            openTabPicker({
              paneTabId: tabId,
              groupId,
              pane: {
                x: viewport.x + rect.x,
                y: viewport.y + rect.y,
                width: rect.width,
                height: rect.height
              }
            })
          }
        >
          Choose a tab
        </button>
      </div>
    </div>
  )
}

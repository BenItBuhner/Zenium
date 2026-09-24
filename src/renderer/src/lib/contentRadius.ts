import { isDockedInFrame, sanitizeDevtoolsDock } from '@shared/devtoolsDock'
import type { DevtoolsDock, FormFactor, UIState } from '@shared/types'
import { visibleTabIds } from './selectors'

/** The content frame's corner radius on the desktop (design language v2 §2: the outer 10 of the pair). */
export const DESKTOP_CONTENT_RADIUS = 10
/** The phone keeps a slimmer frame around its content card, at a larger radius. */
export const PHONE_CONTENT_RADIUS = 14

/**
 * Where the toolbox on `tabId` stands, or null with none up (design language v2 §9.29). The
 * tab's own reading first (`Tab.devtools`, the host's read-back for that view: a toolbox left
 * docked at the bottom while another tab's was undocked is still docked at the bottom); a host
 * that reports a toolbox open but no dock of its own (a record from before the field) is read
 * at the setting, the default every toolbox opens at.
 */
export function devtoolsDockOf(state: UIState, tabId: string): DevtoolsDock | null {
  const own = state.tabs?.[tabId]?.devtools
  if (own) return sanitizeDevtoolsDock(own.dock, state.settings.devtoolsDock ?? 'bottom')
  const open = state.devtoolsOpenFor
  if (!open || !open.includes(tabId)) return null
  return state.settings.devtoolsDock ?? 'bottom'
}

/**
 * Whether a developer toolbox stands docked inside the frame's box on a page the window shows
 * (design language v2 §9.29): a visible tab has its tools open at one of the frame's docks
 * (bottom, right, left – not a window of its own). Each tab's toolbox is read where it stands,
 * so the frame follows the toolbox in front: tab A docked at the bottom and tab B's undocked,
 * switching between them switches the frame's shape.
 */
export function devtoolsDockedInFrame(state: UIState): boolean {
  const open = state.devtoolsOpenFor
  if (!open || open.length === 0) return false
  return visibleTabIds(state).some((id) => {
    const dock = devtoolsDockOf(state, id)
    return dock !== null && isDockedInFrame(dock)
  })
}

/**
 * The frame's radius (`--zen-content-radius`), as the theme hook writes it and the layout
 * reporter hands it to the host for the page views – one reading, so the host's views and the
 * chrome's box agree from the first report. Borderless and fullscreen windows have none; the
 * phone has its 14; the desktop its 10 – unless a toolbox is docked in the frame (§9.29): the
 * host docks the toolbox inside the page's own view and rounds that view's page layer alone,
 * never the toolbox's, so a rounded frame would show the toolbox's square corners over its
 * shadow and notch the page's corners at the seam. The frame yields to a square box while the
 * toolbox is up, radius and shadow still the outer box's, and rounds again as it closes.
 */
export function contentRadius(state: UIState, formFactor: FormFactor): number {
  if (state.settings.borderless || state.window.fullscreen) return 0
  if (formFactor === 'phone') return PHONE_CONTENT_RADIUS
  return devtoolsDockedInFrame(state) ? 0 : DESKTOP_CONTENT_RADIUS
}

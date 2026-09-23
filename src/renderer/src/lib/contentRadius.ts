import { isDockedInFrame } from '@shared/devtoolsDock'
import type { FormFactor, UIState } from '@shared/types'
import { visibleTabIds } from './selectors'

/** The content frame's corner radius on the desktop (design language v2 §2: the outer 10 of the pair). */
export const DESKTOP_CONTENT_RADIUS = 10
/** The phone keeps a slimmer frame around its content card, at a larger radius. */
export const PHONE_CONTENT_RADIUS = 14

/**
 * Whether a developer toolbox stands docked inside the frame's box on a page the window shows
 * (design language v2 §9.29): the remembered dock is one of the frame's (bottom, right, left –
 * not a window of its own) and a visible tab has its tools open. The dock is the setting's, one
 * for every toolbox: a toolbox left docked while another tab's was undocked reads as undocked
 * here until it is next opened.
 */
export function devtoolsDockedInFrame(state: UIState): boolean {
  const open = state.devtoolsOpenFor
  if (!open || open.length === 0) return false
  if (!isDockedInFrame(state.settings.devtoolsDock ?? 'bottom')) return false
  const visible = visibleTabIds(state)
  return visible.some((id) => open.includes(id))
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

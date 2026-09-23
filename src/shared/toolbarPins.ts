/**
 * The desktop toolbar's optional controls (Settings › Look and Feel › Customize toolbar,
 * `settings-36`; Chrome's pinnable toolbar actions, Firefox's Customize): which of the controls
 * beside the address pill are pinned in the bar. Back, Reload, the pill itself and the ⋯ menu
 * are never optional and have no key here. A control that is not pinned is folded into the app
 * menu, whose row for it is what runs it – Forward's row, Reader View, Translate Page…,
 * Bookmark This Page, Now Playing… – so nothing is lost, only moved (v2 §9.29's fold).
 *
 * The record holds the user's departures alone: a key absent reads pinned, so a profile from
 * before the setting existed shows the default bar, and re-pinning a control removes its key
 * rather than writing `true`. The downloads button is not a key: its "pin" is the existing
 * `downloads.alwaysShowButton` (Chrome's "Always show downloads button"), which the Customize
 * toolbar dialog binds as its Downloads row – one field, wherever it is set.
 *
 * Read by the desktop chrome's toolbar row alone (`components/sidebar/SidebarTop.tsx`'s
 * `NavRow`, on the desktop form factor; `core/menus.ts` for the folded Forward row): the phone
 * and the tablet keep their own bars, so the field is inert there – Android carries it in its
 * settings as a synced value and reads nothing from it.
 */

/** The optional controls, in the bar's own order: Forward, then the pill's chips left to right, then the hub. */
export const TOOLBAR_CONTROLS = ['forward', 'reader', 'translate', 'star', 'media'] as const

export type ToolbarControl = (typeof TOOLBAR_CONTROLS)[number]

/** Which optional controls are pinned; a key absent reads pinned, `false` is a control folded away. */
export type ToolbarPins = Partial<Record<ToolbarControl, boolean>>

export const DEFAULT_TOOLBAR_PINS: ToolbarPins = {}

export function isToolbarControl(value: unknown): value is ToolbarControl {
  return typeof value === 'string' && (TOOLBAR_CONTROLS as readonly string[]).includes(value)
}

/**
 * A stored record read back (a profile, a settings patch, a sync merge): known keys with a
 * boolean value only, and of those only the departures (`false`) – a `true` is the default
 * and is not kept. Anything else (an array, a string, a key a newer build may write) reads as
 * no departure, so the bar never loses a control to a corrupt field.
 */
export function sanitizeToolbarPins(raw: unknown): ToolbarPins {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const pins: ToolbarPins = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isToolbarControl(key) && value === false) pins[key] = false
  }
  return pins
}

/** Whether `control` is in the bar; a record absent (a partial state in a test) shows everything. */
export function toolbarPinned(pins: ToolbarPins | undefined, control: ToolbarControl): boolean {
  return pins?.[control] !== false
}

/** The record with `control` pinned or folded: a pin removes the key, a fold writes `false`. */
export function withToolbarPin(
  pins: ToolbarPins | undefined,
  control: ToolbarControl,
  pinned: boolean
): ToolbarPins {
  const next: ToolbarPins = { ...sanitizeToolbarPins(pins) }
  if (pinned) delete next[control]
  else next[control] = false
  return next
}

/** Whether any control is folded away: what "Reset to default" has to undo. */
export function toolbarCustomized(pins: ToolbarPins | undefined): boolean {
  return TOOLBAR_CONTROLS.some((control) => !toolbarPinned(pins, control))
}

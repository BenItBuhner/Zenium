/**
 * The desktop toolbar's optional controls (Settings › Look and Feel › Customise toolbar,
 * `settings-36`; Chrome's pinnable toolbar actions, Firefox's Customize): which of the controls
 * beside the address pill are pinned in the bar. Back, Reload, the pill itself and the ⋯ menu
 * are never optional and have no key here. A control that is not pinned is folded into the app
 * menu, whose row for it is what runs it – Forward's row, Reader View, Translate Page…,
 * Bookmark This Page, Media Controls… – so nothing is lost, only moved (v2 §9.29's fold). Home
 * (`settings-32`; Chrome's `browser.show_home_button`, the pin state of its `kActionHome`) is
 * the one control folded by default and the one with no menu row: unpinned there is no Home
 * button, as Chrome's leaves the toolbar, and Alt+Home (`nav.home`) keeps its destination.
 *
 * The record holds the user's departures from the default bar alone: a key absent reads the
 * control's default – pinned for every control but Home – so a profile from before the setting
 * existed shows the default bar, and putting a control back to its default removes its key
 * rather than writing the default. The downloads button is not a key: its "pin" is the existing
 * `downloads.alwaysShowButton` (Chrome's "Always show downloads button"), which the Customise
 * toolbar dialog binds as its Downloads row – one field, wherever it is set.
 *
 * The Energy Saver leaf (W8-2, `energy-saver`; Chrome's `BatterySaverButton`, which stands in
 * Chrome's toolbar ahead of the media button and shows only while the mode is on) is the one
 * control whose fold has no menu row: Chrome's button has none, and the mode runs on whether
 * the leaf is drawn or not – unpinned, it is simply not drawn, and Settings › Performance, which
 * holds the switch, says when the mode is on. Chrome's button cannot be unpinned; the lead is
 * asked whether Zenium's should be (W8-2's LEAD CHECK), and until then it is a pin like the rest.
 *
 * Read by the desktop chrome's toolbar row alone (`components/sidebar/SidebarTop.tsx`'s
 * `NavRow`, on the desktop form factor; `core/menus.ts` for the folded Forward row): the phone
 * and the tablet keep their own bars, so the field is inert there – Android carries it in its
 * settings as a synced value and reads nothing from it.
 */

/**
 * The optional controls, in the bar's own order: Forward and Home ahead of the pill (Chrome's
 * toolbar: Back, Forward, Reload, Home, then the location bar), then the pill's chips left to
 * right (Reader View, Translate, the Install-app chip, the star – Chrome's page-action order in
 * `page_action/action_ids.h`, the star last), then the leaf and the hub (Chrome's
 * `ToolbarView::Init`: the battery saver button, then the media button). The Install chip is a
 * pin as Reader View and Translate are – Chrome's contextual page actions that the house lets
 * fold into the app menu, whose "Install <app>…" row is what runs it then (W8-6).
 */
export const TOOLBAR_CONTROLS = [
  'forward',
  'home',
  'reader',
  'translate',
  'install',
  'star',
  'energy-saver',
  'media'
] as const

export type ToolbarControl = (typeof TOOLBAR_CONTROLS)[number]

/** Which optional controls are pinned; a key absent reads the control's default. */
export type ToolbarPins = Partial<Record<ToolbarControl, boolean>>

export const DEFAULT_TOOLBAR_PINS: ToolbarPins = {}

/**
 * Whether `control` is in the default bar: every control but Home, which Chrome ships hidden
 * (`kShowHomeButton` defaults to false; `browser_ui_prefs.cc`) and Zenium with it.
 */
export function toolbarDefaultPinned(control: ToolbarControl): boolean {
  return control !== 'home'
}

export function isToolbarControl(value: unknown): value is ToolbarControl {
  return typeof value === 'string' && (TOOLBAR_CONTROLS as readonly string[]).includes(value)
}

/**
 * A stored record read back (a profile, a settings patch, a sync merge): known keys with a
 * boolean value only, and of those only the departures from the default – a control's default
 * written out is not kept. Anything else (an array, a string, a key a newer build may write)
 * reads as no departure, so the bar never loses a control to a corrupt field.
 */
export function sanitizeToolbarPins(raw: unknown): ToolbarPins {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const pins: ToolbarPins = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isToolbarControl(key) && typeof value === 'boolean' && value !== toolbarDefaultPinned(key))
      pins[key] = value
  }
  return pins
}

/**
 * Whether `control` is in the bar; a record absent (a partial state in a test, a form factor
 * whose bar is its own – `lib/toolbarPins.ts`'s `pinsFor`) shows the default bar.
 */
export function toolbarPinned(pins: ToolbarPins | undefined, control: ToolbarControl): boolean {
  return pins?.[control] ?? toolbarDefaultPinned(control)
}

/**
 * The record with `control` pinned or folded: the control's default removes its key, a
 * departure from it writes the boolean.
 */
export function withToolbarPin(
  pins: ToolbarPins | undefined,
  control: ToolbarControl,
  pinned: boolean
): ToolbarPins {
  const next: ToolbarPins = { ...sanitizeToolbarPins(pins) }
  if (pinned === toolbarDefaultPinned(control)) delete next[control]
  else next[control] = pinned
  return next
}

/**
 * The controls that depart from the default bar, in the bar's order – a folded Forward, a shown
 * Home: what the Settings row counts and "Reset to default" has to undo.
 */
export function toolbarDepartures(pins: ToolbarPins | undefined): ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter(
    (control) => toolbarPinned(pins, control) !== toolbarDefaultPinned(control)
  )
}

/** Whether any control departs from the default bar: what "Reset to default" has to undo. */
export function toolbarCustomized(pins: ToolbarPins | undefined): boolean {
  return toolbarDepartures(pins).length > 0
}

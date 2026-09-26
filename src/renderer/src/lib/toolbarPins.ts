import { TOOLBAR_CONTROLS, toolbarPinned, type ToolbarControl } from '@shared/toolbarPins'
import type { FormFactor, UIState } from '@shared/types'
import { createStore } from './store'

/**
 * The desktop toolbar's pinned controls as the chrome reads them (Settings › Look and Feel ›
 * Customise toolbar, `shared/toolbarPins.ts`; settings-36): the setting speaks for the desktop
 * layout alone – the phone and the tablet keep their own bars, so on those form factors every
 * control reads pinned whatever the profile carries (the field is inert there, as the Android
 * nod has it). `NavRow` draws from this; the app menu's folded Forward row is the core's
 * (`core/menus.ts`), from the same field.
 */
export function pinsFor(
  state: UIState,
  formFactor: FormFactor
): UIState['settings']['toolbarPins'] {
  return formFactor === 'desktop' ? state.settings.toolbarPins : undefined
}

/**
 * Which pinned controls the bar's width tier has hidden right now (design language v2 §9.29:
 * the pill's chips and the media hub's button fold by the row's width, never by a setting),
 * published from `NavRow`'s layout phase and read by the Customise toolbar dialog, whose row
 * for such a control stays checked and says "Hidden at this width." (the lead's spec in §10.5).
 * Empty until a row has laid out; a row unmounting clears what it published.
 */
export const toolbarTiering = createStore<{ hidden: readonly ToolbarControl[] }>(
  { hidden: [] },
  'toolbarTiering'
)

/** Publish the tier's hidden set; a set equal to the last one published changes nothing. */
export function publishToolbarTiering(hidden: readonly ToolbarControl[]): void {
  const prev = toolbarTiering.get().hidden
  if (prev.length === hidden.length && prev.every((c, i) => c === hidden[i])) return
  toolbarTiering.set({ hidden })
}

/** Whether `control` is pinned yet off the bar for want of width. */
export function hiddenAtThisWidth(
  hidden: readonly ToolbarControl[],
  control: ToolbarControl
): boolean {
  return hidden.includes(control)
}

/** The controls folded away, in the bar's order – what the Settings row counts. */
export function foldedControls(pins: UIState['settings']['toolbarPins']): ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter((control) => !toolbarPinned(pins, control))
}

/**
 * The marks a pinnable control's button carries for its right-click menu (context-menus-112;
 * Chrome's pinned toolbar button menu – Unpin, Customise Toolbar…): `data-zen-menu="toolbar"`
 * with the control in `data-zen-menu-control`, read by the host under the pointer
 * (`WindowHost.menuTargetAt`) and by the core (`showChromeContextMenu`). The desktop layout's
 * alone, as the pins are: on the other form factors the button carries no mark. The star chip
 * keeps its own `data-zen-menu="star"` (its bookmark rows come first) and takes the control
 * mark alone. Forward carries none: its right-click is the back/forward stack's menu, as
 * Chrome's Forward keeps its `BackForwardMenuModel` – a pref-toggled button, not one of
 * Chrome's pinned action buttons – and its pin is Settings' "Show forward button" switch.
 */
export function toolbarMenuMarks(
  control: ToolbarControl,
  formFactor: FormFactor
): { 'data-zen-menu'?: 'toolbar'; 'data-zen-menu-control'?: ToolbarControl } {
  return formFactor === 'desktop'
    ? { 'data-zen-menu': 'toolbar', 'data-zen-menu-control': control }
    : {}
}

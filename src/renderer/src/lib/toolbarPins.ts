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

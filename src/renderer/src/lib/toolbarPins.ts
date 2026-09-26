import { TOOLBAR_CONTROLS, toolbarPinned, type ToolbarControl } from '@shared/toolbarPins'
import type { FormFactor, UIState } from '@shared/types'
import { PILL_PADDING, PILL_TOOLS_TIER } from '@renderer/components/urlbar/pillChipTiers'
import { TOOLBAR_BUTTON, TOOLBAR_GAP } from './extensions/toolbar'
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
 * The pill a folding toolbar button must leave standing (design language v2 §9.29's hub-button
 * rule, the one rule for every button the row's width tiers – the media hub's, Home's): the
 * button is tiered by the row's width exactly as the pill's chips are, never by the active tab
 * or by a setting – at the 240 sidebar it folds (the hub into the app menu's "Media Controls…"
 * row, Home away, its row in Customise toolbar reading "Hidden at this width."; §10.5) – and it
 * returns where the pill, with the button's own slot back in the row, still holds the box the
 * star and the tools return at: the tier's `PILL_TOOLS_TIER` content box (110, the
 * stylesheet's `@container (width < 110px)`; §9.29's "130 px pill"), 126 in the row's
 * `PILL_PADDING`. Never where the pill first reaches that box without the button: a button
 * returning there took the pill straight back under the tier it had just met (270 gave 125 →
 * 94, and the address gave way to the title) and flipped its reading – the FIRST LINE's finding
 * on #572, where Home at the 240 sidebar took the pill from 96 to 64 and the title to "S…".
 */
export const FOLDING_BUTTON_PILL = PILL_PADDING + PILL_TOOLS_TIER

/** A toolbar button's pitch in the row: its box and the gap before it (§5, 28 + 4). */
const TOOLBAR_SLOT = TOOLBAR_BUTTON + TOOLBAR_GAP

/**
 * The row width at which a folding button returns, given the count of the row's other buttons:
 * the pill's tier box, the other buttons' slots and the button's own. With the four always-there
 * buttons (back, forward, reload, ⋯) that is 286 – the 302 sidebar, its 8 px gutters aside –
 * where the pill with the button is 126 and the star is up with it; at 301 it would be 125.
 * Each further button in the row moves the return one slot (32) out.
 */
export function foldingButtonReturnRow(otherButtons: number): number {
  return FOLDING_BUTTON_PILL + (otherButtons + 1) * TOOLBAR_SLOT
}

/**
 * Whether the row is wide enough for a folding button: the pill the row would give its other
 * buttons – back, forward, reload, ⋯, the puzzle piece and the downloads button while they are
 * up, and any folding button that has already returned; not the pinned actions, which fold by
 * the pill's own floor – and the button's own slot still holds `FOLDING_BUTTON_PILL`. The
 * button's slot is in the sum, so the pill reads the same on either side of the return: at 302
 * the button arrives over a 126 pill, the star up; at 270, where the star returned over the same
 * 126, the button leaves it so. An unmeasured row (0) shows the button, as the pinned actions
 * show before the row has a width. Pure, for the unit tests; the row measures itself and asks.
 */
export function foldingButtonFits(rowWidth: number, otherButtons: number): boolean {
  if (rowWidth <= 0) return true
  return rowWidth >= foldingButtonReturnRow(otherButtons)
}

/**
 * Which pinned controls the bar's width tier has hidden right now (design language v2 §9.29:
 * the pill's chips, the media hub's button and Home fold by the row's width, never by a
 * setting), published from `NavRow`'s layout phase and read by the Customise toolbar dialog,
 * whose row for such a control stays checked and says "Hidden at this width." (the lead's spec
 * in §10.5). Empty until a row has laid out; a row unmounting clears what it published.
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

/**
 * The controls folded away, in the bar's order – Home among them at rest, since it is folded by
 * default (`toolbarDefaultPinned`). The Settings row counts departures from the default bar
 * instead (`toolbarDepartures`), a shown Home included.
 */
export function foldedControls(pins: UIState['settings']['toolbarPins']): ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter((control) => !toolbarPinned(pins, control))
}

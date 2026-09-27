import type { UIState } from '@shared/types'
import { toolbarPinned, type ToolbarPins } from '@shared/toolbarPins'
import { run } from '@renderer/lib/api'
import { mediaHubButtonFits } from '@renderer/lib/mediaHub'
import { createStore } from '@renderer/lib/store'

/**
 * The desktop toolbar's Energy Saver leaf (W8-2, settings-29; Chrome's `BatterySaverButton` and
 * its `BatterySaverBubbleView`): the leaf glyph in the toolbar row while the mode is on – the
 * governor's word, `ResourceSnapshot.system.energySaver`, which is `Settings.energySaver` met by
 * the power state (`core/resources/energySaver.ts`) – and the bubble under it, "Energy Saver is
 * on" with the one sentence on what that does here and Chrome's "Turn off now" for the battery
 * session. The button is a pin like the hub's (`shared/toolbarPins.ts`, `energy-saver`): unpinned
 * it is not drawn and the mode runs on, Settings › Performance saying so; pinned, it is tiered
 * by the row's width as the hub's button is (`energySaverLeafFits`). This module is the leaf's
 * own state (the media hub's shape, `lib/mediaHub.ts`): what it reads of the snapshot, the
 * bubble's open state, and its opener's selector for the anchor and the keyboard's return.
 */

export interface EnergySaverUi {
  /** The bubble is up. */
  open: boolean
  /** It was opened with the keyboard on the leaf: the page had no focus to get back (§9.22). */
  fromKeyboard: boolean
  /**
   * The leaf is in the row and laid out, published by the button from the commit that mounts
   * or unmounts it (`EnergySaverButton`; the hub's `mediaHubUi.buttonUp`). The bubble closes on
   * it: the row's width tier folding the leaf – a sidebar drag, a button joining the row – is
   * no state push, and a bubble hanging from a leaf that has gone would float unanchored.
   */
  leafUp: boolean
}

export const energySaverUi = createStore<EnergySaverUi>(
  { open: false, fromKeyboard: false, leafUp: false },
  'energy-saver-ui'
)

/** Chrome's one line for the button, its accessible name and the bubble's title alike. */
export const ENERGY_SAVER_TITLE = 'Energy Saver is on'

/** Chrome's "Turn off now": off for this battery session, the setting untouched. */
export const ENERGY_SAVER_TURN_OFF = 'Turn off now'

/** The toolbar button the bubble hangs from and returns the keyboard to (§9.22). */
export const ENERGY_SAVER_BUTTON = '[data-zen-energy-saver-button]'

/**
 * Whether Energy Saver is on now: the governor's word, not the setting's – the setting names a
 * condition (unplugged, under 20 %), the snapshot says whether it is met and no "Turn off now"
 * stands. A partial state in a test (no snapshot) reads off.
 */
export function energySaverOn(state: UIState): boolean {
  return Boolean(state.resources?.system.energySaver)
}

/** The leaf is the row's to draw: the mode is on and the control is pinned (the desktop's pins, `pinsFor`). */
export function energySaverLeafUp(state: UIState, pins: ToolbarPins | undefined): boolean {
  return energySaverOn(state) && toolbarPinned(pins, 'energy-saver')
}

/**
 * Whether the row is wide enough for the leaf (pr-584 L2; design language v2 §9.29): the hub's
 * rule, one floor for both tiered buttons – the pill the row would give its other buttons and
 * the leaf's own slot must still hold `MEDIA_HUB_PILL`, the 126 (110 in the row's padding) at
 * which the star and the tools return to the pill, so the pill reads the same on either side of
 * the leaf's return. With the four always-there buttons (back, forward, reload, ⋯) that is the
 * 282 row – the 298 sidebar, the pill's `PILL_BLEED` counted – and 32 more for each button
 * beside them (the puzzle piece, the downloads button); at the 240 sidebar the leaf folds.
 * Chrome's `BatterySaverButton` is not tiered, but Chrome's toolbar has no pill to keep; here
 * the leaf took the 240 pill from "Settings" to "S…" (96 → 64, in the row's arithmetic before
 * W8-F7's 100 pill). The leaf stands where the hub folds: `NavRow` counts the leaf
 * among the buttons the hub makes room against and not the hub among the leaf's, so at a width
 * with room for one of them the leaf – the state the user is in – is the one drawn, and the hub
 * keeps its fold home in the app menu's "Media Controls…" row, which the leaf has none of
 * (Chrome has no menu row for it either; the mode runs on, and the Customise toolbar row says
 * "Hidden at this width."). An unmeasured row (0) shows the leaf, as the hub's rule shows its
 * button. Pure, for the unit tests; the row measures itself and asks.
 */
export function energySaverLeafFits(rowWidth: number, otherButtons: number): boolean {
  return mediaHubButtonFits(rowWidth, otherButtons)
}

/**
 * The bubble's sentence under its title: Chrome's says what Chrome limits
 * (`IDS_BATTERY_SAVER_BUBBLE_DESCRIPTION`: "Background activity and some visual effects, like
 * smooth scrolling, may be limited"); Zenium's says what Zenium does (§9.1), in the user's words
 * – what a background tab feels, not the governor's budgets that do it (pr-584 N3) – and for
 * how long, the clause that was the Turn off now row's own line before that row became the
 * one-line action (pr-584 L3): the mode runs while the computer is on its battery, so the end
 * the user can bring about is plugging in (the lead's "until your computer is unplugged" is the
 * turn-off's span – off until the next unplug – and the computer is already unplugged while
 * this bubble is up; the clause is put the way round that is true). Two lines of the 320
 * notice's 15/20 (pr-584 N4; the title block's text column is 260 after the leaf, about 34
 * characters a line; the lead's clause in full ran to a third). How far the budgets shrink is
 * Settings › Performance's row to say (`resources.batteryFactor`), not the bubble's.
 */
export const ENERGY_SAVER_DETAIL =
  'Background tabs are slowed and unloaded sooner until you plug in.'

/**
 * The leaf while it is in the row and laid out (a button without a box is no anchor): what the
 * bubble hangs from and gives the keyboard back to. Looked up on each use – the row remounts its
 * buttons with the tab and the snapshot.
 */
export function energySaverAnchor(): HTMLElement | null {
  const button = document.querySelector<HTMLElement>(ENERGY_SAVER_BUTTON)
  return button?.checkVisibility() ? button : null
}

/** Open the bubble from its leaf; the bubble captures the page itself (`useFloatingChrome`). */
export function openEnergySaverBubble({
  fromKeyboard = false
}: { fromKeyboard?: boolean } = {}): void {
  if (fromKeyboard) run('focus.chrome', undefined)
  energySaverUi.set({ open: true, fromKeyboard })
}

export function closeEnergySaverBubble(): void {
  if (energySaverUi.get().open) energySaverUi.set({ open: false })
}

/** The leaf's press: close an open bubble (the keyboard stays on the leaf), else open it. */
export function toggleEnergySaverBubble({
  fromKeyboard = false
}: { fromKeyboard?: boolean } = {}): void {
  if (energySaverUi.get().open) closeEnergySaverBubble()
  else openEnergySaverBubble({ fromKeyboard })
}

/**
 * Chrome's "Turn off now" (`SetTemporaryBatterySaverDisabledForSession`): the governor drops the
 * mode for this battery session – until the charger is plugged in or the setting is changed –
 * and re-samples, so the leaf leaves with the mode; the setting itself is not written.
 */
export function turnOffEnergySaverForSession(): void {
  run('resources.energySaverSession', { disabled: true })
}

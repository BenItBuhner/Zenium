import type { UIState } from '@shared/types'
import { toolbarPinned, type ToolbarPins } from '@shared/toolbarPins'
import { run } from '@renderer/lib/api'
import { createStore } from '@renderer/lib/store'

/**
 * The desktop toolbar's Energy Saver leaf (W8-2, settings-29; Chrome's `BatterySaverButton` and
 * its `BatterySaverBubbleView`): the leaf glyph in the toolbar row while the mode is on – the
 * governor's word, `ResourceSnapshot.system.energySaver`, which is `Settings.energySaver` met by
 * the power state (`core/resources/energySaver.ts`) – and the bubble under it, "Energy Saver is
 * on" with the one sentence on what that does here and Chrome's "Turn off now" for the battery
 * session. The button is a pin like the hub's (`shared/toolbarPins.ts`, `energy-saver`): unpinned
 * it is not drawn and the mode runs on, Settings › Performance saying so. This module is the
 * leaf's own state (the media hub's shape, `lib/mediaHub.ts`): what it reads of the snapshot,
 * the bubble's open state, and its opener's selector for the anchor and the keyboard's return.
 */

export interface EnergySaverUi {
  /** The bubble is up. */
  open: boolean
  /** It was opened with the keyboard on the leaf: the page had no focus to get back (§9.22). */
  fromKeyboard: boolean
}

export const energySaverUi = createStore<EnergySaverUi>(
  { open: false, fromKeyboard: false },
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

/** The leaf is in the row: the mode is on and the control is pinned (the desktop's pins, `pinsFor`). */
export function energySaverLeafUp(state: UIState, pins: ToolbarPins | undefined): boolean {
  return energySaverOn(state) && toolbarPinned(pins, 'energy-saver')
}

/**
 * The bubble's sentence under its title: Chrome's says what Chrome limits ("Background activity
 * and some visual effects, like smooth scrolling, may be limited"); Zenium's says what Zenium
 * does (§9.1) – the resource governor's budgets shrink to the factor Settings › Performance
 * holds (`resources.batteryFactor`; `deriveBudgets`), so background tabs are throttled and
 * unloaded sooner than they would be plugged in.
 */
export function energySaverDetail(state: UIState): string {
  const percent = Math.round((state.settings.resources?.batteryFactor ?? 1) * 100)
  return `Zenium shrinks its memory, CPU and GPU budgets to ${percent}%, so background tabs are throttled and unloaded sooner.`
}

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

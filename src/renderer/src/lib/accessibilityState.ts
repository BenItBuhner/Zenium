import { createStore } from './store'

/**
 * The device's accessibility state as the host reports it (A11Y-04): whether a service explores
 * the screen by touch (TalkBack; `AccessibilityManager.isTouchExplorationEnabled`) and the
 * system font scale (`Configuration.fontScale`). The Android host sends both in the boot
 * payload (`accessibility`) and again as the `accessibility` host event on each change – the
 * touch exploration listener's, the configuration's (`AccessibilityState.kt`, routed in
 * `boot.ts`); a host from before the field is read through its `touchExploration` flag and the
 * environment's `fontScale`. The chrome's alone: the core has no part in it.
 *
 * What reads it: the phone app menu's icon row (`MenuSheet`), which under either condition
 * becomes a list of §10.3 rows – the glyph leading, the label as the visible text, the row's
 * full width as the target – with the same items, actions and names as the row of icon buttons
 * (the names are harness contracts: `MenuIconRowDemo` reads them). TalkBack's user explores by
 * touch and hears each stop: a row with its label under the finger is one stop, a 44 px glyph
 * among six is a hunt; the large-text user reads labels the glyph row does not draw. The bar
 * that hides on scroll reads the touch exploration flag through its own setter (`lib/barHide.ts`),
 * fed from the same listener.
 */
export interface AccessibilityState {
  /** An accessibility service explores the screen by touch (TalkBack). */
  touchExploration: boolean
  /** The system font scale; 1 at the default size and on hosts without one. */
  fontScale: number
}

export const DEFAULT_ACCESSIBILITY_STATE: AccessibilityState = {
  touchExploration: false,
  fontScale: 1
}

/**
 * The font scale from which the chrome's text counts as large text: Android's own line –
 * "Large text" in Accessibility settings set the scale to 1.3 (the `Largest` step of the
 * four-step font-size setting, the third notch of Android 14's slider), and the same 1.3 is the
 * chrome's first large-text fixture (`ChromeA11yDemo.fontScaleScene`, the preview's
 * `?fontScale=1.3`). Below it every label is written to fit its line (`lib/textScale.ts`).
 */
export const LARGE_TEXT_FONT_SCALE = 1.3

export const accessibilityStore = createStore<AccessibilityState>(
  DEFAULT_ACCESSIBILITY_STATE,
  'accessibility-state'
)

/**
 * The state a host's payload describes, field by field: a flag that is not a boolean and a scale
 * that is not a finite positive number are left as they were, so a partial or malformed event
 * never turns the list variant on or off for a value that means nothing.
 */
export function accessibilityStateOf(
  payload: unknown,
  previous: AccessibilityState = DEFAULT_ACCESSIBILITY_STATE
): AccessibilityState {
  const raw = (payload ?? {}) as Partial<Record<keyof AccessibilityState, unknown>>
  const scale = Number(raw.fontScale)
  return {
    touchExploration:
      typeof raw.touchExploration === 'boolean' ? raw.touchExploration : previous.touchExploration,
    fontScale: Number.isFinite(scale) && scale > 0 ? scale : previous.fontScale
  }
}

/** The host's word, at boot and on every `accessibility` event. */
export function applyAccessibilityState(payload: unknown): void {
  accessibilityStore.set(accessibilityStateOf(payload, accessibilityStore.get()))
}

/**
 * The scale counts as large text (`LARGE_TEXT_FONT_SCALE`). Compared to the hundredth: the
 * setting is a float on the host (1.3f is 1.2999999523… widened), and a threshold met by the
 * number the user set must not be missed by the float's remainder.
 */
export function largeText(fontScale: number): boolean {
  return Math.round(fontScale * 100) >= Math.round(LARGE_TEXT_FONT_SCALE * 100)
}

/**
 * The phone app menu draws its icon row as a labelled list (A11Y-04): under touch exploration,
 * or at large text.
 */
export function menuAsList(state: AccessibilityState): boolean {
  return state.touchExploration || largeText(state.fontScale)
}

/** `menuAsList` of the state in force, live. */
export function useMenuAsList(): boolean {
  return accessibilityStore.use(menuAsList)
}

/** For tests: the resting state. */
export function resetAccessibilityState(): void {
  accessibilityStore.set(DEFAULT_ACCESSIBILITY_STATE)
}

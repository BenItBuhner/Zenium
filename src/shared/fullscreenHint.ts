import { TOAST_SHOW_MS } from './toastCard'

/*
 * The fullscreen hints (Chrome's exclusive-access bubble): "Press F11 to exit full screen" when
 * the window goes fullscreen, "<host> is now full screen" with the way out when a page puts an
 * element in fullscreen. A fullscreen page covers the whole window, chrome included, so the
 * hint is drawn inside the page (the page script puts it in the top layer, over the fullscreen
 * element); this module is the text and the timing the core decides, and the look the page
 * script gives it, shared so both sides and the tests agree.
 */

/** Which key gets out, set apart from the words around it as a key cap. */
export interface HintExit {
  before: string
  key: string
  after: string
}

export interface PageHint {
  /** The first line ("example.com is now full screen"); null when the exit line says it all. */
  text: string | null
  /** The way out, with its key as a key cap; null for a hint without one. */
  exit: HintExit | null
  /** How long the hint stands before it fades (ms). */
  duration: number
  /** The chrome's colour scheme, for the hint's colours. */
  dark: boolean
  /**
   * Its shape: Chrome's exclusive-access bubble centred at the top (the default), or the phone
   * chrome's toast card (v2 §9.33) along the bottom edge, as the shared `ToastCard` draws it.
   */
  kind?: 'bubble' | 'toast'
}

/**
 * The phone's first-time hint for a page in fullscreen (GN-20): how to leave, in Chrome for
 * Android's words. A toast without an action, shown once (`settings.fullscreenHintDone`).
 */
export const FULLSCREEN_EXIT_HINT = 'Swipe down or press back to exit full screen'
/** How long a toast without an action stands (§9.33's 2.8 s, the chrome's `TOAST_DURATION`: one number, `toastCard.ts`). */
export { TOAST_SHOW_MS }

/** The hint for a video in fullscreen on the phone: the chrome's toast, drawn in the page. */
export function fullscreenExitHint(dark: boolean): PageHint {
  return { text: FULLSCREEN_EXIT_HINT, exit: null, duration: TOAST_SHOW_MS, dark, kind: 'toast' }
}

/** Chrome waits this long after entering fullscreen before the bubble shows (`kShowExitBubbleTime`). */
export const HINT_DELAY_MS = 500
/** How long the bubble stands (`ExclusiveAccessBubble::kShowTime`). */
export const HINT_SHOW_MS = 3800
/** A site that showed the bubble does not show it again for this long (`kSnoozeTime`). */
export const HINT_SNOOZE_MS = 15 * 60 * 1000
/** The hint's fade, in and out (the fixed-duration fade is the only motion it has). */
export const HINT_FADE_MS = 300

/** The hint for the window's own fullscreen (F11; the platform's binding on macOS). */
export function browserFullscreenHint(shortcut: string, dark: boolean): PageHint {
  return {
    text: null,
    exit: { before: 'Press ', key: shortcut, after: ' to exit full screen' },
    duration: HINT_SHOW_MS,
    dark
  }
}

/**
 * The hint for a page's element in fullscreen: how to leave – Esc, or Esc held while the page
 * has the keyboard locked (a short press then does nothing, as in Chrome). One line, the same
 * shape as the window's own hint; the site is not named (Chrome's bubble stopped naming it).
 */
export function htmlFullscreenHint(keyboardLocked: boolean, dark: boolean): PageHint {
  return {
    text: null,
    exit: keyboardLocked
      ? { before: 'Press and hold ', key: 'Esc', after: ' to exit full screen' }
      : { before: 'Press ', key: 'Esc', after: ' to exit full screen' },
    duration: HINT_SHOW_MS,
    dark
  }
}

/** The bubble's height (px): a §9.20 panel pill, one 15/20 line with 6 above and below. */
export const HINT_BUBBLE_HEIGHT_PX = 32
/** From the window's top edge to the bubble's box (px). */
export const HINT_BUBBLE_TOP_PX = 24

/**
 * The v2 toast surface as the page script paints it: the chrome's `--v2-panel`, `--v2-border`
 * and `--v2-text` tokens by value (a page cannot read the chrome's stylesheet), one family per
 * scheme. `v2Tokens.test.ts` keeps them equal to the stylesheet.
 */
export const HINT_PALETTE = {
  light: {
    panel: '#f4f4f4',
    border: 'rgb(0 0 0 / 0.15)',
    text: '#15141a',
    fill: 'rgb(21 20 26 / 0.1)'
  },
  dark: {
    panel: '#1f1f1f',
    border: 'rgb(255 255 255 / 0.12)',
    text: '#fbfbfe',
    fill: 'rgb(251 251 254 / 0.1)'
  }
} as const

export type HintPalette = (typeof HINT_PALETTE)[keyof typeof HINT_PALETTE]

export function hintPalette(dark: boolean): HintPalette {
  return dark ? HINT_PALETTE.dark : HINT_PALETTE.light
}

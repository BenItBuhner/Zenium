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
 * The hint for a page's element in fullscreen: the site's host and how to leave – Esc, or Esc
 * held while the page has the keyboard locked (a short press then does nothing, as in Chrome).
 */
export function htmlFullscreenHint(host: string, keyboardLocked: boolean, dark: boolean): PageHint {
  return {
    text: `${host} is now full screen`,
    exit: keyboardLocked
      ? { before: 'To exit full screen, press and hold ', key: 'Esc', after: '' }
      : { before: 'Press ', key: 'Esc', after: ' to exit' },
    duration: HINT_SHOW_MS,
    dark
  }
}

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

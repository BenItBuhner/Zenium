/*
 * The v2 toast card's numbers (design language v2 §9.33), one source for the two places that
 * draw it: the chrome's `ToastCard` (its stylesheet reads the same values through the `--v2-*`
 * tokens; `v2Tokens.test.ts` holds the two equal) and the fullscreen exit hint the page script
 * paints in the page's top layer (`pageHint.ts`) – the single §9.33 exception, since in
 * fullscreen the chrome is under the page's view and cannot draw there. The chrome's own
 * constants (`lib/ui.ts`, `messages/stack.ts`, `useMessageMotion.ts`, `useFullscreenReturn.ts`)
 * read from here rather than restating a number.
 */

/** The card's geometry: what a twin must share with the chrome's `.zen-message`. */
export const TOAST_CARD = {
  /** From the frame's edges, on every side (`--zen-message-inset`). */
  insetPx: 8,
  /**
   * The most a card spans (`--zen-message-max-width`): where the frame is wider – a phone
   * turned landscape, rotate-to-fullscreen's common case – the card caps here and centres, as
   * Material's snackbar and Chrome's message cards do (§9.33, amended at PR #366's gate);
   * banners take the same cap.
   */
  maxWidthPx: 560,
  /** The row's height on a phone (`--v2-row`): a toast with nothing but its text is one row tall. */
  rowPx: 44,
  /** The card radius (`--v2-radius-card`). */
  radiusPx: 8,
  /** The panel shadow (`--v2-shadow-panel`). */
  shadow: '0 2px 6px rgb(0 0 0 / 0.2)',
  /** The card's padding on the text's side (`.zen-message`), inside its 1 px hairline. */
  gutterPx: 14,
  /** The card's vertical padding around its row (`.zen-message`). */
  padPx: 3,
  /** Between the text and a control beside it (`.zen-message`). */
  gapPx: 8,
  /** The body type (§4: `--v2-font-body`, `--v2-line-body`, `--v2-weight-body`). */
  fontPx: 15,
  linePx: 20,
  weight: 400
} as const

/** A toast without an action stands this long (§9.33's 2.8 s). */
export const TOAST_SHOW_MS = 2800

/** §11.3: with motion reduced, an appearance or a departure is a fade in place this long. */
export const REDUCED_FADE_MS = 120

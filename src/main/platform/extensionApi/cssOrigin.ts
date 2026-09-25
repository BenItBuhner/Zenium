import type { InsertedCssOrigin } from '../../../core/platform'

/**
 * The cascade origin a host-injected stylesheet is inserted with.
 *
 * Blink never paints a `::highlight(name)` rule that reaches the page in a user-origin sheet
 * (`webContents.insertCSS(css, { cssOrigin: 'user' })`, which is where an extension's
 * `tabs.insertCSS({ cssOrigin: 'user' })` lands): the sheet is active – its ordinary rules apply –
 * and the highlight pseudo-element rules alone are dropped, while the same rules in an author
 * sheet paint. Measured on Electron 44 / Chromium 152 (`docs/upstream-reports/
 * blink-highlight-pseudo-user-origin-sheets.md`); read aloud inserts its own highlight sheet as
 * `author` for the same reason. So a `user` request for a sheet that styles a registered
 * highlight is promoted to `author`, the only origin the rules paint from; anything else keeps
 * the origin asked for.
 */
export function cssOriginFor(css: string, requested: InsertedCssOrigin): InsertedCssOrigin {
  if (requested === 'author') return 'author'
  return hasHighlightRule(css) ? 'author' : 'user'
}

/**
 * Whether the sheet holds a `::highlight(` selector outside its comments, in any case
 * (`::HIGHLIGHT(` is the same pseudo-element to the parser). A commented-out rule is not a rule.
 */
export function hasHighlightRule(css: string): boolean {
  return /::highlight\(/i.test(stripComments(css))
}

/** The sheet without its `/* … *\/` comments (an unterminated one runs to the end, as in CSS). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
}

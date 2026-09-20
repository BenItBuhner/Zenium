/**
 * The preview host's stand-in for the chrome WebView's `textZoom` (`ChromeTextScale.kt`): a
 * desktop browser has no text zoom, so the font sizes the stylesheets declare are multiplied at
 * the rule – `font-size: 15px` becomes `calc(15px * 1.3)` – which is what the WebView's zoom does
 * to a computed font size. What the zoom leaves alone is left alone here too: lengths in every
 * other property (`em` and `rem` resolve against the unzoomed size in Blink), a relative size
 * (`em`, `%`, `smaller`) that inherits an already multiplied parent, and the keyword sizes. Rules
 * on the root are skipped so `rem` keeps its base. Inline `style` sizes are not rewritten – the
 * WebView zooms them, the preview does not – and a `font` shorthand is read through its longhand.
 *
 * Applied to every stylesheet in the document and again to the ones the dev server adds or
 * replaces afterwards (HMR), so a capture at `?fontScale=1.3` needs no reload dance.
 */

const MARK = '--zen-preview-text-zoom'

/** A size the zoom multiplies: px, pt, rem, a `var()` or a `calc()` without a relative unit. */
const ABSOLUTE = /^(?:-?\d*\.?\d+(?:px|pt|rem)|var\(.*\)|calc\(.*\))$/
/** A relative size or keyword anywhere in the value (a `calc(1em …)`, a `var(--x, 100%)` fallback). */
const RELATIVE =
  /(?:\d|\))(?:em|ex|ch|ic|cap|lh|%)(?![\w-])|\b(?:smaller|larger|inherit|initial|unset)\b/

export function zoomedFontSize(value: string, zoom: number): string | null {
  const size = value.trim()
  if (!size || !ABSOLUTE.test(size) || RELATIVE.test(size)) return null
  return `calc(${size} * ${zoom})`
}

function rootSelector(selector: string): boolean {
  return /(^|,)\s*(?::root|html)\s*(?:,|$)/.test(selector)
}

function zoomRule(rule: CSSRule, zoom: number): void {
  if (rule instanceof CSSStyleRule) {
    const style = rule.style
    if (style.getPropertyValue(MARK) || rootSelector(rule.selectorText)) return
    const size = style.getPropertyValue('font-size')
    const zoomed = zoomedFontSize(size, zoom)
    if (zoomed) {
      const priority = style.getPropertyPriority('font-size')
      style.setProperty('font-size', zoomed, priority)
      style.setProperty(MARK, String(zoom))
    }
    // Nested rules (CSS nesting) live on the style rule itself.
    zoomRules((rule as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules, zoom)
    return
  }
  if (rule instanceof CSSImportRule) {
    zoomSheet(rule.styleSheet, zoom)
    return
  }
  if (rule instanceof CSSGroupingRule) zoomRules(rule.cssRules, zoom)
}

function zoomRules(rules: CSSRuleList | undefined, zoom: number): void {
  if (!rules) return
  for (let i = 0; i < rules.length; i++) zoomRule(rules[i]!, zoom)
}

function zoomSheet(sheet: CSSStyleSheet | null, zoom: number): void {
  if (!sheet) return
  let rules: CSSRuleList
  try {
    rules = sheet.cssRules
  } catch {
    // A cross-origin sheet cannot be read (nor would the chrome ship one).
    return
  }
  zoomRules(rules, zoom)
}

function zoomDocument(zoom: number): void {
  for (let i = 0; i < document.styleSheets.length; i++) zoomSheet(document.styleSheets[i]!, zoom)
}

/**
 * Multiply every declared font size in the document by `zoom` (1 does nothing), now and as
 * stylesheets arrive. Called once by the preview bridge with the `?fontScale=` (or `?textZoom=`)
 * the capture asked for.
 */
export function emulateTextZoom(zoom: number): void {
  if (typeof document === 'undefined' || !(zoom > 0) || zoom === 1) return
  const apply = (): void => zoomDocument(zoom)
  apply()
  // A `<style>` the dev server adds to the head later, or one whose text it replaces on an
  // update: the fresh rules are unmarked and get the zoom on the next frame. Only the head is
  // watched – the chrome's own renders in the body are not stylesheet changes.
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      apply()
    })
  })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  document.addEventListener('DOMContentLoaded', apply)
  window.addEventListener('load', apply)
}

import type { PageEnvironment } from '@shared/types'

/**
 * The chrome's text follows the system font size and the bold-text setting (A11Y-05).
 *
 * The host draws the chrome's text bigger on its own (Android: the chrome WebView's `textZoom`,
 * `ChromeTextScale.kt`) – a zoom that moves text alone, no length or glyph with it – and says by
 * how much in `environment.textZoom`. The chrome puts that factor on the root as
 * `--zen-text-zoom`. Blink zooms a `line-height` length with the text, so the v2 line tokens
 * (`--v2-line-*`, `main.css`) stay px literals for `line-height`; their `--v2-line-*-box` twins
 * are `calc`s on the factor for the box model, so every row built on a line box (`--v2-row`,
 * `--v2-row-two-line`, `--v2-menu-row`) grows with the text while controls (`--v2-control`,
 * `--v2-icon-button`), glyphs and box-to-box distances hold. The bold-text setting arrives as a weight adjustment
 * (`--zen-font-weight-adjustment`, 300 when on) that the weight tokens add to themselves.
 *
 * Hosts that scale no text (the desktop, the preview without `?fontScale=`) leave both at their
 * defaults, and the stylesheet computes to the same pixels as before.
 */
export interface ChromeTextScale {
  /** The factor the text is drawn at; 1 at the system's default size. */
  zoom: number
  /** The bold-text setting's weight adjustment; 0 when off. */
  weightAdjustment: number
}

export const DEFAULT_TEXT_SCALE: ChromeTextScale = { zoom: 1, weightAdjustment: 0 }

/** What the WebView accepts as a text zoom, as a factor (`ChromeTextScale.MIN_PERCENT` / `MAX_PERCENT`). */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3

/**
 * The zoom from which a tab card's title takes two lines (v2 §4, §9.2, the ruling on #237): one
 * line to 1.3, where about nine characters still read; two from 1.5 up, the card's header
 * growing by a line and the preview giving the room.
 */
export const TWO_LINE_TITLE_ZOOM = 1.5

/**
 * The stylesheet's word for the zoom, on the root as `data-text-scale` (§4 / §9.2): absent at
 * the default size and below, where every label is written to fit its line; `large` above it,
 * where a row's label may wrap to a second line before its ellipsis; `larger` from
 * `TWO_LINE_TITLE_ZOOM`, where a tab card's title takes two lines as well.
 */
export function textScaleStep(zoom: number): 'large' | 'larger' | null {
  if (zoom >= TWO_LINE_TITLE_ZOOM) return 'larger'
  if (zoom > 1) return 'large'
  return null
}

/** The scale a host's environment describes; missing or malformed fields mean the default. */
export function textScaleOf(
  environment: Partial<PageEnvironment> | null | undefined
): ChromeTextScale {
  const zoom = Number(environment?.textZoom)
  const weight = Number(environment?.fontWeightAdjustment)
  return {
    zoom: Number.isFinite(zoom) && zoom > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1,
    weightAdjustment: Number.isFinite(weight)
      ? Math.round(Math.min(300, Math.max(-300, weight)))
      : 0
  }
}

/** The root's custom properties for `scale`, as `applyTextScale` writes them. */
export function textScaleProperties(scale: ChromeTextScale): Record<string, string> {
  return {
    '--zen-text-zoom': String(Math.round(scale.zoom * 100) / 100),
    '--zen-font-weight-adjustment': String(scale.weightAdjustment)
  }
}

let current: ChromeTextScale = DEFAULT_TEXT_SCALE

/** The scale in force, for surfaces that measure in JS (a sheet's content height, a card's text). */
export function currentTextScale(): ChromeTextScale {
  return current
}

/**
 * Put the host's text scale on the document root: at boot from the boot payload's environment
 * and again on every `environment` event (a font-size or bold-text change is a configuration
 * change). Also writes `data-text-zoom` ("100", "130", "180"…) for drivers and
 * `data-text-scale` (`textScaleStep`) for the stylesheet's two-line rules.
 */
export function applyTextScale(environment: Partial<PageEnvironment> | null | undefined): void {
  const scale = textScaleOf(environment)
  current = scale
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [name, value] of Object.entries(textScaleProperties(scale))) {
    if (value === textScaleProperties(DEFAULT_TEXT_SCALE)[name]) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }
  root.dataset.textZoom = String(Math.round(scale.zoom * 100))
  const step = textScaleStep(scale.zoom)
  if (step) root.dataset.textScale = step
  else delete root.dataset.textScale
  if (scale.weightAdjustment > 0) root.dataset.boldText = 'true'
  else delete root.dataset.boldText
}

/**
 * Reader View's text preferences (Chrome's Reading mode "Font" / "Font size" / "Color", Firefox's
 * "Content width"): one setting the core persists, the `zen://reader` page is rendered with, and
 * both the page's own toolbar and the chrome's sheet / popover change through
 * `reader.setPreferences`. Pure model here; the page applies it as `data-*` attributes on its root.
 */
export type ReaderFont = 'serif' | 'sans' | 'mono'
/** `auto` follows the browser's colour scheme (the page's `prefers-color-scheme`). */
export type ReaderTheme = 'auto' | 'light' | 'sepia' | 'dark'
export type ReaderWidth = 'narrow' | 'normal' | 'wide'
/**
 * Line focus (EDGE-13, Edge's Immersive Reader): a dimmed mask over everything but a band of
 * this many lines, following the read-aloud sentence while it plays and the click / keyboard
 * otherwise; 0 is off.
 */
export type ReaderLineFocus = 0 | 1 | 3 | 5
/** Text spacing (EDGE-13): letter, word and line spacing together, in Edge's three steps. */
export type ReaderSpacing = 'normal' | 'wide' | 'wider'

export interface ReaderPreferences {
  /** Body text size in CSS px, one of `READER_FONT_SIZES`. */
  fontSize: number
  font: ReaderFont
  theme: ReaderTheme
  width: ReaderWidth
  lineFocus: ReaderLineFocus
  spacing: ReaderSpacing
  /** Syllable boundaries marked inside words (English heuristic; `readerExtras.ts`). */
  syllables: boolean
}

/** The ladder the A− / A+ steps and the size slider walk. */
export const READER_FONT_SIZES: readonly number[] = [14, 15, 16, 17, 18, 20, 22, 24, 28]
export const READER_FONTS: readonly ReaderFont[] = ['serif', 'sans', 'mono']
export const READER_THEMES: readonly ReaderTheme[] = ['auto', 'light', 'sepia', 'dark']
export const READER_WIDTHS: readonly ReaderWidth[] = ['narrow', 'normal', 'wide']
export const READER_LINE_FOCUS: readonly ReaderLineFocus[] = [0, 1, 3, 5]
export const READER_SPACINGS: readonly ReaderSpacing[] = ['normal', 'wide', 'wider']

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 18,
  font: 'serif',
  theme: 'auto',
  width: 'normal',
  lineFocus: 0,
  spacing: 'normal',
  syllables: false
}

/** Chrome's labels for the choices (the Reading mode side panel's menus). */
export const READER_FONT_LABELS: Record<ReaderFont, string> = {
  serif: 'Serif',
  sans: 'Sans-serif',
  mono: 'Monospace'
}
export const READER_THEME_LABELS: Record<ReaderTheme, string> = {
  auto: 'Default',
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark'
}
export const READER_WIDTH_LABELS: Record<ReaderWidth, string> = {
  narrow: 'Narrow',
  normal: 'Standard',
  wide: 'Wide'
}
export const READER_LINE_FOCUS_LABELS: Record<ReaderLineFocus, string> = {
  0: 'Off',
  1: '1 line',
  3: '3 lines',
  5: '5 lines'
}
export const READER_SPACING_LABELS: Record<ReaderSpacing, string> = {
  normal: 'Normal',
  wide: 'Wide',
  wider: 'Wider'
}

/** Stored preferences from any version (or a patch from a page) come out complete and valid. */
export function sanitizeReaderPreferences(raw: unknown): ReaderPreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReaderPreferences>
  const d = DEFAULT_READER_PREFERENCES
  return {
    fontSize:
      typeof r.fontSize === 'number' && READER_FONT_SIZES.includes(r.fontSize)
        ? r.fontSize
        : d.fontSize,
    font: READER_FONTS.includes(r.font as ReaderFont) ? (r.font as ReaderFont) : d.font,
    theme: READER_THEMES.includes(r.theme as ReaderTheme) ? (r.theme as ReaderTheme) : d.theme,
    width: READER_WIDTHS.includes(r.width as ReaderWidth) ? (r.width as ReaderWidth) : d.width,
    lineFocus: READER_LINE_FOCUS.includes(r.lineFocus as ReaderLineFocus)
      ? (r.lineFocus as ReaderLineFocus)
      : d.lineFocus,
    spacing: READER_SPACINGS.includes(r.spacing as ReaderSpacing)
      ? (r.spacing as ReaderSpacing)
      : d.spacing,
    syllables: typeof r.syllables === 'boolean' ? r.syllables : d.syllables
  }
}

/**
 * A patch as a page or the chrome sends it: only the keys present are taken, each checked; an
 * unknown or malformed value leaves that key out. Null when nothing usable was sent.
 */
export function readerPreferencesPatch(raw: unknown): Partial<ReaderPreferences> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Record<keyof ReaderPreferences, unknown>>
  const patch: Partial<ReaderPreferences> = {}
  if (typeof r.fontSize === 'number' && READER_FONT_SIZES.includes(r.fontSize))
    patch.fontSize = r.fontSize
  if (READER_FONTS.includes(r.font as ReaderFont)) patch.font = r.font as ReaderFont
  if (READER_THEMES.includes(r.theme as ReaderTheme)) patch.theme = r.theme as ReaderTheme
  if (READER_WIDTHS.includes(r.width as ReaderWidth)) patch.width = r.width as ReaderWidth
  if (READER_LINE_FOCUS.includes(r.lineFocus as ReaderLineFocus))
    patch.lineFocus = r.lineFocus as ReaderLineFocus
  if (READER_SPACINGS.includes(r.spacing as ReaderSpacing))
    patch.spacing = r.spacing as ReaderSpacing
  if (typeof r.syllables === 'boolean') patch.syllables = r.syllables
  return Object.keys(patch).length > 0 ? patch : null
}

/** The next size up (`direction` > 0) or down the ladder; the ends are sticky. */
export function stepReaderFontSize(current: number, direction: number): number {
  const sizes = READER_FONT_SIZES
  let index = sizes.indexOf(current)
  if (index === -1) {
    index = sizes.findIndex((s) => s >= current)
    if (index === -1) index = sizes.length - 1
  }
  const next = Math.max(0, Math.min(sizes.length - 1, index + Math.sign(direction)))
  return sizes[next]
}

/** The key a page posts its toolbar changes under (`window.postMessage`), relayed by the page script. */
export const READER_MESSAGE_KEY = '__zenReader'

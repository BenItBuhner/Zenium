/**
 * Reader View's text preferences (Chrome's Reading mode "Font" / "Font size" / "Color", Firefox's
 * "Content width"): one setting the core persists, the `zen://reader` page is rendered with, and
 * the chrome's sheet / popover (the Text preferences chip's, the one home of these controls;
 * the document carries no toolbar, §10.1) changes through `reader.setPreferences`. Pure model
 * here; the page applies it as `data-*` attributes on its root.
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
/**
 * Line spacing (CT-35; Chrome's Reading mode "Line height" menu, `read_anything.mojom`
 * `LineSpacing`: Standard / Loose / Very loose, the tight step deprecated): the article's
 * line height. Standard is the page's own 1.65.
 */
export type ReaderLineSpacing = 'standard' | 'loose' | 'very-loose'
/**
 * Letter spacing (CT-35; Chrome's "Letter spacing" menu, `LetterSpacing`: Standard / Wide /
 * Very wide): the gap between letters, the word gaps widening with it as Edge's text spacing
 * widened them together.
 */
export type ReaderLetterSpacing = 'standard' | 'wide' | 'very-wide'
/**
 * Edge's one Text spacing step (EDGE-13), the record's key before CT-35 split it into the two
 * rows: kept as a type only for the read-forward of a record written before the split.
 */
export type LegacyReaderSpacing = 'normal' | 'wide' | 'wider'

export interface ReaderPreferences {
  /** Body text size in CSS px, one of `READER_FONT_SIZES`. */
  fontSize: number
  font: ReaderFont
  theme: ReaderTheme
  width: ReaderWidth
  lineFocus: ReaderLineFocus
  lineSpacing: ReaderLineSpacing
  letterSpacing: ReaderLetterSpacing
  /** Syllable boundaries marked inside words (English heuristic; `readerExtras.ts`). */
  syllables: boolean
  /**
   * Chrome's Reading mode "Links" toggle (`read_anything.links_enabled`): off draws the
   * article's links as plain text — still there, no colour, no underline, no click.
   */
  links: boolean
  /** Chrome's "Images" toggle (`read_anything.images_enabled`): off hides the article's images. */
  images: boolean
}

/** The ladder the A− / A+ steps and the size slider walk. */
export const READER_FONT_SIZES: readonly number[] = [14, 15, 16, 17, 18, 20, 22, 24, 28]
export const READER_FONTS: readonly ReaderFont[] = ['serif', 'sans', 'mono']
export const READER_THEMES: readonly ReaderTheme[] = ['auto', 'light', 'sepia', 'dark']
export const READER_WIDTHS: readonly ReaderWidth[] = ['narrow', 'normal', 'wide']
export const READER_LINE_FOCUS: readonly ReaderLineFocus[] = [0, 1, 3, 5]
export const READER_LINE_SPACINGS: readonly ReaderLineSpacing[] = [
  'standard',
  'loose',
  'very-loose'
]
export const READER_LETTER_SPACINGS: readonly ReaderLetterSpacing[] = [
  'standard',
  'wide',
  'very-wide'
]

/**
 * The old key read forward (CT-35): a stored or synced record from before the split carries
 * `spacing` and neither of the two rows' keys, and reads as the pair its one step stood for –
 * normal → Standard / Standard, wide → Loose / Wide, wider → Very loose / Very wide – so a
 * profile or a peer from before the split shows exactly as it did. The key is never written
 * again and nothing is migrated: the read is the whole of it.
 */
export const LEGACY_READER_SPACING: Record<
  LegacyReaderSpacing,
  { lineSpacing: ReaderLineSpacing; letterSpacing: ReaderLetterSpacing }
> = {
  normal: { lineSpacing: 'standard', letterSpacing: 'standard' },
  wide: { lineSpacing: 'loose', letterSpacing: 'wide' },
  wider: { lineSpacing: 'very-loose', letterSpacing: 'very-wide' }
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 18,
  font: 'serif',
  theme: 'auto',
  width: 'normal',
  lineFocus: 0,
  lineSpacing: 'standard',
  letterSpacing: 'standard',
  syllables: false,
  links: true,
  images: true
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
/**
 * Chrome's words for the steps, verbatim (`chrome/app/generated_resources.grd`
 * IDS_READING_MODE_SPACING_COMBOBOX_STANDARD / _LOOSE / _VERY_LOOSE / _WIDE / _VERY_WIDE).
 */
export const READER_LINE_SPACING_LABELS: Record<ReaderLineSpacing, string> = {
  standard: 'Standard',
  loose: 'Loose',
  'very-loose': 'Very loose'
}
export const READER_LETTER_SPACING_LABELS: Record<ReaderLetterSpacing, string> = {
  standard: 'Standard',
  wide: 'Wide',
  'very-wide': 'Very wide'
}

/** The pair an old `spacing` value stands for; null for anything but its three words. */
function legacySpacing(
  raw: unknown
): { lineSpacing: ReaderLineSpacing; letterSpacing: ReaderLetterSpacing } | null {
  return typeof raw === 'string' && raw in LEGACY_READER_SPACING
    ? LEGACY_READER_SPACING[raw as LegacyReaderSpacing]
    : null
}

/**
 * Stored preferences from any version (or a patch from a page) come out complete and valid: a
 * record from before CT-35 reads its one `spacing` forward into the two rows' keys.
 */
export function sanitizeReaderPreferences(raw: unknown): ReaderPreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReaderPreferences> & {
    spacing?: unknown
  }
  const d = DEFAULT_READER_PREFERENCES
  const legacy = legacySpacing(r.spacing)
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
    lineSpacing: READER_LINE_SPACINGS.includes(r.lineSpacing as ReaderLineSpacing)
      ? (r.lineSpacing as ReaderLineSpacing)
      : (legacy?.lineSpacing ?? d.lineSpacing),
    letterSpacing: READER_LETTER_SPACINGS.includes(r.letterSpacing as ReaderLetterSpacing)
      ? (r.letterSpacing as ReaderLetterSpacing)
      : (legacy?.letterSpacing ?? d.letterSpacing),
    syllables: typeof r.syllables === 'boolean' ? r.syllables : d.syllables,
    links: typeof r.links === 'boolean' ? r.links : d.links,
    images: typeof r.images === 'boolean' ? r.images : d.images
  }
}

/**
 * A patch as a page or the chrome sends it: only the keys present are taken, each checked; an
 * unknown or malformed value leaves that key out. Null when nothing usable was sent. A patch
 * from before CT-35 (`spacing`) sets the pair its step stood for, where the patch names
 * neither of the two keys itself.
 */
export function readerPreferencesPatch(raw: unknown): Partial<ReaderPreferences> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Record<keyof ReaderPreferences | 'spacing', unknown>>
  const patch: Partial<ReaderPreferences> = {}
  if (typeof r.fontSize === 'number' && READER_FONT_SIZES.includes(r.fontSize))
    patch.fontSize = r.fontSize
  if (READER_FONTS.includes(r.font as ReaderFont)) patch.font = r.font as ReaderFont
  if (READER_THEMES.includes(r.theme as ReaderTheme)) patch.theme = r.theme as ReaderTheme
  if (READER_WIDTHS.includes(r.width as ReaderWidth)) patch.width = r.width as ReaderWidth
  if (READER_LINE_FOCUS.includes(r.lineFocus as ReaderLineFocus))
    patch.lineFocus = r.lineFocus as ReaderLineFocus
  if (READER_LINE_SPACINGS.includes(r.lineSpacing as ReaderLineSpacing))
    patch.lineSpacing = r.lineSpacing as ReaderLineSpacing
  if (READER_LETTER_SPACINGS.includes(r.letterSpacing as ReaderLetterSpacing))
    patch.letterSpacing = r.letterSpacing as ReaderLetterSpacing
  const legacy = legacySpacing(r.spacing)
  if (legacy && patch.lineSpacing === undefined && patch.letterSpacing === undefined)
    Object.assign(patch, legacy)
  if (typeof r.syllables === 'boolean') patch.syllables = r.syllables
  if (typeof r.links === 'boolean') patch.links = r.links
  if (typeof r.images === 'boolean') patch.images = r.images
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

/**
 * The root attributes the reader page's script renders the extras as (`data-line-focus`,
 * `data-syllables`, `data-line-spacing`, `data-letter-spacing`): the stylesheet applies the two
 * spacings, the page script's `readerExtras.ts` watches the other two and does the DOM work.
 */
export const READER_LINE_FOCUS_ATTRIBUTE = 'data-line-focus'
export const READER_SYLLABLES_ATTRIBUTE = 'data-syllables'
export const READER_LINE_SPACING_ATTRIBUTE = 'data-line-spacing'
export const READER_LETTER_SPACING_ATTRIBUTE = 'data-letter-spacing'
/** `data-links="off"` / `data-images="off"` when the toggle is off; absent while on. */
export const READER_LINKS_ATTRIBUTE = 'data-links'
export const READER_IMAGES_ATTRIBUTE = 'data-images'

/** The syllable mark's class (an empty span; the reader stylesheet draws the dot). */
export const SYLLABLE_MARK_CLASS = 'zen-syl'
/** The line-focus masks' class; `data-edge` says which (`top` / `bottom`). */
export const LINE_FOCUS_MASK_CLASS = 'zen-focus-mask'

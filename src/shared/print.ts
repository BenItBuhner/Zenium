/**
 * The print preview's option model – Chrome's print preview (`chrome://print`) as data: the
 * destination (a system printer or Save as PDF), pages, copies, layout, colour, paper size,
 * margins, scale, two-sided, headers and footers and background graphics, with Chrome's wording
 * for every label and every validation message, the sticky settings Chrome remembers between
 * prints, and the two mappings the desktop host needs: the options `webContents.printToPDF`
 * renders the preview with and the options `webContents.print` sends that render to a printer
 * with (Chrome prints the preview's PDF, and so does this).
 *
 * Pure data shared by the core (`core/print.ts`: sessions, sticky settings, the job), the
 * Electron host (which passes the mapped options straight through) and the renderer (the
 * preview surface, which validates what the user types before asking for a render). Nothing
 * here touches a host API.
 */

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** Where the job goes: a system printer by its device name, or a PDF the user saves. */
export type PrintDestination = { kind: 'pdf' } | { kind: 'printer'; name: string }

/** Chrome's label of the PDF destination. */
export const SAVE_AS_PDF_LABEL = 'Save as PDF'

/** One system printer as the host reports it (`webContents.getPrintersAsync`). */
export interface PrinterDescription {
  /** The device name the job is addressed to (`deviceName`). */
  name: string
  /** What the destination list shows. */
  displayName: string
  description: string
  isDefault: boolean
  /**
   * Whether the printer prints on both sides: read from the CUPS `printer-type` bits where the
   * host has them (Linux, macOS), null when the host cannot tell (Windows). The two-sided option
   * shows for a printer that reports it and hides for one that reports it cannot; an unknown
   * printer is offered the option, as the driver decides in the end.
   */
  duplex: boolean | null
}

/** CUPS `printer-type` bit for a printer that prints on both sides (`CUPS_PRINTER_DUPLEX`, cups.h). */
const CUPS_PRINTER_DUPLEX = 0x10
/** CUPS `printer-type` bit for the server's default destination (`CUPS_PRINTER_DEFAULT`). */
const CUPS_PRINTER_DEFAULT = 0x20000

/** The `printer-type` bit field of a CUPS printer's option map, or null where there is none. */
function printerType(options: Record<string, unknown> | null | undefined): number | null {
  const raw = options?.['printer-type']
  const type = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(type) ? type : null
}

/**
 * Whether a printer prints on both sides, from the option map Chromium reports for it: CUPS
 * hosts carry `printer-type`, a bit field with `CUPS_PRINTER_DUPLEX`; Windows carries nothing
 * that says, so the answer is null there.
 */
export function printerDuplex(options: Record<string, unknown> | null | undefined): boolean | null {
  const type = printerType(options)
  return type === null ? null : (type & CUPS_PRINTER_DUPLEX) !== 0
}

/**
 * Whether a printer is the system's default, from the same map: CUPS marks the server's default
 * destination in `printer-type`; hosts without the field say nothing (false), and a list where
 * no printer says so opens on Save as PDF, as Chrome does without a default printer.
 */
export function printerIsDefault(options: Record<string, unknown> | null | undefined): boolean {
  const type = printerType(options)
  return type !== null && (type & CUPS_PRINTER_DEFAULT) !== 0
}

/** The destination list's label for a destination. */
export function destinationLabel(
  destination: PrintDestination,
  printers: readonly PrinterDescription[]
): string {
  if (destination.kind === 'pdf') return SAVE_AS_PDF_LABEL
  const printer = printers.find((p) => p.name === destination.name)
  return printer?.displayName || destination.name
}

/**
 * The destination a preview opens with: the remembered one when it is still there, else the
 * system's default printer, else Save as PDF (Chrome's order for a first print).
 */
export function initialDestination(
  remembered: PrintDestination | null,
  printers: readonly PrinterDescription[]
): PrintDestination {
  if (remembered?.kind === 'pdf') return remembered
  if (remembered && printers.some((p) => p.name === remembered.name)) return remembered
  const fallback = printers.find((p) => p.isDefault)
  return fallback ? { kind: 'printer', name: fallback.name } : { kind: 'pdf' }
}

/** Whether the two-sided option applies to the destination (a printer that does not deny it). */
export function twoSidedAvailable(
  destination: PrintDestination,
  printers: readonly PrinterDescription[]
): boolean {
  if (destination.kind === 'pdf') return false
  const printer = printers.find((p) => p.name === destination.name)
  return printer ? printer.duplex !== false : true
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Chrome's Pages menu: every page, odd or even pages only, or a typed range. */
export type PrintPagesMode = 'all' | 'odd' | 'even' | 'custom'
export type PrintLayout = 'portrait' | 'landscape'
export type PrintColorMode = 'color' | 'bw'
/** Chrome's Margins menu. `minimum` is the printer's printable area; the preview shows it as none. */
export type PrintMarginsMode = 'default' | 'none' | 'minimum' | 'custom'
export type PrintScaleMode = 'default' | 'custom'
/** Which edge a two-sided job flips on (Chrome's "Flip on long edge" / "Flip on short edge"). */
export type PrintDuplexEdge = 'longEdge' | 'shortEdge'

/** Custom margins, in inches (what `printToPDF` takes; the UI shows them in the locale's unit). */
export interface PrintCustomMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PrintSettings {
  destination: PrintDestination
  pages: { mode: PrintPagesMode; custom: string }
  copies: number
  collate: boolean
  layout: PrintLayout
  color: PrintColorMode
  /** A `PAPER_SIZES` id. */
  paperSize: string
  margins: { mode: PrintMarginsMode; custom: PrintCustomMargins }
  scale: { mode: PrintScaleMode; percent: number }
  twoSided: boolean
  duplexEdge: PrintDuplexEdge
  headerFooter: boolean
  background: boolean
}

/**
 * What Chrome remembers between prints (its "sticky settings"): everything but the pages and
 * the copies, which start over with each preview.
 */
export type PrintStickySettings = Omit<PrintSettings, 'pages' | 'copies' | 'collate'>

export const PRINT_STICKY_KEYS: readonly (keyof PrintStickySettings)[] = [
  'destination',
  'layout',
  'color',
  'paperSize',
  'margins',
  'scale',
  'twoSided',
  'duplexEdge',
  'headerFooter',
  'background'
]

/** Chrome's labels, in menu order. */
export const PRINT_LABELS = {
  destination: 'Destination',
  pages: 'Pages',
  pagesAll: 'All',
  pagesOdd: 'Odd pages only',
  pagesEven: 'Even pages only',
  pagesCustom: 'Custom',
  pagesPlaceholder: 'e.g. 1-5, 8, 11-13',
  copies: 'Copies',
  collate: 'Collate',
  layout: 'Layout',
  portrait: 'Portrait',
  landscape: 'Landscape',
  color: 'Color',
  colorColor: 'Color',
  colorBw: 'Black and white',
  moreSettings: 'More settings',
  paperSize: 'Paper size',
  margins: 'Margins',
  marginsDefault: 'Default',
  marginsNone: 'None',
  marginsMinimum: 'Minimum',
  marginsCustom: 'Custom',
  scale: 'Scale',
  scaleDefault: 'Default',
  scaleCustom: 'Custom',
  twoSided: 'Print on both sides',
  flipLongEdge: 'Flip on long edge',
  flipShortEdge: 'Flip on short edge',
  options: 'Options',
  headerFooter: 'Headers and footers',
  background: 'Background graphics',
  print: 'Print',
  save: 'Save',
  cancel: 'Cancel',
  loading: 'Loading preview',
  /** Chrome's title while the preview renders and the page count is not known. */
  title: 'Print'
} as const

/** Chrome's validation messages. */
export const PRINT_MESSAGES = {
  copies: 'Use a number (1 to 999)',
  scale: 'Use a number (10 to 200)',
  pageRangeSyntax: 'Invalid page range, use e.g. 1-5, 8, 11-13',
  pageRangeLimit: (limit: number) => `Out of bounds page reference, limit is ${limit}`,
  /** Nothing to print: the pages picked are not in the document (odd pages of a zero-page document). */
  noPages: 'No pages selected',
  previewFailed: 'Print preview failed',
  printFailed: 'Couldn’t print – check your printer and try again',
  saveFailed: 'The PDF could not be saved'
} as const

export const MIN_COPIES = 1
export const MAX_COPIES = 999
export const MIN_SCALE_PERCENT = 10
export const MAX_SCALE_PERCENT = 200
/** Chromium's default page margins (1 cm), as `printToPDF` applies them when none are given. */
export const DEFAULT_MARGIN_INCHES = 0.3937
/** How far custom margins may go: half the page is a hard stop the UI never reaches. */
const MAX_CUSTOM_MARGIN_INCHES = 20

// ---------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------

/** A paper size in microns (the unit Chrome's media sizes and `webContents.print` use). */
export interface PaperSize {
  id: string
  /** Chrome's label. */
  label: string
  /** The name `printToPDF` and `print` know the size by, when they know it. */
  engineName: 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A4' | 'A5' | null
  widthMicrons: number
  heightMicrons: number
}

const INCH_MICRONS = 25400
const MM_MICRONS = 1000

/** The sizes Chrome offers its PDF destination, in its order. */
export const PAPER_SIZES: readonly PaperSize[] = [
  paper('letter', 'Letter', 'Letter', 8.5 * INCH_MICRONS, 11 * INCH_MICRONS),
  paper('legal', 'Legal', 'Legal', 8.5 * INCH_MICRONS, 14 * INCH_MICRONS),
  paper('tabloid', 'Tabloid', 'Tabloid', 11 * INCH_MICRONS, 17 * INCH_MICRONS),
  paper('a3', 'A3', 'A3', 297 * MM_MICRONS, 420 * MM_MICRONS),
  paper('a4', 'A4', 'A4', 210 * MM_MICRONS, 297 * MM_MICRONS),
  paper('a5', 'A5', 'A5', 148 * MM_MICRONS, 210 * MM_MICRONS)
]

function paper(
  id: string,
  label: string,
  engineName: PaperSize['engineName'],
  widthMicrons: number,
  heightMicrons: number
): PaperSize {
  return { id, label, engineName, widthMicrons: Math.round(widthMicrons), heightMicrons }
}

export function paperSizeById(id: string): PaperSize | null {
  return PAPER_SIZES.find((p) => p.id === id) ?? null
}

/** Regions whose paper is Letter (ICU's paper-size data, what Chrome's default follows). */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'BZ',
  'CL',
  'CO',
  'CR',
  'GT',
  'NI',
  'PA',
  'PH',
  'PR',
  'SV',
  'VE'
])

/** Chrome's default paper for the user's locale: Letter in the Americas and the Philippines, A4 elsewhere. */
export function defaultPaperSizeFor(locale: string | null | undefined): string {
  const region = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(locale ?? '')?.[1]?.toUpperCase()
  return region && LETTER_REGIONS.has(region) ? 'letter' : 'a4'
}

// ---------------------------------------------------------------------------
// Defaults and sanitising
// ---------------------------------------------------------------------------

export function defaultCustomMargins(): PrintCustomMargins {
  return {
    top: DEFAULT_MARGIN_INCHES,
    right: DEFAULT_MARGIN_INCHES,
    bottom: DEFAULT_MARGIN_INCHES,
    left: DEFAULT_MARGIN_INCHES
  }
}

/** A first preview's settings: Chrome's defaults, the paper from the locale. */
export function defaultPrintSettings(locale?: string | null): PrintSettings {
  return {
    destination: { kind: 'pdf' },
    pages: { mode: 'all', custom: '' },
    copies: 1,
    collate: true,
    layout: 'portrait',
    color: 'color',
    paperSize: defaultPaperSizeFor(locale),
    margins: { mode: 'default', custom: defaultCustomMargins() },
    scale: { mode: 'default', percent: 100 },
    twoSided: false,
    duplexEdge: 'longEdge',
    headerFooter: true,
    background: false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizeDestination(raw: unknown, fallback: PrintDestination): PrintDestination {
  if (!isRecord(raw)) return fallback
  if (raw.kind === 'pdf') return { kind: 'pdf' }
  if (raw.kind === 'printer' && typeof raw.name === 'string' && raw.name.trim())
    return { kind: 'printer', name: raw.name }
  return fallback
}

function sanitizeMargins(raw: unknown, fallback: PrintCustomMargins): PrintCustomMargins {
  if (!isRecord(raw)) return fallback
  const side = (key: keyof PrintCustomMargins): number =>
    finite(raw[key], fallback[key], 0, MAX_CUSTOM_MARGIN_INCHES)
  return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') }
}

/**
 * Settings from an untrusted source – the persisted document, the chrome's request – with every
 * field checked and anything unknown replaced from `defaults`. The paper falls back to the
 * default when the id is not one this build lists.
 */
export function sanitizePrintSettings(raw: unknown, defaults: PrintSettings): PrintSettings {
  if (!isRecord(raw))
    return { ...defaults, margins: { ...defaults.margins }, scale: { ...defaults.scale } }
  const pages = isRecord(raw.pages) ? raw.pages : {}
  const margins = isRecord(raw.margins) ? raw.margins : {}
  const scale = isRecord(raw.scale) ? raw.scale : {}
  return {
    destination: sanitizeDestination(raw.destination, defaults.destination),
    pages: {
      mode: oneOf(pages.mode, ['all', 'odd', 'even', 'custom'], defaults.pages.mode),
      custom: typeof pages.custom === 'string' ? pages.custom.slice(0, 200) : defaults.pages.custom
    },
    copies: Math.round(finite(raw.copies, defaults.copies, MIN_COPIES, MAX_COPIES)),
    collate: typeof raw.collate === 'boolean' ? raw.collate : defaults.collate,
    layout: oneOf(raw.layout, ['portrait', 'landscape'], defaults.layout),
    color: oneOf(raw.color, ['color', 'bw'], defaults.color),
    paperSize:
      typeof raw.paperSize === 'string' && paperSizeById(raw.paperSize)
        ? raw.paperSize
        : defaults.paperSize,
    margins: {
      mode: oneOf(margins.mode, ['default', 'none', 'minimum', 'custom'], defaults.margins.mode),
      custom: sanitizeMargins(margins.custom, defaults.margins.custom)
    },
    scale: {
      mode: oneOf(scale.mode, ['default', 'custom'], defaults.scale.mode),
      percent: Math.round(
        finite(scale.percent, defaults.scale.percent, MIN_SCALE_PERCENT, MAX_SCALE_PERCENT)
      )
    },
    twoSided: typeof raw.twoSided === 'boolean' ? raw.twoSided : defaults.twoSided,
    duplexEdge: oneOf(raw.duplexEdge, ['longEdge', 'shortEdge'], defaults.duplexEdge),
    headerFooter: typeof raw.headerFooter === 'boolean' ? raw.headerFooter : defaults.headerFooter,
    background: typeof raw.background === 'boolean' ? raw.background : defaults.background
  }
}

/** The part of the settings Chrome carries over to the next print. */
export function stickyOf(settings: PrintSettings): PrintStickySettings {
  return {
    destination: settings.destination,
    layout: settings.layout,
    color: settings.color,
    paperSize: settings.paperSize,
    margins: { mode: settings.margins.mode, custom: { ...settings.margins.custom } },
    scale: { ...settings.scale },
    twoSided: settings.twoSided,
    duplexEdge: settings.duplexEdge,
    headerFooter: settings.headerFooter,
    background: settings.background
  }
}

/**
 * The settings a preview opens with: the remembered ones over the defaults, the pages and
 * copies fresh, and the destination checked against the printers the host has now.
 */
export function openingSettings(
  sticky: unknown,
  printers: readonly PrinterDescription[],
  locale?: string | null
): PrintSettings {
  const defaults = defaultPrintSettings(locale)
  const remembered = sanitizePrintSettings(sticky, defaults)
  const destination = initialDestination(
    isRecord(sticky) && 'destination' in sticky ? remembered.destination : null,
    printers
  )
  return {
    ...remembered,
    destination,
    pages: { mode: 'all', custom: '' },
    copies: 1,
    collate: true,
    twoSided: remembered.twoSided && twoSidedAvailable(destination, printers)
  }
}

// ---------------------------------------------------------------------------
// Validation (Chrome's rules and messages)
// ---------------------------------------------------------------------------

/** A run of pages, 1-based and inclusive. */
export interface PageRange {
  from: number
  to: number
}

export type PageRangeParse = { ok: true; ranges: PageRange[] } | { ok: false; error: string }

const RANGE_PART = /^\s*(\d*)\s*(-)?\s*(\d*)\s*$/

/**
 * Chrome's page-range grammar: comma-separated pages (`8`) and runs (`1-5`), an open run to the
 * end (`11-`) or from the start (`-3`), whitespace anywhere. Pages beyond `pageCount` (when it
 * is known) are out of bounds rather than clamped, as Chrome reports them. Empty text is the
 * syntax error: the field is required once Custom is picked.
 */
export function parsePageRanges(text: string, pageCount: number | null = null): PageRangeParse {
  if (!text.trim()) return { ok: false, error: PRINT_MESSAGES.pageRangeSyntax }
  const ranges: PageRange[] = []
  for (const part of text.split(',')) {
    const m = RANGE_PART.exec(part)
    if (!m || (!m[1] && !m[3])) return { ok: false, error: PRINT_MESSAGES.pageRangeSyntax }
    const [, first, dash, last] = m
    let from: number
    let to: number
    if (!dash) {
      if (!first || last) return { ok: false, error: PRINT_MESSAGES.pageRangeSyntax }
      from = to = Number(first)
    } else {
      from = first ? Number(first) : 1
      if (last) to = Number(last)
      else if (pageCount !== null) to = pageCount
      else return { ok: false, error: PRINT_MESSAGES.pageRangeSyntax }
    }
    if (from < 1 || to < 1 || from > to) return { ok: false, error: PRINT_MESSAGES.pageRangeSyntax }
    if (pageCount !== null && to > pageCount)
      return { ok: false, error: PRINT_MESSAGES.pageRangeLimit(pageCount) }
    ranges.push({ from, to })
  }
  return { ok: true, ranges }
}

/** Chrome's copies field: an integer 1–999; the message otherwise. */
export function validateCopies(
  text: string
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: PRINT_MESSAGES.copies }
  const value = Number(trimmed)
  if (value < MIN_COPIES || value > MAX_COPIES) return { ok: false, error: PRINT_MESSAGES.copies }
  return { ok: true, value }
}

/** Chrome's scale field: an integer 10–200; the message otherwise. */
export function validateScale(
  text: string
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: PRINT_MESSAGES.scale }
  const value = Number(trimmed)
  if (value < MIN_SCALE_PERCENT || value > MAX_SCALE_PERCENT)
    return { ok: false, error: PRINT_MESSAGES.scale }
  return { ok: true, value }
}

/**
 * The pages a selection picks out of a document of `pageCount` pages, ascending and without
 * repeats (Chrome merges overlapping runs). Empty for a custom selection that does not parse,
 * or for odd / even pages of a document that has none.
 */
export function pagesToPrint(pages: PrintSettings['pages'], pageCount: number): number[] {
  if (pageCount <= 0) return []
  switch (pages.mode) {
    case 'all':
      return Array.from({ length: pageCount }, (_, i) => i + 1)
    case 'odd':
      return Array.from({ length: pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 1)
    case 'even':
      return Array.from({ length: pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 0)
    case 'custom': {
      const parsed = parsePageRanges(pages.custom, pageCount)
      if (!parsed.ok) return []
      const picked = new Set<number>()
      for (const r of parsed.ranges) for (let p = r.from; p <= r.to; p++) picked.add(p)
      return [...picked].sort((a, b) => a - b)
    }
  }
}

/** Ascending pages as inclusive runs: `[1,2,3,5,8,9]` → `1-3, 5, 8-9`. */
export function collapsePages(pages: readonly number[]): PageRange[] {
  const runs: PageRange[] = []
  for (const page of pages) {
    const last = runs[runs.length - 1]
    if (last && page === last.to + 1) last.to = page
    else if (!last || page > last.to) runs.push({ from: page, to: page })
  }
  return runs
}

/** Runs in the form `printToPDF` takes (`1-3, 5, 8-9`); '' means every page. */
export function pageRangeText(ranges: readonly PageRange[]): string {
  return ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(', ')
}

// ---------------------------------------------------------------------------
// The host's options
// ---------------------------------------------------------------------------

/** A size in inches for `printToPDF`. */
export interface PdfPageSizeInches {
  width: number
  height: number
}

/**
 * What the preview is rendered with: `webContents.printToPDF`'s options, host neutral. Margins
 * and the page size are in inches, the scale a factor, the ranges Chrome's text form. Header and
 * footer use Chromium's own template (the date and title above, the address and page numbers
 * below), the one Chrome's preview shows – so no template is passed.
 */
export interface PdfRenderOptions {
  landscape: boolean
  printBackground: boolean
  scale: number
  pageSize: PdfPageSizeInches
  margins: PrintCustomMargins
  /** '' renders every page. */
  pageRanges: string
  displayHeaderFooter: boolean
  preferCSSPageSize: boolean
}

/** Microns → inches, rounded so the engine sees a clean figure. */
function inches(microns: number): number {
  return Math.round((microns / INCH_MICRONS) * 10000) / 10000
}

/** The margins the render applies for a mode: Chromium's default, none, or the user's. */
export function renderMargins(margins: PrintSettings['margins']): PrintCustomMargins {
  switch (margins.mode) {
    case 'default':
      return defaultCustomMargins()
    case 'none':
    case 'minimum':
      return { top: 0, right: 0, bottom: 0, left: 0 }
    case 'custom':
      return { ...margins.custom }
  }
}

/**
 * The options that render `settings` to the preview PDF. The paper's portrait dimensions are
 * given and `landscape` turns them, as the engine expects; `pages` picks the runs once the
 * document's page count is known (a first render, with the count unknown, renders every page
 * and the chrome learns the count from the PDF).
 */
export function pdfRenderOptions(
  settings: PrintSettings,
  pageCount: number | null = null
): PdfRenderOptions {
  const paper = paperSizeById(settings.paperSize) ?? PAPER_SIZES[0]
  const pages = pageCount === null ? [] : pagesToPrint(settings.pages, pageCount)
  const every = pageCount === null || pages.length === pageCount
  return {
    landscape: settings.layout === 'landscape',
    printBackground: settings.background,
    scale: (settings.scale.mode === 'custom' ? settings.scale.percent : 100) / 100,
    pageSize: { width: inches(paper.widthMicrons), height: inches(paper.heightMicrons) },
    margins: renderMargins(settings.margins),
    pageRanges: every ? '' : pageRangeText(collapsePages(pages)),
    displayHeaderFooter: settings.headerFooter,
    preferCSSPageSize: false
  }
}

/**
 * The job that sends the rendered document to a printer: `webContents.print`'s options, host
 * neutral, for the PDF the preview laid out (`pdfRenderOptions`). Chrome prints the preview's
 * own PDF, and so does this: the pages picked, the paper, margins, scale, headers and footers
 * and background graphics are in the file, page for page as the preview showed them. What is
 * left is the printer's business – which one, how many copies, collated, two-sided and on which
 * edge, in colour or not, and the paper to load, turned when the pages are.
 */
export interface PrintJobOptions {
  deviceName: string
  copies: number
  collate: boolean
  duplexMode: 'simplex' | 'longEdge' | 'shortEdge'
  color: boolean
  landscape: boolean
  /** The paper in microns, portrait; `landscape` turns it. */
  pageSize: { width: number; height: number }
}

/**
 * The job that prints `settings` on the printer it names, for a document of `pageCount` pages.
 * Null for the PDF destination, which is saved rather than printed, and for a selection that
 * picks no page.
 */
export function printJobOptions(
  settings: PrintSettings,
  pageCount: number
): PrintJobOptions | null {
  if (settings.destination.kind !== 'printer') return null
  if (pagesToPrint(settings.pages, pageCount).length === 0) return null
  const paper = paperSizeById(settings.paperSize) ?? PAPER_SIZES[0]
  return {
    deviceName: settings.destination.name,
    copies: settings.copies,
    collate: settings.collate,
    duplexMode: settings.twoSided ? settings.duplexEdge : 'simplex',
    color: settings.color === 'color',
    landscape: settings.layout === 'landscape',
    pageSize: { width: paper.widthMicrons, height: paper.heightMicrons }
  }
}

// ---------------------------------------------------------------------------
// The chrome's view of a session (`print.*` commands)
// ---------------------------------------------------------------------------

/** What the preview needs to open for a tab. */
export interface PrintSessionInfo {
  tabId: string
  /** The page's title and address: the header and footer, the PDF's file name, the dialog's caption. */
  title: string
  url: string
  printers: PrinterDescription[]
  /** The settings the preview opens with: Chrome's sticky settings over the defaults. */
  settings: PrintSettings
}

/** A preview render: the PDF's bytes, base64, or why there are none. */
export type PrintPreviewResult = { ok: true; pdf: string } | { ok: false; error: string }

/** How a Print / Save ended. */
export type PrintRunResult =
  | { ok: true; action: 'printed' }
  | { ok: true; action: 'saved'; path: string }
  /** The user dismissed the save dialog: the preview stays open, as Chrome's does. */
  | { ok: true; action: 'cancelled' }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// The preview's own labels
// ---------------------------------------------------------------------------

/**
 * Chrome's total above the settings: sheets of paper for a printer (two-sided halves them,
 * copies multiply them), pages for a PDF. Null while the page count is not known.
 */
export function printSummary(settings: PrintSettings, pageCount: number | null): string | null {
  if (pageCount === null) return null
  const pages = pagesToPrint(settings.pages, pageCount).length
  if (settings.destination.kind === 'pdf')
    return `Total: ${pages} ${pages === 1 ? 'page' : 'pages'}`
  const perCopy = settings.twoSided ? Math.ceil(pages / 2) : pages
  const sheets = perCopy * settings.copies
  return `Total: ${sheets} ${sheets === 1 ? 'sheet of paper' : 'sheets of paper'}`
}

/** The primary button: Chrome says Save for the PDF destination and Print for a printer. */
export function primaryLabel(destination: PrintDestination): string {
  return destination.kind === 'pdf' ? PRINT_LABELS.save : PRINT_LABELS.print
}

/**
 * The file name Chrome suggests for Save as PDF: the page's title, else the address's host,
 * else "document", made safe for a file system and given the extension.
 */
export function defaultPdfFileName(title: string, url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  const base = (title.trim() || host || 'document')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  return `${base || 'document'}.pdf`
}

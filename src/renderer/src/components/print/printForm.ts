import {
  defaultPaperSizeFor,
  PAPER_SIZES,
  paperSizeById,
  PRINT_LABELS,
  SAVE_AS_PDF_LABEL,
  type PrintColorMode,
  type PrintCustomMargins,
  type PrintDestination,
  type PrintDuplexEdge,
  type PrinterDescription,
  type PrintLayout,
  type PrintMarginsMode,
  type PrintPagesMode,
  type PrintScaleMode,
  type PrintSettings
} from '@shared/print'
import type { MenulistOption } from '../siteControls/primitives'

/**
 * The print preview's form as data: the menulists' options in Chrome's order and wording
 * (`shared/print.ts` has the labels), the destination's value in the list, and the custom
 * margins in the unit the locale measures in. Pure, so the dialog stays a view of it.
 */

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/** The PDF destination's value in the destination menulist; printers are `printer:<name>`. */
export const PDF_DESTINATION = 'pdf'
const PRINTER_PREFIX = 'printer:'

export function destinationValue(destination: PrintDestination): string {
  return destination.kind === 'pdf' ? PDF_DESTINATION : PRINTER_PREFIX + destination.name
}

export function destinationFromValue(value: string): PrintDestination {
  return value.startsWith(PRINTER_PREFIX)
    ? { kind: 'printer', name: value.slice(PRINTER_PREFIX.length) }
    : { kind: 'pdf' }
}

/**
 * The destination list: the system's printers, the default first, then Save as PDF – Chrome's
 * list puts the printers it knows above the PDF destination. A remembered printer that is gone
 * is not listed (the session already fell back from it).
 */
export function destinationOptions(
  printers: readonly PrinterDescription[]
): MenulistOption<string>[] {
  const sorted = [...printers].sort((a, b) =>
    a.isDefault === b.isDefault ? a.displayName.localeCompare(b.displayName) : a.isDefault ? -1 : 1
  )
  return [
    ...sorted.map((p) => ({
      value: destinationValue({ kind: 'printer', name: p.name }),
      label: p.displayName || p.name
    })),
    { value: PDF_DESTINATION, label: SAVE_AS_PDF_LABEL }
  ]
}

// ---------------------------------------------------------------------------
// The menus
// ---------------------------------------------------------------------------

export const PAGES_OPTIONS: readonly MenulistOption<PrintPagesMode>[] = [
  { value: 'all', label: PRINT_LABELS.pagesAll },
  { value: 'odd', label: PRINT_LABELS.pagesOdd },
  { value: 'even', label: PRINT_LABELS.pagesEven },
  { value: 'custom', label: PRINT_LABELS.pagesCustom }
]

export const LAYOUT_OPTIONS: readonly MenulistOption<PrintLayout>[] = [
  { value: 'portrait', label: PRINT_LABELS.portrait },
  { value: 'landscape', label: PRINT_LABELS.landscape }
]

export const COLOR_OPTIONS: readonly MenulistOption<PrintColorMode>[] = [
  { value: 'color', label: PRINT_LABELS.colorColor },
  { value: 'bw', label: PRINT_LABELS.colorBw }
]

export const PAPER_OPTIONS: readonly MenulistOption<string>[] = PAPER_SIZES.map((p) => ({
  value: p.id,
  label: p.label
}))

export const MARGINS_OPTIONS: readonly MenulistOption<PrintMarginsMode>[] = [
  { value: 'default', label: PRINT_LABELS.marginsDefault },
  { value: 'none', label: PRINT_LABELS.marginsNone },
  { value: 'minimum', label: PRINT_LABELS.marginsMinimum },
  { value: 'custom', label: PRINT_LABELS.marginsCustom }
]

export const SCALE_OPTIONS: readonly MenulistOption<PrintScaleMode>[] = [
  { value: 'default', label: PRINT_LABELS.scaleDefault },
  { value: 'custom', label: PRINT_LABELS.scaleCustom }
]

export const DUPLEX_OPTIONS: readonly MenulistOption<PrintDuplexEdge>[] = [
  { value: 'longEdge', label: PRINT_LABELS.flipLongEdge },
  { value: 'shortEdge', label: PRINT_LABELS.flipShortEdge }
]

// ---------------------------------------------------------------------------
// Custom margins
// ---------------------------------------------------------------------------

/** The unit margins are typed in: inches where the paper is Letter, millimetres elsewhere. */
export type MarginUnit = 'in' | 'mm'

const MM_PER_INCH = 25.4

export function marginUnitFor(locale: string | null | undefined): MarginUnit {
  return defaultPaperSizeFor(locale) === 'letter' ? 'in' : 'mm'
}

/** Inches → the unit's figure as the field shows it (two decimals for inches, whole millimetres). */
export function marginText(inches: number, unit: MarginUnit): string {
  if (unit === 'mm') return String(Math.round(inches * MM_PER_INCH))
  return String(Math.round(inches * 100) / 100)
}

/**
 * The typed figure as inches, or null while it is not a number. Negative figures are not
 * margins; anything past half the paper's shorter side (less a little for the page) is clamped
 * there, as Chrome's margin handles stop at each other.
 */
export function marginInches(text: string, unit: MarginUnit, paperSizeId: string): number | null {
  const n = Number(text.trim().replace(',', '.'))
  if (!text.trim() || !Number.isFinite(n) || n < 0) return null
  const inches = unit === 'mm' ? n / MM_PER_INCH : n
  const paper = paperSizeById(paperSizeId) ?? PAPER_SIZES[0]
  const shorter = Math.min(paper.widthMicrons, paper.heightMicrons) / 25400
  const most = Math.max(0, shorter / 2 - 0.25)
  return Math.min(inches, Math.round(most * 10000) / 10000)
}

export const MARGIN_SIDES: readonly (keyof PrintCustomMargins)[] = [
  'top',
  'right',
  'bottom',
  'left'
]

export const MARGIN_SIDE_LABELS: Record<keyof PrintCustomMargins, string> = {
  top: 'Top',
  right: 'Right',
  bottom: 'Bottom',
  left: 'Left'
}

/** The four margin fields' text for a set of margins. */
export function marginTexts(
  margins: PrintCustomMargins,
  unit: MarginUnit
): Record<keyof PrintCustomMargins, string> {
  return {
    top: marginText(margins.top, unit),
    right: marginText(margins.right, unit),
    bottom: marginText(margins.bottom, unit),
    left: marginText(margins.left, unit)
  }
}

// ---------------------------------------------------------------------------
// What shows for a destination
// ---------------------------------------------------------------------------

/**
 * Chrome hides what a PDF has no use for: copies (a file is one file) and colour (a PDF keeps
 * the page's colours). Both stay in the settings for the next destination.
 */
export function showsPrinterOnly(settings: PrintSettings): boolean {
  return settings.destination.kind === 'printer'
}

import {
  ANDROID_FONT_FAMILIES,
  GENERIC_FONT_FAMILIES,
  electronFontDefaults,
  type FontFamilySlot,
  type PageFontSettings
} from '@shared/fonts'
import type { Platform } from '@shared/types'
import type { RowOption } from './model'

/**
 * The Customise fonts group's model (CT-25; `fonts.tsx` builds the rows from it, `fontBlocks.tsx`
 * draws the preview and the phone's picker with it): the slots' labels and hints, the sizes'
 * format and menulist options over Chrome's stops, the families a picker offers, and the faces
 * the preview draws for a slot the setting leaves to the platform.
 */

export const SLOT_LABELS: Record<FontFamilySlot, string> = {
  standard: 'Standard font',
  serif: 'Serif font',
  sansSerif: 'Sans-serif font',
  fixed: 'Fixed-width font'
}

export const SLOT_HINTS: Record<FontFamilySlot, string> = {
  standard: 'Text a page leaves to the browser.',
  serif: 'Where a page asks for a serif face.',
  sansSerif: 'Where a page asks for a sans-serif face.',
  fixed: 'Code and other fixed-width text.'
}

/** The picker's value for "no family of your own": the platform's face for the slot. */
export const DEFAULT_FAMILY = ''
const DEFAULT_FAMILY_LABEL = 'System default'

const GENERIC_LABELS: Record<string, string> = {
  serif: 'Serif',
  'sans-serif': 'Sans-serif',
  monospace: 'Monospace',
  'serif-monospace': 'Serif monospace',
  casual: 'Casual',
  cursive: 'Cursive',
  'sans-serif-condensed': 'Sans-serif condensed'
}

/** The index of the stop `value` sits on, or of the nearest stop for a value between them (a synced 19). */
export function stepIndex(steps: readonly number[], value: number): number {
  let best = 0
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - value) < Math.abs(steps[best] - value)) best = i
  }
  return best
}

/** "16 px"; the minimum size's 0 is "None" (Chrome's slider stops at 0 or 6 and up). */
export function formatFontSize(px: number): string {
  return px === 0 ? 'None' : `${px} px`
}

/**
 * The desktop's menulist of a size's stops (§10.5: a level in Settings is a menulist of its
 * stops, as Default zoom's): Chrome's ladder, each stop as `formatFontSize` writes it, its
 * value the size in px as text. A current size off the ladder (a synced 19) is listed in its
 * place, so the row never shows a value its list lacks.
 */
export function fontSizeOptions(steps: readonly number[], current: number): RowOption[] {
  const sizes = steps.includes(current) ? [...steps] : [...steps, current].sort((a, b) => a - b)
  return sizes.map((px) => ({ value: String(px), label: formatFontSize(px) }))
}

/**
 * The families a picker offers for a slot: the platform's default first, then the generic
 * names every host resolves, then – on a host that lists them – the installed families in one
 * run (the desktop popover draws no group headings, so none is named), each option carrying
 * its face as a CSS family for the picker's specimen (`RowOption.font`). The current family is
 * kept on the list even when the computer no longer has it (a synced choice), so the row never
 * shows a value its picker lacks.
 */
export function familyOptions(
  current: string | null,
  installed: readonly string[] | null,
  generic: boolean
): RowOption[] {
  const names = generic ? GENERIC_FONT_FAMILIES : ANDROID_FONT_FAMILIES
  const options: RowOption[] = [
    { value: DEFAULT_FAMILY, label: DEFAULT_FAMILY_LABEL },
    ...names.map((name) => ({
      value: name,
      label: GENERIC_LABELS[name] ?? name,
      font: cssFamily(name)
    }))
  ]
  if (installed) {
    const seen = new Set(names)
    for (const family of installed) {
      if (seen.has(family)) continue
      seen.add(family)
      options.push({ value: family, label: family, font: cssFamily(family) })
    }
  }
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: current, font: cssFamily(current) })
  }
  return options
}

/** The faces the preview draws for a slot the setting leaves to the platform (what a page gets). */
export function previewFamilies(
  fonts: PageFontSettings,
  platform: Platform
): { standard: string; fixed: string } {
  if (platform === 'android') {
    // Android's WebView: Zenium's standard family is `serif` (Chrome's typographic default) and
    // its fixed one `monospace` (the interface note, §2.3).
    return { standard: fonts.standard ?? 'serif', fixed: fonts.fixed ?? 'monospace' }
  }
  const defaults = electronFontDefaults(platform)
  return { standard: fonts.standard ?? defaults.standard, fixed: fonts.fixed ?? defaults.fixed }
}

/** A family as a CSS `font-family` value: quoted unless it is a generic name (a quoted one stays as it is). */
export function cssFamily(family: string): string {
  return /^[a-z-]+$/.test(family) ? family : `"${family.replace(/"/g, '')}"`
}

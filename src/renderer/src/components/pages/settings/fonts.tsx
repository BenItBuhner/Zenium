import type { CSSProperties, JSX } from 'react'
import {
  ANDROID_FONT_FAMILIES,
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_STEPS,
  GENERIC_FONT_FAMILIES,
  MINIMUM_FONT_SIZE_STEPS,
  electronFontDefaults,
  isDefaultFontSettings,
  monospaceFontSize,
  type FontFamilySlot,
  type PageFontSettings
} from '@shared/fonts'
import type { Platform } from '@shared/types'
import type { RowGroup, RowOption, SettingsRow } from './model'
import type { SectionContext } from './sections'

/**
 * Settings › Appearance › Customise fonts (CT-25; Chrome's chrome://settings/fonts as one group
 * of the shared builder, §10.3): the font size and the minimum size as §9.21 slider rows over
 * Chrome's stops, applied when the thumb is let go with the live value beside the label and
 * Chrome's end labels under the track – a drag never re-lays the pages out per frame; the
 * family rows as §9.13 menulist rows whose picker draws each option in its own face (the
 * desktop's popover through `RowOption.font`; the phone's own picker sheet, `FontPickList`,
 * since the chassis's radio rows take no face); a Reset row once anything stands off the
 * defaults; and the preview as a static content row (§10.3: it grows with its text) in the
 * page fonts themselves, following each committed change. On a host whose engine ignores the
 * generic-family slots (`capabilities.genericFontFamilies` false: Android, where Blink resolves
 * `serif` / `sans-serif` / `monospace` through `fonts.xml` and never reads the settings) only
 * the standard family and the two sizes are rows – the honest list, as the interface note
 * records – and the standard family's options are the aliases WebView resolves by name.
 */

const SLOT_LABELS: Record<FontFamilySlot, string> = {
  standard: 'Standard font',
  serif: 'Serif font',
  sansSerif: 'Sans-serif font',
  fixed: 'Fixed-width font'
}

const SLOT_HINTS: Record<FontFamilySlot, string> = {
  standard: 'Text a page leaves to the browser.',
  serif: 'Where a page asks for a serif face.',
  sansSerif: 'Where a page asks for a sans-serif face.',
  fixed: 'Code and other fixed-width text.'
}

/** The picker's value for "no family of your own": the platform's face for the slot. */
const DEFAULT_FAMILY = ''
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

/** Chrome's end labels for the two sliders (its fonts page's `label-min` / `label-max`). */
export const FONT_SIZE_ENDS: readonly [string, string] = ['Very small', 'Very large']
export const MINIMUM_FONT_SIZE_ENDS: readonly [string, string] = ['Tiny', 'Huge']

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
 * The families a picker offers for a slot: the platform's default first, then the generic
 * names every host resolves, then – on a host that lists them – the installed families, each
 * option drawn in its own face. The current family is kept on the list even when the computer
 * no longer has it (a synced choice), so the row never shows a value its picker lacks.
 */
export function familyOptions(
  current: string | null,
  installed: readonly string[] | null,
  generic: boolean
): RowOption[] {
  const names = generic ? GENERIC_FONT_FAMILIES : ANDROID_FONT_FAMILIES
  const options: RowOption[] = [
    { value: DEFAULT_FAMILY, label: DEFAULT_FAMILY_LABEL },
    ...names.map((name) => ({ value: name, label: GENERIC_LABELS[name] ?? name, font: name }))
  ]
  if (installed) {
    const seen = new Set(names)
    for (const family of installed) {
      if (seen.has(family)) continue
      seen.add(family)
      options.push({ value: family, label: family, font: family, group: 'Installed' })
    }
  }
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: current, font: current })
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

/** A family as a CSS `font-family` value: quoted unless it is a generic name. */
function cssFamily(family: string): string {
  return /^[a-z-]+$/.test(family) ? family : `"${family.replace(/"/g, '')}"`
}

/**
 * The preview paragraph (§10.3's content row): the standard family at the chosen size, then
 * the fixed-width family at Chrome's ratio of it, both floored by the minimum size as a page's
 * text would be – so the row shows what a page gets, in the page's own type, not the chrome's.
 */
export function FontPreview({
  fonts,
  platform
}: {
  fonts: PageFontSettings
  platform: Platform
}): JSX.Element {
  const faces = previewFamilies(fonts, platform)
  const size = Math.max(fonts.size, fonts.minimumSize)
  const fixed = Math.max(monospaceFontSize(fonts.size), fonts.minimumSize)
  return (
    <div
      className="zen-settings-fonts-preview"
      data-static=""
      style={
        {
          '--zen-settings-preview-family': cssFamily(faces.standard),
          '--zen-settings-preview-size': `${size}px`,
          '--zen-settings-preview-fixed-family': cssFamily(faces.fixed),
          '--zen-settings-preview-fixed-size': `${fixed}px`
        } as CSSProperties
      }
    >
      <p data-face="standard" lang="en">
        The quick brown fox jumps over the lazy dog. 0123456789
      </p>
      <p data-face="fixed" lang="en">
        for (const page of tabs) page.render(fonts);
      </p>
      <span className="zen-settings-description">
        How a page’s text and its fixed-width text look with these settings.
      </span>
    </div>
  )
}

/**
 * The phone's family picker (§9.13's sheet of radio rows, drawn here rather than by the
 * chassis's option sheet so that each row is in its own face): the current family checked and
 * focused as the sheet opens (§9.22 – the chassis focuses the checked radio), a pick sets the
 * family and closes the sheet.
 */
export function FontPickList({
  label,
  options,
  value,
  onPick,
  close
}: {
  label: string
  options: readonly RowOption[]
  value: string
  onPick: (value: string) => void
  close: () => void
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="zen-settings-sheet-rows">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="zen-settings-row zen-settings-radio-row zen-settings-font-option zen-v2-row"
          style={
            option.font
              ? ({ '--zen-settings-option-font': cssFamily(option.font) } as CSSProperties)
              : undefined
          }
          onClick={() => {
            if (option.value !== value) onPick(option.value)
            close()
          }}
        >
          <span className="zen-v2-radio" aria-hidden="true" />
          <span className="zen-settings-row-text">
            <span className="zen-settings-label">{option.label}</span>
            {option.description && (
              <span className="zen-settings-description">{option.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The group: sizes, families, preview, Reset. The family rows come in two forms by chrome
 * layout, one per row id, so a test walks both: the desktop and tablet shells' §9.13 value row,
 * whose menulist popover draws each option in its face (`RowOption.font`); the phone shell's
 * action row opening `FontPickList` in a sheet, since the chassis's picker sheet draws no face
 * (`sheets.tsx`) – the row shows the current family as its description like a value row does.
 */
export function fontsGroups({
  state,
  set,
  localFonts
}: Pick<SectionContext, 'state' | 'set' | 'localFonts'>): RowGroup[] {
  const fonts = state.settings.fonts
  const generic = state.capabilities.genericFontFamilies
  const patch = (change: Partial<PageFontSettings>): void =>
    set({ fonts: { ...fonts, ...change } })
  const keywords = ['fonts', 'customize fonts', 'typeface', 'text size', 'font size']

  const sizeIndex = stepIndex(FONT_SIZE_STEPS, fonts.size)
  const minimumIndex = stepIndex(MINIMUM_FONT_SIZE_STEPS, fonts.minimumSize)
  const rows: SettingsRow[] = [
    {
      kind: 'slider',
      id: 'fonts-size',
      label: 'Font size',
      keywords,
      value: sizeIndex,
      min: 0,
      max: FONT_SIZE_STEPS.length - 1,
      step: 1,
      ends: FONT_SIZE_ENDS,
      format: (i) => formatFontSize(FONT_SIZE_STEPS[i] ?? fonts.size),
      onChange: (i) => {
        const size = FONT_SIZE_STEPS[i]
        if (size !== undefined && size !== fonts.size) patch({ size })
      }
    },
    {
      kind: 'slider',
      id: 'fonts-minimum-size',
      label: 'Minimum font size',
      description: 'The smallest text a page may use.',
      keywords,
      value: minimumIndex,
      min: 0,
      max: MINIMUM_FONT_SIZE_STEPS.length - 1,
      step: 1,
      ends: MINIMUM_FONT_SIZE_ENDS,
      format: (i) => formatFontSize(MINIMUM_FONT_SIZE_STEPS[i] ?? fonts.minimumSize),
      onChange: (i) => {
        const minimumSize = MINIMUM_FONT_SIZE_STEPS[i]
        if (minimumSize !== undefined && minimumSize !== fonts.minimumSize) patch({ minimumSize })
      }
    }
  ]

  const slots: FontFamilySlot[] = generic ? ['standard', 'serif', 'sansSerif', 'fixed'] : ['standard']
  for (const slot of slots) {
    const current = fonts[slot]
    const options = familyOptions(current, generic ? (localFonts ?? null) : null, generic)
    const value = current ?? DEFAULT_FAMILY
    const pick = (next: string): void => patch({ [slot]: next === DEFAULT_FAMILY ? null : next })
    const label = SLOT_LABELS[slot]
    rows.push(
      {
        kind: 'value',
        id: `fonts-${slot}`,
        label,
        keywords,
        layouts: ['desktop', 'tablet'],
        value,
        options,
        sheetDescription: SLOT_HINTS[slot],
        onChange: pick
      },
      {
        kind: 'action',
        id: `fonts-${slot}-phone`,
        label,
        description: options.find((o) => o.value === value)?.label ?? value,
        keywords,
        layouts: ['phone'],
        form: {
          title: label,
          description: SLOT_HINTS[slot],
          render: (close) => (
            <FontPickList
              label={label}
              options={options}
              value={value}
              onPick={pick}
              close={close}
            />
          )
        }
      }
    )
  }

  rows.push({
    kind: 'custom',
    id: 'fonts-preview',
    label: 'Preview',
    keywords,
    bare: true,
    render: () => <FontPreview fonts={fonts} platform={state.platform} />
  })

  if (!isDefaultFontSettings(fonts)) {
    rows.push({
      kind: 'action',
      id: 'fonts-reset',
      label: 'Reset fonts',
      description: 'Back to the platform’s fonts, 16 px and no minimum size.',
      keywords: [...keywords, 'reset', 'default'],
      button: 'Reset',
      onPress: () => set({ fonts: { ...DEFAULT_FONT_SETTINGS } })
    })
  }

  return [
    {
      id: 'fonts',
      heading: 'Customise fonts',
      description: generic
        ? 'The type pages are set in when they leave it to the browser. Pages that name their own fonts keep them.'
        : 'The type pages are set in when they leave it to the browser. Pages that name their own fonts keep them. The serif, sans-serif and fixed-width faces are the system’s on this device.',
      rows
    }
  ]
}

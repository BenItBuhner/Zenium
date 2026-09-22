import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_STEPS,
  MINIMUM_FONT_SIZE_STEPS,
  isDefaultFontSettings,
  type FontFamilySlot,
  type PageFontSettings
} from '@shared/fonts'
import { FontPickList, FontPreview } from './fontBlocks'
import {
  DEFAULT_FAMILY,
  FONT_SIZE_ENDS,
  MINIMUM_FONT_SIZE_ENDS,
  SLOT_HINTS,
  SLOT_LABELS,
  familyOptions,
  formatFontSize,
  stepIndex
} from './fontsModel'
import type { RowGroup, SettingsRow } from './model'
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
  const patch = (change: Partial<PageFontSettings>): void => set({ fonts: { ...fonts, ...change } })
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

  const slots: FontFamilySlot[] = generic
    ? ['standard', 'serif', 'sansSerif', 'fixed']
    : ['standard']
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

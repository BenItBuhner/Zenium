import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_STEPS,
  MINIMUM_FONT_SIZE_STEPS,
  isDefaultFontSettings,
  type FontFamilySlot,
  type PageFontSettings
} from '@shared/fonts'
import { FontPickList, FontPreview } from './fontBlocks'
import { immediateFontsDraft } from './fontsDraft'
import {
  DEFAULT_FAMILY,
  SLOT_HINTS,
  SLOT_LABELS,
  familyOptions,
  fontSizeOptions,
  formatFontSize,
  stepIndex
} from './fontsModel'
import type { RowGroup, SettingsRow } from './model'
import type { SectionContext } from './sections'

/**
 * Settings › Appearance › Customise fonts (CT-25; Chrome's chrome://settings/fonts as one group
 * of the shared builder, §10.3): the font size and the minimum size over Chrome's stops – on
 * the phone §10.4's slider row, the value on the label's line and the 44 px step buttons at
 * the track's ends, each step moving the row and the preview at once and the pages following
 * once the sequence is quiet (`FontsDraft`: one commit per run of presses or per hold, the
 * Android performance gate's ruling for #350; the thumb let go is a step like any), so neither
 * a drag nor a run of presses re-lays the pages out per step; on the desktop §10.5's menulist
 * of the stops ("16 px", "None"), since a
 * level on a desktop page is never a slider; the family rows as §9.13 menulist rows whose
 * picker shows each face (`RowOption.font`: the desktop's popover draws an "Aa" specimen in the
 * face after the name, which stays in the chrome's type so a symbol face cannot write its own
 * name as dingbats; the phone's own picker sheet, `FontPickList`, draws the platform's word
 * aliases each in its face, since the chassis's radio rows take none, and opens expanded on
 * the checked face when its rows exceed the peek); a Reset row once anything stands off the
 * defaults, plain and unconfirmed (§10.4: a reset to the defaults is no destruction); and the
 * preview as a static content row (§10.3: a 13/69 % label over content that grows with its
 * text) in the page fonts themselves, following each step as it lands. On a host whose engine
 * ignores the generic-family slots (`capabilities.genericFontFamilies` false: Android, where
 * Blink resolves `serif` / `sans-serif` / `monospace` through `fonts.xml` and never reads the
 * settings) only the standard family and the two sizes are rows – the honest list, as the
 * interface note records – and the standard family's options are the aliases WebView resolves
 * by name.
 */

/**
 * The group: sizes, families, preview, Reset. The size and family rows come in two forms by
 * chrome layout, one per row id, so a test walks both: the desktop and tablet shells' §9.13
 * value row – the sizes' menulist of stops, the families' menulist whose popover shows each
 * option's face as a specimen (`RowOption.font`); the phone shell's §10.4 slider row for a
 * size, and its action row opening `FontPickList` in a sheet for a family, since the chassis's
 * picker sheet draws no face (`sheets.tsx`) – the row shows the current family as its
 * description like a value row does.
 */
export function fontsGroups({
  state,
  set,
  localFonts,
  fontsDraft
}: Pick<SectionContext, 'state' | 'set' | 'localFonts' | 'fontsDraft'>): RowGroup[] {
  // Every row reads the draft – the committed fonts with the ± steps not yet committed over
  // them – so a step moves the row, the preview and the Reset row together; a builder run
  // without a page's draft commits each change as it comes.
  const draft = fontsDraft ?? immediateFontsDraft(state.settings.fonts, set)
  const fonts = draft.fonts
  const generic = state.capabilities.genericFontFamilies
  const patch = (change: Partial<PageFontSettings>): void => draft.commit(change)
  const keywords = ['fonts', 'customize fonts', 'typeface', 'text size', 'font size']

  // The desktop's menulists commit a pick at once; the phone's ± rows step the draft, which
  // commits once the sequence is quiet (`FontsDraft`).
  const setSize = (size: number): void => {
    if (size !== fonts.size) patch({ size })
  }
  const setMinimumSize = (minimumSize: number): void => {
    if (minimumSize !== fonts.minimumSize) patch({ minimumSize })
  }
  const stepSize = (size: number): void => {
    if (size !== fonts.size) draft.step({ size })
  }
  const stepMinimumSize = (minimumSize: number): void => {
    if (minimumSize !== fonts.minimumSize) draft.step({ minimumSize })
  }
  const minimumDescription = 'The smallest text a page may use.'
  const rows: SettingsRow[] = [
    {
      kind: 'slider',
      id: 'fonts-size-phone',
      label: 'Font size',
      keywords,
      layouts: ['phone'],
      value: stepIndex(FONT_SIZE_STEPS, fonts.size),
      min: 0,
      max: FONT_SIZE_STEPS.length - 1,
      step: 1,
      format: (i) => formatFontSize(FONT_SIZE_STEPS[i] ?? fonts.size),
      onChange: (i) => {
        const size = FONT_SIZE_STEPS[i]
        if (size !== undefined) stepSize(size)
      },
      onLeave: () => draft.leave('size'),
      onHold: draft.hold
    },
    {
      kind: 'value',
      id: 'fonts-size',
      label: 'Font size',
      keywords,
      layouts: ['desktop', 'tablet'],
      value: String(fonts.size),
      options: fontSizeOptions(FONT_SIZE_STEPS, fonts.size),
      onChange: (v) => setSize(Number(v))
    },
    {
      kind: 'slider',
      id: 'fonts-minimum-size-phone',
      label: 'Minimum font size',
      description: minimumDescription,
      keywords,
      layouts: ['phone'],
      value: stepIndex(MINIMUM_FONT_SIZE_STEPS, fonts.minimumSize),
      min: 0,
      max: MINIMUM_FONT_SIZE_STEPS.length - 1,
      step: 1,
      format: (i) => formatFontSize(MINIMUM_FONT_SIZE_STEPS[i] ?? fonts.minimumSize),
      onChange: (i) => {
        const minimumSize = MINIMUM_FONT_SIZE_STEPS[i]
        if (minimumSize !== undefined) stepMinimumSize(minimumSize)
      },
      onLeave: () => draft.leave('minimumSize'),
      onHold: draft.hold
    },
    {
      kind: 'value',
      id: 'fonts-minimum-size',
      label: 'Minimum font size',
      description: minimumDescription,
      keywords,
      layouts: ['desktop', 'tablet'],
      value: String(fonts.minimumSize),
      options: fontSizeOptions(MINIMUM_FONT_SIZE_STEPS, fonts.minimumSize),
      onChange: (v) => setMinimumSize(Number(v))
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
          body: 'picker',
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
      onPress: () => draft.commit({ ...DEFAULT_FONT_SETTINGS })
    })
  }

  return [
    {
      id: 'fonts',
      heading: 'Customise fonts',
      // Two sentences (§10.3's density, the #322 Q6 precedent): what the group sets, then the
      // limit that matters on this host – the Standard font row's own hint already says which
      // text a page leaves to the browser.
      description: generic
        ? 'The type pages are set in when they leave it to the browser. Pages that name their own fonts keep them.'
        : 'The type pages are set in when they leave it to the browser. The serif, sans-serif and fixed-width faces are the system’s on this device.',
      rows
    }
  ]
}

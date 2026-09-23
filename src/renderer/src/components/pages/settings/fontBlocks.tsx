import type { CSSProperties, JSX } from 'react'
import { monospaceFontSize, type PageFontSettings } from '@shared/fonts'
import type { Platform } from '@shared/types'
import { RadioOption } from './blocks'
import { cssFamily, previewFamilies } from './fontsModel'
import type { RowOption } from './model'

/**
 * The Customise fonts group's two drawn pieces (CT-25; `fonts.tsx` builds the rows around them):
 * the preview paragraph, and the phone's family picker.
 */

/**
 * The preview (§10.3's static content row: a 13/69 % label over content the row is there to
 * show, growing with it): the label, then two sample lines – the standard family at the chosen
 * size, then the fixed-width family at Chrome's ratio of it, both floored by the minimum size
 * as a page's text would be, so the row shows what a page gets, in the page's own type, not
 * the chrome's – and the label's description under them. The samples are pictures of type,
 * not copy to read (the zoom block's sample is the same), so they are `aria-hidden` and a
 * reader hears the label and its description.
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
      data-row="fonts-preview"
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
      <span className="zen-settings-description" data-part="label">
        Preview
      </span>
      <p data-face="standard" lang="en" aria-hidden="true">
        The quick brown fox jumps over the lazy dog. 0123456789
      </p>
      <p data-face="fixed" lang="en" aria-hidden="true">
        for (const page of tabs) page.render(fonts);
      </p>
      <span className="zen-settings-description" data-part="description">
        How a page’s text and its fixed-width text look with these settings.
      </span>
    </div>
  )
}

/**
 * The phone's family picker (§9.13's sheet of radio rows, drawn here rather than by the
 * chassis's option sheet so that each row is in its own face – `RadioOption`'s `font`): the
 * current family checked and focused as the sheet opens (§9.22 – the chassis focuses the checked
 * radio), a pick sets the family and closes the sheet. The rows' labels are drawn in their
 * faces because the phone's options are the platform's word aliases (Serif, Casual, Cursive…),
 * every one a face that writes its own name; the desktop's list of installed families, where a
 * symbol face cannot, keeps its names in the chrome's type with a specimen beside them instead
 * (`MenulistOption.font`).
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
        <RadioOption
          key={option.value}
          label={option.label}
          description={option.description}
          font={option.font}
          checked={option.value === value}
          onSelect={() => {
            if (option.value !== value) onPick(option.value)
            close()
          }}
        />
      ))}
    </div>
  )
}

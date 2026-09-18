import type { JSX } from 'react'
import type { AutofillPicker, UIState } from '@shared/types'
import { currentPicker } from '@renderer/lib/autofill'
import { returnFocusToPage } from '@renderer/lib/ui'
import { PickerPanel } from './PickerPanel'

/**
 * The picker on a host without a popup surface (the phone): a strip docked at the bottom of the
 * content frame, above the keyboard, so the page shrinks around it the way it does for the find
 * bar (`ContentArea` puts it after the viewport). Its rows are `PickerPanel`'s at the phone's
 * 44 / 64 pitch; at most three show before the strip scrolls. A tap on a row fills the field and
 * the core closes the picker; the field keeps the keyboard.
 */
export function PickerStrip({ state }: { state: UIState }): JSX.Element | null {
  if (state.capabilities.popupSurface) return null
  const picker = currentPicker(state)
  if (!picker) return null
  return <Strip key={picker.id} picker={picker} />
}

function Strip({ picker }: { picker: AutofillPicker }): JSX.Element {
  return (
    <div
      role="region"
      aria-label={picker.manageLabel.replace(/^Manage /, 'Saved ')}
      className="zen-v2-af zen-v2-af-strip"
      data-surface="page"
      data-af-strip=""
    >
      <PickerPanel picker={picker} highlightFirst={false} onFilled={returnFocusToPage} />
    </div>
  )
}

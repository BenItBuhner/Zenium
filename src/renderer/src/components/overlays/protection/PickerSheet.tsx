import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useBackSurface } from '@renderer/lib/back'
import { ChromePortal } from '@renderer/lib/portals'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'

export interface PickerOption<V extends string> {
  value: V
  label: string
  /** A second line under the label, 13 at 69% (§9.2). */
  description?: string
}

/**
 * The phone's menulist (design-language-v2-draft §9.13, §10.4): a `--v2-panel` sheet on the
 * chassis `BottomSheet`, portalled through the chrome layer so the frame's transform never
 * offsets it. After the grip strip a 48 header with the row's label centred (§9.16), or – when
 * the row had a description – a title block instead (§9.23: the label 17/600 at 22, the
 * description 15 at 69% on the 22 line 4 under it, 16 to the body). Then radio rows 44 tall
 * (64 with a description) edge to edge with their text inset 16 (§9.25), the current option
 * checked; picking one moves the check at once, closes the sheet and then applies the value, so
 * the pane under it never changes while the sheet is still up. Its scrim is `--v2-scrim` on the
 * chassis's own scrim element (§9.28); Escape, the back gesture and the scrim close it, and the
 * chassis returns the row's focus. Never a native `<select>` and never a popover here (§9.13).
 */
export function PickerSheet<V extends string>({
  title,
  description,
  value,
  options,
  onPick,
  onClose
}: {
  title: string
  description?: string
  value: V
  options: ReadonlyArray<PickerOption<V>>
  onPick: (value: V) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [picked, setPicked] = useState(value)
  // What the dismissal applies: the state above is for the check, this for the callback.
  const chosen = useRef(value)
  const titleId = useId()
  const name = useId()

  useBackSurface({
    name: 'protection-picker',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Claimed: the overlay under the sheet (`useGlobalKeys`) leaves a prevented Escape alone.
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <ChromePortal>
      <div className="zen-protection-sheet-layer contents">
        <BottomSheet
          ref={sheet}
          className="zen-protection-sheet"
          handleLabel={`Resize ${title} options`}
          onDismissed={() => {
            const next = chosen.current
            onClose()
            if (next !== value) onPick(next)
          }}
          header={
            description ? (
              <div className="zen-protection-sheet-title">
                <h2 id={titleId}>{title}</h2>
                <p>{description}</p>
              </div>
            ) : (
              <div className="zen-protection-sheet-header">
                <h2 id={titleId}>{title}</h2>
              </div>
            )
          }
        >
          <div role="radiogroup" aria-labelledby={titleId} className="zen-protection-sheet-rows">
            {options.map((option) => (
              <label key={option.value} className="zen-protection-sheet-row">
                <input
                  type="radio"
                  className="zen-v2-radio"
                  name={name}
                  value={option.value}
                  checked={option.value === picked}
                  onChange={() => {
                    chosen.current = option.value
                    setPicked(option.value)
                    sheet.current?.dismiss()
                  }}
                />
                <span className="zen-privacy-row-text">
                  <span className="zen-privacy-row-label block">{option.label}</span>
                  {option.description && (
                    <span className="zen-privacy-row-desc">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </BottomSheet>
      </div>
    </ChromePortal>
  )
}

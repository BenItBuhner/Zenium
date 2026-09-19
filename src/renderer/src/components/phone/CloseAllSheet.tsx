import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * "Close all tabs" asks first (matrix TAB-06): a prompt sheet on the frame's dialog host (v2
 * draft §9.23 – grip strip, title block with the glyph, the one paragraph, the §9.11 footer)
 * saying how many tabs go, with a "Don't ask again" checkbox row that turns the question off
 * for good (`settings.confirmCloseAll`) – switched off only by an answer that goes ahead, as
 * the window prompt's checkbox is. Escape, the scrim, the back gesture and Cancel keep the tabs;
 * Close all, in the danger ink (§10.4), closes them once the sheet is gone, so the cards leave
 * in the open. Focus starts on Cancel so a stray Enter does no harm.
 */
export function CloseAllSheet({
  count,
  spaceName,
  onClose,
  onConfirm
}: {
  count: number
  spaceName: string
  onClose: () => void
  /** Close the tabs; `askAgain` false turns the question off. */
  onConfirm: (askAgain: boolean) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [dontAsk, setDontAsk] = useState(false)
  const tabs = count === 1 ? '1 tab' : `${count} tabs`
  return (
    <PhoneSheet
      name="overview-close-all"
      title={`Close ${tabs}?`}
      prompt={{
        icon: <X className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: `Every open tab in ${spaceName} closes; pinned tabs and Essentials stay. Undo on the toast brings the tabs back.`
      }}
      focus="first"
      onClose={onClose}
      // One detent: a drag on the grip only sends the prompt away (as the security prompt's).
      handleLabel="Dismiss"
      sheetRef={sheet}
    >
      <label className="zen-v2-row zen-v2-check-row items-start">
        <input
          type="checkbox"
          className="zen-v2-checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <span className="min-w-0 flex-1">{"Don't ask again"}</span>
      </label>
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          onClick={() => sheet.current?.dismiss(() => onConfirm(!dontAsk))}
        >
          Close all
        </button>
      </div>
    </PhoneSheet>
  )
}

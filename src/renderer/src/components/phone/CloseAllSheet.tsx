import type { JSX } from 'react'
import { useRef } from 'react'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * The private view's "Close Private Tabs" asks first (matrix TAB-03, INC-04): a prompt sheet on
 * the frame's dialog host (v2 draft §9.23 – grip strip, title block, the one paragraph, the
 * §9.11 footer) saying how many private tabs go. Closing them ends the session and wipes its
 * data, and a private tab is never filed, so there is no Undo to stand in for the question –
 * which is why this view alone still asks: the regular view's Close All Tabs closes at once with
 * Undo on its toast (§9.23: an act the user can take back from its toast asks nothing, and the
 * two never stack). A confirmation of the user's own command carries no glyph (§9.23, Chrome's
 * and Firefox's quit warnings carry none), and no "Don't ask again": the question is the only
 * guard there is. Escape, the scrim, the back gesture and Cancel keep the tabs; Close all, in
 * the danger ink (§10.4), closes them once the sheet is gone, so the cards leave in the open.
 * The focus starts on the sheet itself (§9.22: a prompt lands on its dialog, never on Cancel),
 * so a stray Enter does no harm.
 */
export function CloseAllSheet({
  count,
  onClose,
  onConfirm
}: {
  count: number
  onClose: () => void
  /** Close the private tabs. */
  onConfirm: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const tabs = count === 1 ? '1 private tab' : `${count} private tabs`
  return (
    <PhoneSheet
      name="overview-close-all"
      // A prompt: the title block (§9.23); its one paragraph is the description.
      title={{
        pose: 'block',
        text: `Close ${tabs}?`,
        description:
          'Every private tab closes and the private session ends; its history, cookies and site data go with it. There is no undo.'
      }}
      focus="dialog"
      onClose={onClose}
      // One detent: a drag on the grip only sends the prompt away (as the security prompt's).
      handleLabel="Dismiss"
      sheetRef={sheet}
    >
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          onClick={() => sheet.current?.dismiss(() => onConfirm())}
        >
          Close all
        </button>
      </div>
    </PhoneSheet>
  )
}

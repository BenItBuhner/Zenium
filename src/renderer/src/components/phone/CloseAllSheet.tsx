import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * The menu's "Close All Tabs" asks first (matrix TAB-06): a prompt sheet on the frame's dialog host (v2
 * draft §9.23 – grip strip, title block with the glyph, the one paragraph, the §9.11 footer)
 * saying how many tabs go, with a "Don't ask again" checkbox row that turns the question off
 * for good (`settings.confirmCloseAll`) – switched off only by an answer that goes ahead, as
 * the window prompt's checkbox is. Escape, the scrim, the back gesture and Cancel keep the tabs;
 * Close all, in the danger ink (§10.4), closes them once the sheet is gone, so the cards leave
 * in the open. The focus starts on the checkbox row – §9.22: a sheet whose first control is a
 * checkbox opens on it, the chassis's own order; landing on Cancel is the failure the section
 * names – so a stray Enter does no harm. From the private pane the
 * question is the same sheet about the private tabs (TAB-03): closing them ends the session and
 * wipes its data (INC-04), and nothing is filed for an undo, so the description says so.
 */
export function CloseAllSheet({
  count,
  spaceName,
  privateTabs = false,
  onClose,
  onConfirm
}: {
  count: number
  spaceName: string
  /** Whether the tabs are the private ones (the private pane's Close Private Tabs). */
  privateTabs?: boolean
  onClose: () => void
  /** Close the tabs; `askAgain` false turns the question off. */
  onConfirm: (askAgain: boolean) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [dontAsk, setDontAsk] = useState(false)
  const noun = privateTabs ? 'private tab' : 'tab'
  const tabs = count === 1 ? `1 ${noun}` : `${count} ${noun}s`
  return (
    <PhoneSheet
      name="overview-close-all"
      // A prompt: the title block (§9.23); its one paragraph is the description.
      title={{
        pose: 'block',
        text: `Close ${tabs}?`,
        icon: <X className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: privateTabs
          ? 'Every private tab closes and the private session ends; its history, cookies and site data go with it. There is no undo.'
          : `Every open tab in ${spaceName} closes; pinned tabs and Essentials stay. Undo on the toast brings the tabs back.`
      }}
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

import type { JSX } from 'react'
import { useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { Suggestion } from '@shared/types'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from '../phone/PhoneSheet'

/**
 * The phone's removal of a suggestion asks first (OMN-17, Chrome for Android's hold): a prompt
 * sheet on the frame's dialog host (v2 draft §9.23 – grip strip, the title block with its glyph,
 * the one paragraph, the §9.11 footer), the one prompt form every confirmation of the app takes
 * (History's Clear all, the overview's Close all). The title asks the question; the description
 * is the suggestion's text, so what goes is named; Cancel | Remove are peers in the footer,
 * Remove in the danger ink (§10.4). Escape, the scrim, the back gesture and Cancel keep the
 * row; Remove forgets the entry once the sheet has gone, so the row's collapse (§11.4) runs in
 * the open. The focus starts on the sheet itself (§9.22: a title-and-notice sheet holds its
 * container, named by the question and described by the entry; landing on Cancel is the
 * failure the section names), so a stray Enter removes nothing, and returns to the field once
 * the sheet is gone (§9.24), whichever way it was answered.
 */
export function RemoveSuggestionSheet({
  item,
  onClose,
  onConfirm
}: {
  item: Suggestion
  /** The sheet has left the screen. */
  onClose: () => void
  /** Remove was the answer: forget the suggestion. Runs once the sheet has gone. */
  onConfirm: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <PhoneSheet
      name="urlbar-remove"
      // A prompt: the title block (§9.23) with the glyph on the title's start.
      title={{
        pose: 'block',
        text: 'Remove suggestion from history?',
        icon: <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: suggestionText(item)
      }}
      focus="dialog"
      onClose={onClose}
      // One detent: a drag on the grip only sends the prompt away.
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
          onClick={() => sheet.current?.dismiss(onConfirm)}
        >
          Remove
        </button>
      </div>
    </PhoneSheet>
  )
}

/**
 * The suggestion as its row reads it: the title, and for a page row the address after it in the
 * palette's form (§6: title, then ` — `, then the host) – a remembered search is its query alone,
 * as its row shows nothing beside it; a page whose title is its address says it once.
 */
function suggestionText(item: Suggestion): string {
  const address = item.url ? item.subtitle : ''
  return address && address !== item.title ? `${item.title} — ${address}` : item.title
}

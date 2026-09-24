import type { JSX } from 'react'
import { useViewport } from '@renderer/lib/formFactor'
import { CLEAR_ALL_PROMPT } from '@renderer/lib/downloadsView'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { ConfirmSheet } from '../pages/settings/sheets'

/**
 * "Clear all" asks before it empties the list, saying how many rows go and that the files stay
 * (the engine's `removeCompleted` leaves transfers still running alone), on the program's
 * confirmation primitive: the desktop's `ConfirmDialog` (components/dialogs – §9.20's 320
 * notice on the frame's dialog host, the question as the title block over its one paragraph,
 * Cancel | Clear all as §9.11 peers) and on the phone its sheet mirror, `ConfirmSheet`
 * (pages/settings/sheets.tsx – the form every phone confirmation takes, `SiteDataPrompt`'s
 * sheet form among them), chosen the way the Settings chassis chooses its host, by the
 * viewport's form factor. One prompt for both Downloads surfaces: the page tab of the desktop
 * and the tablet (`pages/downloads/DownloadsPage.tsx`) and the phone's sheet
 * (`DownloadsSheet.tsx`), which is what `zen://downloads` opens as on a phone
 * (`shared/internalPages.ts`, `TAB_LAYOUTS`). The keyboard is the primitive's on both (§9.22
 * as amended on #392): the container holds the focus as the prompt opens, named by the
 * question and described by the paragraph; Tab reaches Cancel then the verb; Escape and the
 * scrim are Cancel and the focus goes back to Clear all.
 *
 * The clear is DESTRUCTIVE (§6, §10.5): it is the bulk action – the list emptied, which §10.5
 * says confirms – and a download record is a history-class record (Chrome keeps it in the
 * History database and clears it as "Download history"; §6 names "remove a history entry" among
 * the data-destroying verbs), whose facts – the source URL, the referrer, the time – the file
 * on disk cannot give back, so the lead's plain reading for a preference the user can re-derive
 * (#418 ruling 5, #431 Q1) does not reach it. The verb is in the danger ink beside Cancel,
 * there is no primary and no default key: Enter from the held container is inert.
 */
export function ClearAllConfirm({
  count,
  close,
  confirm
}: {
  count: number
  /** The prompt has gone (Cancel, Escape, the scrim; on the phone after the verb too). */
  close: () => void
  /** The verb. */
  confirm: () => void
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const rows = count === 1 ? '1 download' : `${count} downloads`
  const title = 'Clear all downloads?'
  const description = `${rows} will be removed from the list. The files stay where they were saved, and downloads still running are not touched.`
  if (phone) {
    // The sheet leaves with its motion first, then the clear runs and the surface hears the close.
    return (
      <ConfirmSheet
        name={CLEAR_ALL_PROMPT}
        title={title}
        description={description}
        action="Clear all"
        destructive
        under={false}
        onClose={close}
        onConfirm={confirm}
      />
    )
  }
  // The prompt closes first and the clear runs at once (the dialog has no motion to wait for).
  return (
    <ConfirmDialog
      name={CLEAR_ALL_PROMPT}
      title={title}
      description={description}
      action="Clear all"
      destructive
      onCancel={close}
      onConfirm={() => {
        close()
        confirm()
      }}
    />
  )
}

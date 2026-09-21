import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PageDialog, PageDialogResponse, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import {
  closePageDialog,
  currentPageDialog,
  openPageDialog,
  pageDialogAcceptLabel,
  pageDialogTitle
} from '@renderer/lib/pageDialogs'
import { wrapTab } from '../bookmarks/popover'
import { useEscapeTrap } from '../bookmarks/escape'

/**
 * The dialogs a page opens – `alert`, `confirm`, `prompt` – and the "Leave site?" question its
 * `beforeunload` handler raises, shown the way Chrome shows them: tab-modal, hanging under the
 * address bar over a dimmed picture of the page, one at a time, oldest first, only while their
 * tab is the one on screen. The page waits for the answer; the core forwards it. Rendered
 * inside TabDialogs' `FrameDialogHost`, over its scrim (which dims the content frame only); the
 * scrim does not answer them – Chrome's dialogs stay up until answered.
 */
export function PageDialogs({ state }: { state: UIState }): JSX.Element | null {
  const dialog = currentPageDialog(state)
  if (!dialog) return null
  return <PageDialogView key={dialog.id} dialog={dialog} />
}

/**
 * A v2 dialog (draft §9.23): the site as the title block, the message as the body, a 32 px
 * field with the default text for `prompt`, OK / Cancel (Leave / Stay for `beforeunload`).
 * Enter accepts, Escape cancels (an alert has nothing to cancel: it is dismissed), Tab wraps,
 * and focus starts in the field or on the accepting button (§9.22). It sits at the top of the
 * frame, under the address bar, where Chrome hangs it.
 */
function PageDialogView({ dialog }: { dialog: PageDialog }): JSX.Element {
  const answered = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const [value, setValue] = useState(dialog.defaultValue)
  const prompt = dialog.kind === 'prompt'
  const leave = dialog.kind === 'beforeunload'
  const cancellable = dialog.kind !== 'alert'

  // The page's view hides under chrome overlays; its snapshot stands in while the dialog is up.
  useEffect(() => {
    let gone = false
    void openPageDialog(dialog.tabId).then(() => {
      if (gone) closePageDialog()
    })
    return () => {
      gone = true
      closePageDialog()
    }
  }, [dialog.tabId])

  useEffect(() => {
    if (prompt) {
      fieldRef.current?.focus()
      fieldRef.current?.select()
    } else {
      acceptRef.current?.focus()
    }
  }, [prompt])

  const respond = (response: PageDialogResponse): void => {
    if (answered.current) return
    answered.current = true
    run('pageDialog.respond', { id: dialog.id, response })
  }
  const accept = (): void => respond({ accepted: true, value: prompt ? value : null })
  const cancel = (): void => (cancellable ? respond({ accepted: false, value: null }) : accept())

  // Escape, and the system back gesture or button on Android, are Cancel.
  useEscapeTrap(true, cancel)
  useBackSurface({ name: 'page-dialog', onCommit: cancel })
  useFrameDialog()

  const titleId = `zen-page-dialog-title-${dialog.id}`
  const bodyId = `zen-page-dialog-body-${dialog.id}`
  return (
    <div
      ref={dialogRef}
      role={leave || dialog.kind === 'alert' ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={dialog.message || leave ? bodyId : undefined}
      data-page-dialog={dialog.kind}
      className="zen-animate-pop zen-bm-dialog mt-3 flex max-h-[calc(100%-24px)] max-w-[calc(100%-24px)] flex-col self-start"
      style={{ width: POPOVER_WIDTH.form }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => wrapTab(e, dialogRef.current)}
    >
      <div className="zen-bm-title-block">
        <h2 id={titleId} className="zen-bm-title">
          {pageDialogTitle(dialog)}
        </h2>
        {leave && (
          <p id={bodyId} className="zen-bm-title-desc">
            Changes you made may not be saved.
          </p>
        )}
      </div>
      <form
        className="zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          accept()
        }}
      >
        {!leave && dialog.message && (
          <p
            id={bodyId}
            className="max-h-[40vh] overflow-y-auto text-[13px] leading-[var(--v2-line-small)] whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {dialog.message}
          </p>
        )}
        {prompt && (
          <input
            ref={fieldRef}
            className="zen-field"
            aria-label="Your answer"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <div className="zen-bm-footer justify-end">
          {cancellable && (
            <button type="button" className="zen-button" onClick={cancel}>
              {leave ? 'Stay' : 'Cancel'}
            </button>
          )}
          <button ref={acceptRef} type="submit" className="zen-button" data-variant="primary">
            {pageDialogAcceptLabel(dialog)}
          </button>
        </div>
      </form>
    </div>
  )
}

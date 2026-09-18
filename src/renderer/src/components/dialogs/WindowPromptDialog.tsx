import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState, WindowPrompt } from '@shared/types'
import { run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { wrapTab } from '../bookmarks/popover'
import { useEscapeTrap } from '../bookmarks/escape'

/**
 * The questions the core asks about the window as a whole before it closes ("Close N tabs?")
 * or Zenium quits ("Quit Zenium?"): one at a time per window, over the page's picture, in the
 * middle of the content frame through TabDialogs' `FrameDialogHost` (whose scrim dims the frame
 * only, §9.5). The answer goes back to the flow that asked, which then goes on or stops.
 */
export function WindowPromptDialog({ state }: { state: UIState }): JSX.Element | null {
  const prompt = state.window.prompt
  if (!prompt) return null
  return <WindowPromptView key={prompt.id} prompt={prompt} tabId={activeTab(state)?.id ?? null} />
}

/** How long the dialog waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/**
 * A v2 dialog (draft §9.23): title, one line of description, a checkbox that turns the warning
 * off for good (Firefox's), Cancel and one primary button. Enter accepts, Escape and the scrim
 * cancel, Tab wraps, focus starts on the primary (§9.22).
 */
function WindowPromptView({
  prompt,
  tabId
}: {
  prompt: WindowPrompt
  tabId: string | null
}): JSX.Element {
  const answered = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const [keepWarning, setKeepWarning] = useState(true)

  useEffect(() => {
    let gone = false
    void Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ]).then(() => {
      if (gone) return
      run('focus.chrome', undefined)
      uiStore.set({ windowPromptOpen: true })
      acceptRef.current?.focus()
    })
    return () => {
      gone = true
      if (uiStore.get().windowPromptOpen) uiStore.set({ windowPromptOpen: false })
      invalidateSnapshot()
      returnFocusToPage()
    }
  }, [tabId])

  const respond = (accepted: boolean): void => {
    if (answered.current) return
    answered.current = true
    // The warning is switched off only by an answer that goes ahead; a cancelled close changes
    // nothing.
    if (accepted && !keepWarning) run('settings.update', { warnOnCloseWindow: false })
    run('window.respondPrompt', { id: prompt.id, accepted })
  }
  const cancel = (): void => respond(false)
  useEscapeTrap(true, cancel)
  useFrameDialog({ onScrimPress: cancel })

  const quit = prompt.kind === 'quit'
  const n = prompt.count
  const tabs = n === 1 ? '1 tab' : `${n} tabs`
  const titleId = `zen-window-prompt-title-${prompt.id}`
  const descId = `zen-window-prompt-desc-${prompt.id}`
  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-window-prompt={prompt.kind}
      className="zen-animate-pop zen-bm-dialog flex max-w-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => wrapTab(e, dialogRef.current)}
    >
      <div className="zen-bm-title-block">
        <h2 id={titleId} className="zen-bm-title">
          {quit ? 'Quit Zenium?' : `Close ${tabs}?`}
        </h2>
        <p id={descId} className="zen-bm-title-desc">
          {quit
            ? `You are about to quit with ${tabs} open.`
            : `You are about to close this window and its ${tabs}.`}
        </p>
      </div>
      <form
        className="zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          respond(true)
        }}
      >
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--v2-accent)]"
            checked={keepWarning}
            onChange={(e) => setKeepWarning(e.target.checked)}
          />
          Warn before closing a window with multiple tabs
        </label>
        <div className="zen-bm-footer justify-end">
          <button type="button" className="zen-button" onClick={cancel}>
            Cancel
          </button>
          <button ref={acceptRef} type="submit" className="zen-button" data-variant="primary">
            {quit ? 'Quit' : 'Close tabs'}
          </button>
        </div>
      </form>
    </div>
  )
}

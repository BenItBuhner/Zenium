import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState, WindowPrompt } from '@shared/types'
import { run } from '@renderer/lib/api'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { windowPromptText } from '@renderer/lib/windowPrompt'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The questions the core asks about the window as a whole before it closes ("Close N tabs?")
 * or Zenium quits ("Quit Zenium?"), and about the downloads the answer would end (downloads-35):
 * one at a time per window, over the page's picture, in the middle of the content frame through
 * TabDialogs' `FrameDialogHost` (whose scrim dims the frame only, §9.5). The answer goes back to
 * the flow that asked, which then goes on or stops.
 */
export function WindowPromptDialog({ state }: { state: UIState }): JSX.Element | null {
  const prompt = state.window.prompt
  if (!prompt) return null
  return <WindowPromptView key={prompt.id} prompt={prompt} tabId={activeTab(state)?.id ?? null} />
}

/** How long the dialog waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/**
 * The §9.23 confirmation (`ConfirmDialog`): the title and ONE description – the tabs sentence
 * and, when downloads are in progress too, their sentence after it in the same paragraph (the
 * two facts are peers; the body is for copy that introduces other content, and the checkbox is
 * the tabs warning's, not the sentence's) – then the checkbox that turns the tabs warning off
 * for good (Firefox's) as the body's one element, Cancel and the primary verb. Alone, the
 * download sentence is the description and the checkbox stays away (nothing about the tabs is
 * asked). The keyboard is the primitive's (§9.22): the container holds the focus, Enter
 * answers with the verb, Escape and the scrim with Cancel.
 *
 * The way back: the page had the keyboard when the chord or the window's close button asked,
 * so the page takes it back as the prompt goes (`returnFocusToPage`) – unless a control of the
 * chrome had it, with its ring, as the prompt came (the quit chord from a focused toolbar
 * button, the app menu's Quit by keyboard): then the prompt's own one-hop return to that
 * control governs (§9.22) and the page is not asked to take the keyboard from it.
 */
function WindowPromptView({
  prompt,
  tabId
}: {
  prompt: WindowPrompt
  tabId: string | null
}): JSX.Element {
  const answered = useRef(false)
  const [keepWarning, setKeepWarning] = useState(true)
  // Read as the view first renders, before the prompt's container takes the focus itself.
  const [fromChrome] = useState(openedFromKeyboard)

  useEffect(() => {
    let gone = false
    void Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ]).then(() => {
      if (gone) return
      run('focus.chrome', undefined)
      uiStore.set({ windowPromptOpen: true })
    })
    return () => {
      gone = true
      if (uiStore.get().windowPromptOpen) uiStore.set({ windowPromptOpen: false })
      invalidateSnapshot()
      if (!fromChrome) returnFocusToPage()
    }
  }, [tabId, fromChrome])

  const respond = (accepted: boolean): void => {
    if (answered.current) return
    answered.current = true
    // The warning is switched off only by an answer that goes ahead; a cancelled close changes
    // nothing.
    if (accepted && !keepWarning) run('settings.update', { warnOnCloseWindow: false })
    run('window.respondPrompt', { id: prompt.id, accepted })
  }

  const text = windowPromptText(prompt)
  return (
    <ConfirmDialog
      name="window-prompt"
      title={text.title}
      description={text.description || undefined}
      action={text.verb}
      checkbox={
        text.tabsWarning
          ? {
              label: 'Warn before closing a window with multiple tabs',
              checked: keepWarning,
              onChange: setKeepWarning
            }
          : undefined
      }
      onCancel={() => respond(false)}
      onConfirm={() => respond(true)}
      returnFocus={fromChrome ? undefined : false}
      data={{ 'data-window-prompt': prompt.kind, 'data-downloads': prompt.downloads?.count }}
    />
  )
}

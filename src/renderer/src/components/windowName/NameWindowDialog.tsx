import type { JSX } from 'react'
import { useState } from 'react'
import type { UIState } from '@shared/types'
import { WINDOW_NAME_MAX } from '@shared/windowTitle'
import { run } from '@renderer/lib/api'
import { closeNameWindow, uiStore } from '@renderer/lib/ui'
import { PromptDialog } from '../dialogs/ConfirmDialog'

/**
 * Chrome's Name window prompt (More tools › Name window…, the tab strip's row;
 * shortcuts-menus-121, -149, context-menus-108): the program's one-field prompt
 * (`PromptDialog`, W4-14 – the confirmation primitive with §9.12's field for its body) at
 * §9.20's 400 – the `form` width, a field's and a wrapping description's (at 288 the sentence
 * under the title ran to three lines; at 368 it is two); #392's 320 is for a prompt over another
 * dialog, which this is not – on TabDialogs' `FrameDialogHost`, over the page's picture, while
 * `uiStore.nameWindowOpen` is set. One field holding the window's current name, focused and
 * selected so typing replaces it (a form focuses its first field – the prompt's rule for a
 * field, not the confirmation's container focus); Enter saves (an emptied field clears the name,
 * as Chrome's does), Escape and the scrim cancel, Tab wraps. The footer is the primitive's
 * Cancel · Save at 96 | 8 | 96 (§9.11). The field carries no placeholder – Chrome's is empty,
 * and the label as a placeholder said nothing the `aria-label` does not (the #396 ruling). The
 * answer is the core's `window.setName`; the title bar and tab search follow from there. Every
 * way out hands the keyboard to the page through `closeNameWindow` (`returnFocus: false` – the
 * prompt returns nothing of its own).
 */
export function NameWindowDialog({ state }: { state: UIState }): JSX.Element | null {
  const open = uiStore.use((s) => s.nameWindowOpen)
  if (!open) return null
  return <NameWindowView key={state.window.id} current={state.window.name} />
}

function NameWindowView({ current }: { current: string | null }): JSX.Element {
  const [name, setName] = useState(current ?? '')
  const save = (): void => {
    const next = name.trim()
    run('window.setName', { name: next ? next : null })
    closeNameWindow()
  }
  return (
    <PromptDialog
      name="name-window"
      title="Name window"
      description="The name stands in the title bar and in tab search in place of the active tab’s title."
      field={{
        label: 'Window name',
        value: name,
        onChange: setName,
        maxLength: WINDOW_NAME_MAX,
        autoSelect: true
      }}
      action="Save"
      onCancel={closeNameWindow}
      onConfirm={save}
      returnFocus={false}
      data={{ 'data-name-window-dialog': '' }}
    />
  )
}

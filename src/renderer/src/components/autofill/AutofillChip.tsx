import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CreditCard, KeyRound, MapPin } from 'lucide-react'
import type { AutofillPrompt, Tab, UIState } from '@shared/types'
import { chipPrompt, enterAutofillPrompt, toggleAutofillPrompt } from '@renderer/lib/autofill'
import { uiStore } from '@renderer/lib/ui'
import { PillChip } from '../urlbar/PillChip'
import { TOOLBAR_STROKE } from '../v2/controls'

/** What the chip stands for, in its name and tooltip. */
function chipLabel(prompt: Exclude<AutofillPrompt, { kind: 'passkey-account' }>): string {
  switch (prompt.kind) {
    case 'save-login':
      return 'Save password'
    case 'update-login':
      return 'Update password'
    case 'save-address':
      return 'Save address'
    case 'save-card':
      return 'Save card'
  }
}

/**
 * The key at the trailing end of the address pill while a save / update prompt is pending for
 * the page (Chrome's key icon; a pin for an address, a card for a card): the desktop prompt
 * hangs from it (`AutofillPrompts`), and once Escape or a press outside has put the prompt away
 * the chip brings it back. Pressing it while the prompt is up puts the prompt away. One of the
 * pill's chips (`PillChip`, design language v2 §9.22): a 28 px icon button in the tab order
 * after the address, with `aria-expanded` and the pressed fill while its popover is open
 * (§9.20). Nothing renders while no prompt is pending.
 */
export function AutofillChip({ state, tab }: { state: UIState; tab: Tab }): JSX.Element | null {
  const prompt = chipPrompt(state)
  const collapsed = uiStore.use((s) => s.autofillPromptCollapsed)
  if (!prompt || prompt.tabId !== tab.id) return null
  const open = collapsed !== prompt.id
  const label = chipLabel(prompt)
  const Glyph =
    prompt.kind === 'save-address' ? MapPin : prompt.kind === 'save-card' ? CreditCard : KeyRound
  // The prompt stands right after the chip in the Tab order (§9.22): it renders in the chrome
  // layer at the end of the document, and a prompt the page raised took no focus, so the chip's
  // Tab steps into it.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Tab' || e.shiftKey || !open) return
    if (enterAutofillPrompt()) e.preventDefault()
  }
  return (
    <PillChip
      label={label}
      title={open ? `${label} (hide the prompt)` : `${label}…`}
      popup="dialog"
      expanded={open}
      data-af-chip=""
      data-open={open ? 'true' : 'false'}
      className="zen-v2-af-chip flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
      onActivate={() => toggleAutofillPrompt(prompt.id)}
      onKeyDown={onKeyDown}
    >
      <Glyph className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
    </PillChip>
  )
}

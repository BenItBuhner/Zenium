import type { CredentialLeakAction, CredentialLeakWarning, UIState } from '@shared/types'
import { run } from './api'
import { currentSecurityPrompt } from './security'
import { activeTab } from './selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from './ui'

/**
 * The sign-in leak warning (ID-31, `components/autofill/LeakWarning.tsx`): what the chrome
 * shows of `UIState.passwords.leaks`, and how it goes up over the page and comes down. Chrome's
 * words: the dialog is titled "Change your password" and says why in one sentence; Zenium's name
 * stands where Chrome's password manager's does.
 */

/** Sentence case, as every dialog and sheet title (v2 §9.1). */
export const LEAK_WARNING_TITLE = 'Change your password'
export const LEAK_WARNING_BODY =
  'The password you just used was found in a data breach. Zenium recommends changing it now.'
/** The account row's title when the form carried no username (the manager's own words). */
export const LEAK_WARNING_NO_USERNAME = 'No username'

/** How long the warning waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/**
 * The warning this window shows now: its active tab's, if any. A security prompt on the same
 * tab goes first – its request is what the page is stuck on – as it does for the autofill
 * prompts (`currentAutofillPrompt`).
 */
export function currentLeakWarning(state: UIState): CredentialLeakWarning | null {
  if (currentSecurityPrompt(state)) return null
  const tabId = activeTab(state)?.id ?? null
  if (!tabId) return null
  return (state.passwords?.leaks ?? []).find((w) => w.tabId === tabId) ?? null
}

/**
 * How long a phone save sheet that has not risen yet holds for its sign-in's leak check: the
 * lookup is one padded range request, well under this on any network worth waiting for; a slower
 * one does not keep the prompt, and a warning that arrives later waits behind the sheet instead.
 */
export const LEAK_HOLD_MS = 3000

/**
 * What a phone save sheet that has not risen yet waits for (`AutofillPrompts`): Chrome shows the
 * warning first, and two sheets never stack for this – so the sheet holds while a warning is up
 * for its tab (`'warning'`), and while the tab's check is still running (`'check'`,
 * `passwords.leakChecks`) until the surface's `LEAK_HOLD_MS` runs out. On a mouse the warning is
 * a frame dialog and this does not apply.
 */
export function savePromptHold(
  state: UIState,
  tabId: string | null | undefined
): 'warning' | 'check' | null {
  if (!tabId) return null
  if ((state.passwords?.leaks ?? []).some((w) => w.tabId === tabId)) return 'warning'
  return (state.passwords?.leakChecks ?? []).includes(tabId) ? 'check' : null
}

/**
 * Which open of the warning is current: an open that finishes after a close (the user answered
 * within the wait for the picture) must not hide the page under a warning that has gone.
 */
let generation = 0

/**
 * The warning is about to show over `tabId`: the page is captured – not for long, the sign-in's
 * landing page may still be painting – and gives way to its picture, and the chrome takes the
 * keyboard for the dialog.
 */
export async function openLeakWarning(tabId: string): Promise<void> {
  const current = ++generation
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  if (current !== generation) return
  run('focus.chrome', undefined)
  uiStore.set({ credentialLeakOpen: true })
}

/** The warning has left the screen: the live page comes back, and the keyboard with it. */
export function closeLeakWarning(): void {
  generation++
  if (uiStore.get().credentialLeakOpen) uiStore.set({ credentialLeakOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * Answer a warning: the core closes it and acts – the change-password navigation, the Ignore
 * memory on the saved login, the manager – or, on `dismiss`, only closes it (the login keeps the
 * memory of having warned, so Chrome's once-per-credential rule holds).
 */
export function respondToLeak(id: string, action: CredentialLeakAction): void {
  run('passwords.leakRespond', { id, action })
}

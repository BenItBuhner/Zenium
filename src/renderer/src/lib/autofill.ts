import type {
  AddressEntry,
  AddressInput,
  AutofillPicker,
  AutofillPrompt,
  AutofillPromptResponse,
  CardNetwork,
  PaymentCardSummary,
  ReauthOutcome,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { currentSecurityPrompt } from '@renderer/lib/security'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/** How long a prompt waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/** How the chrome shows a prompt: a popover under the URL bar, a sheet, or a modal dialog. */
export type AutofillPromptSurface = 'popover' | 'sheet' | 'dialog'

/** Which of the vault's sections a manager dialog edits, and which entry (null for a new one). */
export interface AutofillEdit {
  kind: 'address' | 'card'
  id: string | null
}

/**
 * The autofill prompt this window should show now: the oldest one of its active tab, or a
 * passkey account prompt the host could not tie to a tab. Prompts of other tabs wait until
 * their tab is active; a security prompt on the same tab goes first (the page is stuck on it).
 */
export function currentAutofillPrompt(state: UIState): AutofillPrompt | null {
  if (currentSecurityPrompt(state)) return null
  const tabId = activeTab(state)?.id ?? null
  const prompts = state.autofill?.prompts ?? []
  return prompts.find((p) => p.tabId === null || p.tabId === tabId) ?? null
}

/** The picker for this window's active tab, if the focused field has one. */
export function currentPicker(state: UIState): AutofillPicker | null {
  const picker = state.autofill?.picker ?? null
  if (!picker) return null
  return picker.tabId === activeTab(state)?.id ? picker : null
}

/**
 * The save / update prompt the key chip in the URL pill stands for: the current prompt when it
 * is one about the page (a passkey account prompt is a dialog the page waits on, with no chip).
 */
export function chipPrompt(
  state: UIState
): Exclude<AutofillPrompt, { kind: 'passkey-account' }> | null {
  const prompt = currentAutofillPrompt(state)
  return prompt && prompt.kind !== 'passkey-account' ? prompt : null
}

/**
 * Put the desktop save prompt away behind its chip, or bring it back (Chrome's key icon): the
 * prompt stays pending in the core either way, until it is answered or the tab leaves the site.
 */
export function toggleAutofillPrompt(id: string): void {
  const collapsed = uiStore.get().autofillPromptCollapsed === id
  uiStore.set({ autofillPromptCollapsed: collapsed ? null : id })
}

/**
 * A prompt is about to show over `tabId`'s page. The page's views hide under chrome that
 * overlaps them, so its snapshot stands in; a popover leaves the picture undimmed, a sheet or a
 * dialog dims it (`panelAloneOverContent`). The prompt does not wait long for the picture.
 */
export async function openAutofillPrompt(
  tabId: string | null,
  surface: AutofillPromptSurface
): Promise<void> {
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  run('focus.chrome', undefined)
  uiStore.set({ autofillPrompt: surface })
}

/**
 * The prompt left the screen. The page takes the keyboard back unless the focus already moved
 * to chrome that stays – the key chip a collapse returned it to, the URL bar's field (§9.22).
 */
export function closeAutofillPrompt(): void {
  if (uiStore.get().autofillPrompt) uiStore.set({ autofillPrompt: null })
  invalidateSnapshot()
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (!active || active === document.body) returnFocusToPage()
}

/** Answer a prompt (null dismisses it for this page load). */
export function answerAutofillPrompt(id: string, response: AutofillPromptResponse | null): void {
  run('autofill.respond', { id, response })
}

/** Open the address or card editor over the Settings section (`TabDialogs` renders it). */
export function openAutofillEdit(edit: AutofillEdit): void {
  uiStore.set({ autofillEdit: edit })
}

export function closeAutofillEdit(): void {
  if (uiStore.get().autofillEdit) uiStore.set({ autofillEdit: null })
}

// ---------------------------------------------------------------------------
// The passphrase gate
// ---------------------------------------------------------------------------

interface PendingPassphrase {
  attempt: (passphrase: string) => Promise<ReauthOutcome<unknown>>
  resolve: (result: ReauthOutcome<unknown>) => void
}

let pendingPassphrase: PendingPassphrase | null = null

/**
 * Run a re-authenticated command (`attempt(undefined)` first). When it answers `passphrase`,
 * the passphrase dialog comes up over the frame (`PassphraseDialog`, rendered by `TabDialogs`
 * so it is modal wherever the caller sits, Settings included) and every answer typed into it
 * repeats the command with the passphrase until one is accepted or the dialog is dismissed. The
 * promise settles with the command's final outcome; a dismissal is `denied` with no reason.
 */
export async function withPassphrase<T>(
  copy: { title: string; description: string },
  attempt: (passphrase?: string) => Promise<ReauthOutcome<T>>
): Promise<ReauthOutcome<T>> {
  const first = await attempt(undefined)
  if (first.status !== 'passphrase') return first
  // One dialog at a time: a second request while one is up is refused rather than queued.
  if (pendingPassphrase) return { status: 'denied' }
  return new Promise<ReauthOutcome<T>>((resolve) => {
    pendingPassphrase = {
      attempt: (passphrase) => attempt(passphrase),
      resolve: (result) => resolve(result as ReauthOutcome<T>)
    }
    uiStore.set({ autofillPassphrase: { ...copy, error: null, busy: false } })
  })
}

/** The dialog's answer: repeat the command with it; a refusal keeps the dialog with the error. */
export async function answerPassphrase(passphrase: string): Promise<void> {
  const pending = pendingPassphrase
  const ask = uiStore.get().autofillPassphrase
  if (!pending || !ask || ask.busy) return
  uiStore.set({ autofillPassphrase: { ...ask, busy: true, error: null } })
  let result: ReauthOutcome<unknown>
  try {
    result = await pending.attempt(passphrase)
  } catch (e) {
    result = { status: 'denied', reason: e instanceof Error ? e.message : String(e) }
  }
  if (pendingPassphrase !== pending) return
  if (result.status === 'denied' || result.status === 'passphrase') {
    const current = uiStore.get().autofillPassphrase
    if (current)
      uiStore.set({
        autofillPassphrase: {
          ...current,
          busy: false,
          error:
            result.status === 'denied' && result.reason
              ? result.reason
              : 'That passphrase is not right. Try again.'
        }
      })
    return
  }
  settlePassphrase(result)
}

/** The dialog was dismissed: the command ends refused. */
export function cancelPassphrase(): void {
  settlePassphrase({ status: 'denied' })
}

function settlePassphrase(result: ReauthOutcome<unknown>): void {
  const pending = pendingPassphrase
  pendingPassphrase = null
  if (uiStore.get().autofillPassphrase) uiStore.set({ autofillPassphrase: null })
  pending?.resolve(result)
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const NETWORK_NAMES: Record<CardNetwork, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  maestro: 'Maestro',
  unknown: 'Card'
}

/** `12/2031` → "12/31", the way cards print it. */
export function expiryLabel(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year % 100).padStart(2, '0')}`
}

/** "Visa •••• 4242", or the nickname the user gave the card. */
export function cardTitle(
  card: Pick<PaymentCardSummary, 'network' | 'last4' | 'nickname'>
): string {
  return card.nickname || `${NETWORK_NAMES[card.network]} \u2022\u2022\u2022\u2022 ${card.last4}`
}

/** "Ada Lovelace, expires 12/31" – the card's second line. */
export function cardSubtitle(card: PaymentCardSummary): string {
  const expiry = `${card.expired ? 'expired' : 'expires'} ${expiryLabel(card.expMonth, card.expYear)}`
  return [card.name, expiry].filter(Boolean).join(', ')
}

/** The address on one line, after its first line (the name). */
export function addressSubtitle(address: AddressInput): string {
  const street = address.streetAddress
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const place = [address.locality, address.region, address.postalCode].filter(Boolean).join(' ')
  return [...street, place].filter(Boolean).join(', ')
}

/** The address's first line: whoever it is for, else where it is. */
export function addressTitle(address: AddressInput): string {
  return address.name || address.organization || address.streetAddress.split('\n')[0] || 'Address'
}

/** What a manager row says under an address. */
export function addressRowSubtitle(address: AddressEntry): string {
  const subtitle = addressSubtitle(address)
  return address.name && address.organization
    ? [address.organization, subtitle].filter(Boolean).join(', ')
    : subtitle
}

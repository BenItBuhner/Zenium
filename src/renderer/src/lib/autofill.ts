import type {
  AddressEntry,
  AddressInput,
  AutofillPicker,
  AutofillPrompt,
  AutofillPromptResponse,
  AutofillUIState,
  CardNetwork,
  PasskeyEntry,
  PasswordsStatus,
  PaymentCardSummary,
  ReauthOutcome,
  UIState
} from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { currentSecurityPrompt } from '@renderer/lib/security'
import { activeTab } from '@renderer/lib/selectors'
import {
  captureActiveTab,
  invalidateSnapshot,
  pushToast,
  returnFocusToPage,
  uiStore
} from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'

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
 * Brought back by hand, the prompt is a popover the user opened and takes the focus (v2 §9.22);
 * raised by the page it took none.
 */
export function toggleAutofillPrompt(id: string): void {
  const collapsed = uiStore.get().autofillPromptCollapsed === id
  uiStore.set({
    autofillPromptCollapsed: collapsed ? null : id,
    autofillPromptByHand: collapsed ? id : null
  })
}

/** The desktop prompt's panel (`AutofillPrompts`), for the chip's Tab to step into. */
const PROMPT_SELECTOR = '[data-af-prompt]'

/**
 * Move the keyboard into the open desktop prompt (v2 §9.22): its field when it has one (the
 * login prompts' username), else the panel itself, a title-and-notice container named by its
 * title. The chip's Tab steps in here, since a prompt the page raised took no focus on open; a
 * prompt on its way into the chip takes none.
 */
export function enterAutofillPrompt(
  panel = document.querySelector<HTMLElement>(PROMPT_SELECTOR)
): boolean {
  if (!panel || panel.dataset.closing) return false
  const target = panel.querySelector<HTMLElement>('input, textarea') ?? panel
  target.focus({ preventScroll: true })
  return true
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

/** What a manager row says under a passkey: the site, the account where it differs, when it was used. */
export function passkeySubtitle(passkey: PasskeyEntry): string {
  return [
    passkey.rpName || passkey.rpId,
    passkey.userDisplayName && passkey.userName !== passkey.userDisplayName
      ? passkey.userName
      : '',
    passkey.lastUsedAt
      ? `used ${relativeTime(passkey.lastUsedAt).toLowerCase()}`
      : `created ${relativeTime(passkey.createdAt).toLowerCase()}`
  ]
    .filter(Boolean)
    .join(' · ')
}

// ---------------------------------------------------------------------------
// Settings > Autofill: what the desktop section and the phone builder both say and do
// ---------------------------------------------------------------------------

/** The choices of "Clear copied passwords": how long a copied secret stays on the clipboard. */
export const CLIPBOARD_CLEAR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'Never' },
  { value: '30', label: 'After 30 seconds' },
  { value: '60', label: 'After 1 minute' },
  { value: '120', label: 'After 2 minutes' },
  { value: '300', label: 'After 5 minutes' }
]

/**
 * The system autofill services a row can name, by the package of the component Android reveals
 * (`com.google.android.gms/.autofill.service.AutofillService`); any other is "the system
 * autofill service" rather than its component string.
 */
const SERVICE_NAMES: [pkg: string, name: string][] = [
  ['com.google.android.gms', 'Google'],
  ['com.x8bit.bitwarden', 'Bitwarden'],
  ['com.onepassword.android', '1Password'],
  ['com.agilebits.onepassword', '1Password'],
  ['com.lastpass.lpandroid', 'LastPass'],
  ['com.dashlane', 'Dashlane'],
  ['com.samsung.android.samsungpass', 'Samsung Pass'],
  ['proton.android.pass', 'Proton Pass'],
  ['com.keepersecurity.keeper', 'Keeper'],
  ['com.enpass.app', 'Enpass'],
  ['com.nordpass.android', 'NordPass'],
  ['com.kunzisoft.keepass', 'KeePassDX'],
  ['com.azure.authenticator', 'Microsoft Authenticator']
]

export function systemAutofillName(component: string | null): string | null {
  if (!component) return null
  const pkg = component.split('/')[0]
  return (
    SERVICE_NAMES.find(([prefix]) => pkg === prefix || pkg.startsWith(`${prefix}.`))?.[1] ?? null
  )
}

/**
 * What the Android provider row explains: who saves and fills passwords in pages – the system
 * autofill service the device has set, or Zenium's own prompts – and what turning it on does.
 */
export function androidProviderHint(
  system: AutofillUIState['systemAutofill'],
  zenium: boolean
): string {
  const service = systemAutofillName(system?.service ?? null)
  if (!system?.enabled)
    return 'No autofill service is set on this device, so Zenium saves and fills passwords itself.'
  return zenium
    ? `Zenium's own prompts save and fill passwords in pages instead of ${service ?? 'the system autofill service'}.`
    : `${service ?? 'The system autofill service'} saves and fills passwords in pages; turn this on for Zenium's own prompts.`
}

/**
 * Copy a card's number: behind re-authentication, so the passphrase dialog (`PassphraseDialog`,
 * over the frame) takes over when the vault asks for its passphrase. The outcome is a toast.
 */
export async function copyCardNumber(card: PaymentCardSummary): Promise<void> {
  let result: ReauthOutcome<null>
  try {
    result = await withPassphrase(
      {
        title: 'Unlock to copy',
        description: `Your vault passphrase copies the number of ${cardTitle(card)}.`
      },
      (passphrase) => cmd('autofill.copyCardNumber', { id: card.id, passphrase })
    )
  } catch (e) {
    result = { status: 'denied', reason: e instanceof Error ? e.message : String(e) }
  }
  switch (result.status) {
    case 'ok':
      pushToast('Card number copied')
      return
    case 'setup-passphrase':
      pushToast('Set a vault passphrase in the password manager first', 'error')
      return
    case 'denied':
      if (result.reason) pushToast(result.reason, 'error')
      return
    case 'passphrase':
      return
  }
}

// ---------------------------------------------------------------------------
// The vault gate (Settings > Autofill while the vault is locked)
// ---------------------------------------------------------------------------

/**
 * Where the gate stands: idle offers Unlock (the device's own check where it has one); after
 * a `passphrase` outcome the passphrase form is up; after `setup-passphrase` the form creates
 * the vault's passphrase, since the device cannot verify the user and no vault exists yet.
 */
export type VaultGateStep = 'idle' | 'passphrase' | 'setup'

export interface VaultGateState {
  step: VaultGateStep
  /** An unlock attempt is with the core (§9.30: the action busy, a form's field read-only). */
  busy: boolean
  /** The last refusal, shown as the form's validation text or the idle gate's description. */
  error: string | null
}

export const IDLE_VAULT_GATE: VaultGateState = { step: 'idle', busy: false, error: null }

/** The gate's title and the line under it, on desktop and phone alike. */
export function vaultGateCopy(
  step: VaultGateStep,
  status: Pick<PasswordsStatus, 'error'>,
  error: string | null
): { title: string; description: string } {
  const title = step === 'setup' ? 'Set a vault passphrase' : 'The vault is locked'
  const description =
    status.error ??
    (step === 'idle' ? error : null) ??
    (step === 'setup'
      ? 'This device cannot verify you, so the vault needs a passphrase before it can hold addresses and cards.'
      : step === 'passphrase'
        ? 'Enter the vault passphrase to see and edit saved addresses, cards and passkeys.'
        : 'Unlock to see and edit saved addresses, cards and passkeys.')
  return { title, description }
}

/** The passphrase form's field label, primary action and autocomplete token for the step. */
export function vaultGateForm(step: VaultGateStep): {
  label: string
  action: string
  autoComplete: 'current-password' | 'new-password'
} {
  return step === 'setup'
    ? { label: 'New vault passphrase', action: 'Create', autoComplete: 'new-password' }
    : { label: 'Vault passphrase', action: 'Unlock', autoComplete: 'current-password' }
}

/** One unlock attempt (`passwords.unlock`); a thrown error is a refusal carrying its message. */
export async function unlockVault(passphrase?: string): Promise<ReauthOutcome<null>> {
  try {
    return await cmd('passwords.unlock', { passphrase })
  } catch (e) {
    return { status: 'denied', reason: e instanceof Error ? e.message : String(e) }
  }
}

/** What a refused attempt says when the host gave no reason of its own. */
export function unlockRefusal(result: { status: 'denied'; reason?: string }, answered: boolean): string {
  return result.reason ?? (answered ? 'That passphrase is not right.' : 'The vault stayed locked.')
}

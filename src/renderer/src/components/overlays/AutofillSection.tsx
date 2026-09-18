import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Copy,
  CreditCard,
  Fingerprint,
  Lock,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type {
  AddressEntry,
  PasskeyEntry,
  PaymentCardSummary,
  ReauthOutcome,
  Settings,
  UIState
} from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  addressRowSubtitle,
  addressTitle,
  cardSubtitle,
  cardTitle,
  openAutofillEdit,
  withPassphrase
} from '@renderer/lib/autofill'
import { useViewport } from '@renderer/lib/formFactor'
import { pushToast } from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'
import {
  Btn,
  Field,
  IconBtn,
  Labelled,
  MenuSheet,
  Menulist,
  type MenuOption
} from '../autofill/controls'

const CLEAR_OPTIONS: MenuOption<string>[] = [
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

function serviceName(component: string | null): string | null {
  if (!component) return null
  const pkg = component.split('/')[0]
  return (
    SERVICE_NAMES.find(([prefix]) => pkg === prefix || pkg.startsWith(`${prefix}.`))?.[1] ?? null
  )
}

/**
 * Settings > Autofill (design-language-v2-draft §1–§3, §6, §9): how passwords reach pages – the
 * rows Settings > Passwords hosts once the password manager's section lands (offer to save,
 * automatic sign-in, who fills on Android, the clipboard clear) – then the vault's addresses,
 * payment methods and passkeys, each a 15/600 group with its manager in a card on a desktop
 * (§9.27) and as rows under the heading on a phone (§9.17, §10.3: no card, checkboxes become
 * §10.4's switch rows, the add button an action row). Adding and editing an address or a card
 * opens the editor dialog (`AutofillEditor`, a sheet on phones); the lists re-fetch on every
 * change the core announces (`autofill.revision`) and once the vault unlocks. The 22 title is
 * desktop's (§9.26); the phone's chip strip names the pane.
 */
export function AutofillSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const locked = state.passwords.locked
  return (
    <div className="zen-v2-af zen-v2-af-pane" data-surface="page">
      <div className="zen-v2-af-pane-head">
        <h2 className="zen-v2-af-pane-title">Autofill</h2>
        <p className="zen-v2-af-muted zen-v2-af-pane-intro">
          Zenium saves the passwords, addresses and cards you type into pages and fills them back
          into forms. Everything stays in the encrypted vault on this device.
        </p>
      </div>
      <PasswordFillRows state={state} set={set} />
      {locked ? (
        <VaultGate state={state} />
      ) : (
        <>
          <AddressesGroup state={state} set={set} />
          <CardsGroup state={state} set={set} />
          <PasskeysGroup state={state} />
        </>
      )}
    </div>
  )
}

/**
 * The password rows: offer to save, automatic sign-in, the Android provider (only where a system
 * autofill service could own the pages instead) and how long a copied secret stays on the
 * clipboard. Exported on its own so the Passwords section can take them over.
 */
export function PasswordFillRows({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const s = state.settings.passwords
  const system = state.autofill.systemAutofill
  const android = state.platform === 'android'
  const zenium = s.androidProvider === 'zenium'
  const service = serviceName(system?.service ?? null)
  const providerHint = !system?.enabled
    ? 'No autofill service is set on this device, so Zenium saves and fills passwords itself.'
    : zenium
      ? `Zenium's own prompts save and fill passwords in pages instead of ${service ?? 'the system autofill service'}.`
      : `${service ?? 'The system autofill service'} saves and fills passwords in pages; turn this on for Zenium's own prompts.`
  return (
    <Section heading="Passwords">
      <div className="zen-v2-af-rows">
        <CheckRow
          label="Offer to save passwords"
          description="Ask to save or update a login after you sign in on a site."
          checked={s.offerToSave}
          onChange={(v) => set({ passwords: { ...s, offerToSave: v } })}
        />
        <CheckRow
          label="Sign in automatically"
          description="Fill the one saved login of a site as soon as its form is focused, without the picker."
          checked={s.autoSignIn}
          onChange={(v) => set({ passwords: { ...s, autoSignIn: v } })}
        />
        {android && (
          <CheckRow
            label="Use Zenium to fill passwords in pages"
            description={providerHint}
            checked={!system?.enabled || zenium}
            disabled={!system?.enabled}
            onChange={(v) => set({ passwords: { ...s, androidProvider: v ? 'zenium' : 'system' } })}
          />
        )}
        <MenulistRow
          label="Clear copied passwords"
          description="Remove a copied password or card number from the clipboard again after this long."
          value={String(s.clipboardClearSeconds)}
          options={CLEAR_OPTIONS}
          onChange={(v) => set({ passwords: { ...s, clipboardClearSeconds: Number(v) } })}
        />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Building blocks (v2 §6, §9.2–9.3, §9.27)
// ---------------------------------------------------------------------------

function usePhone(): boolean {
  return useViewport().formFactor === 'phone'
}

/**
 * Whether a row's text block runs to a third line (a wrapped description), which moves the
 * row's trailing control from the row's centre to the label's line (§9.18). Two 20 px lines are
 * the row's own; anything taller is a wrapped description.
 */
function useWrapped<T extends HTMLElement>(): [ref: RefObject<T | null>, wrapped: boolean] {
  const ref = useRef<T>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, wrapped]
}

/** A group: the 15/600 heading, its description 4 under it, the first row or card 8 below. */
function Section({
  heading,
  description,
  children
}: {
  heading: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="zen-v2-af-section">
      <div className="zen-v2-af-heading-block">
        <h3 className="zen-v2-af-heading">{heading}</h3>
        {description && <p className="zen-v2-af-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * A manager's list: on a desktop the card (§6, §9.27) that carries the group's own actions – its
 * rows at the card's 16 inset – and on a phone plain rows under the heading, edge to edge, since
 * a phone page draws no card, border or fill (§9.17, §10.3).
 */
function List({ children }: { children: ReactNode }): JSX.Element {
  const phone = usePhone()
  return <div className={phone ? 'zen-v2-af-rows' : 'zen-v2-af-card'}>{children}</div>
}

/**
 * A boolean row. On a desktop one checkbox (§9.2, §6): the 16 px box on the first text line and
 * the whole row its label; its text dims with a disabled box. On a phone §10.4's switch row: the
 * whole row is the control (`role="switch"`), the 36 × 20 switch trailing and centred on the row
 * – on the label's line once the description wraps (§9.18) – and disabled dims the row at .4.
 */
function CheckRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  const phone = usePhone()
  const [text, wrapped] = useWrapped<HTMLSpanElement>()
  if (phone) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="zen-v2-af-srow zen-v2-af-tap-row zen-v2-af-switch-row"
        data-wrapped={wrapped || undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span ref={text} className="zen-v2-af-srow-text">
          <span className="zen-v2-af-srow-label">{label}</span>
          {description && <span className="zen-v2-af-srow-desc">{description}</span>}
        </span>
        <span className="zen-v2-af-switch" aria-hidden />
      </button>
    )
  }
  return (
    <label className="zen-v2-af-srow">
      <input
        type="checkbox"
        className="zen-v2-check"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="zen-v2-af-srow-text">
        <span className="zen-v2-af-srow-label">{label}</span>
        {description && <span className="zen-v2-af-srow-desc">{description}</span>}
      </span>
    </label>
  )
}

/**
 * A row whose control is a menulist (§9.13, §9.21): on a mouse the 220 px menulist trails the
 * text, centred on the row. On a phone the menulist is not drawn (§10.4 value row): the row
 * shows the label with the current choice as its description and no chevron, and its tap opens
 * the sheet of radio rows, which carries the row's explanatory text in its title block.
 */
function MenulistRow({
  label,
  description,
  value,
  options,
  onChange
}: {
  label: string
  description: string
  value: string
  options: MenuOption<string>[]
  onChange: (value: string) => void
}): JSX.Element {
  const id = useId()
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)?.label ?? ''
  if (phone) {
    return (
      <>
        <button
          ref={trigger}
          type="button"
          className="zen-v2-af-srow zen-v2-af-tap-row"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="zen-v2-af-srow-text">
            <span className="zen-v2-af-srow-label">{label}</span>
            <span className="zen-v2-af-srow-desc">{current}</span>
          </span>
        </button>
        {open && (
          <MenuSheet
            title={label}
            description={description}
            value={value}
            options={options}
            onChange={onChange}
            onClose={() => {
              setOpen(false)
              trigger.current?.focus({ preventScroll: true })
            }}
          />
        )}
      </>
    )
  }
  return (
    <div className="zen-v2-af-srow">
      <span className="zen-v2-af-srow-text">
        <label htmlFor={id} className="zen-v2-af-srow-label">
          {label}
        </label>
        <span className="zen-v2-af-srow-desc">{description}</span>
      </span>
      <Menulist id={id} label={label} value={value} options={options} onChange={onChange} />
    </div>
  )
}

/**
 * A manager's row (§9.2, §9.18): the entry's glyph on the first text line, the title and its
 * description, the icon buttons trailing – centred on the row until the description wraps, then
 * on the label's line (`data-wrapped`), which the row learns by measuring its text block.
 */
function EntryRow({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  const [text, wrapped] = useWrapped<HTMLDivElement>()
  return (
    <div className="zen-v2-af-srow" data-wrapped={wrapped || undefined}>
      <span className="zen-v2-af-row-icon">
        <Icon aria-hidden />
      </span>
      <div ref={text} className="zen-v2-af-srow-text">
        <div className="zen-v2-af-srow-label">{title}</div>
        <div className="zen-v2-af-srow-desc">{description}</div>
      </div>
      <div className="zen-v2-af-srow-actions">{children}</div>
    </div>
  )
}

/** Empty state in a card or a phone group (§9.17): one plain row, one sentence at 69% where a label would be, no full stop. */
function EmptyRow({ children }: { children: string }): JSX.Element {
  return <div className="zen-v2-af-srow-empty">{children}</div>
}

/**
 * The list's add action: on a desktop the card's add row (§9.21), the secondary button with its
 * glyph 4 above and below; on a phone §10.4's action row – the whole 44 row is the button, its
 * glyph in the entries' leading slot so the labels share one edge, the press fill on the row.
 */
function AddRow({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  const phone = usePhone()
  if (phone) {
    return (
      <button
        type="button"
        className="zen-v2-af-srow zen-v2-af-tap-row zen-v2-af-action-row"
        onClick={onClick}
      >
        <span className="zen-v2-af-row-icon">
          <Plus aria-hidden />
        </span>
        <span className="zen-v2-af-srow-text">
          <span className="zen-v2-af-srow-label">{label}</span>
        </span>
      </button>
    )
  }
  return (
    <div className="zen-v2-af-add">
      <div className="zen-v2-af-add-controls">
        <Btn onClick={onClick}>
          <Plus aria-hidden />
          {label}
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The vault gate
// ---------------------------------------------------------------------------

type GateStep = 'idle' | 'passphrase' | 'setup'

/**
 * Addresses, cards and passkeys live in the vault: while it is locked one card (§9.27) offers
 * to unlock it – the device's own check where it has one, the passphrase in a §9.12 field where
 * the vault has one, or creating one where the device cannot verify the user and no vault
 * exists yet. The card's name is inside it (its 17/600 title with the lock glyph, 16 padding,
 * nothing above it); on a phone there is no card, so the title is the group's 15/600 heading,
 * Unlock a §10.4 action row and the passphrase form a field at the gutter (§9.17, §10.3).
 */
function VaultGate({ state }: { state: UIState }): JSX.Element {
  const [step, setStep] = useState<GateStep>('idle')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const status = state.passwords
  const id = useId()
  const phone = usePhone()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (step !== 'idle' && !busy) field.current?.focus()
  }, [step, busy])

  const unlock = async (answer?: string): Promise<void> => {
    setBusy(true)
    let result: ReauthOutcome<null>
    try {
      result = await cmd('passwords.unlock', { passphrase: answer })
    } catch (e) {
      result = { status: 'denied', reason: e instanceof Error ? e.message : String(e) }
    }
    setBusy(false)
    switch (result.status) {
      case 'ok':
        setStep('idle')
        setPassphrase('')
        setError(null)
        return
      case 'passphrase':
        setStep('passphrase')
        setError(null)
        return
      case 'setup-passphrase':
        setStep('setup')
        setError(null)
        return
      case 'denied':
        setError(
          result.reason ??
            (answer !== undefined ? 'That passphrase is not right.' : 'The vault stayed locked.')
        )
        setPassphrase('')
    }
  }

  const title = step === 'setup' ? 'Set a vault passphrase' : 'The vault is locked'
  const description = status.error
    ? status.error
    : step === 'setup'
      ? 'This device cannot verify you, so the vault needs a passphrase before it can hold addresses and cards.'
      : step === 'passphrase'
        ? 'Enter the vault passphrase to see and edit saved addresses, cards and passkeys.'
        : 'Unlock to see and edit saved addresses, cards and passkeys.'
  const cancel = (): void => {
    setStep('idle')
    setPassphrase('')
    setError(null)
  }
  // Busy is the spinner at full opacity (§9.30): the field holds read-only, Cancel stays live.
  const form = (
    <form
      className="zen-v2-af-gate-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (passphrase && !busy) void unlock(passphrase)
      }}
    >
      <Labelled
        label={step === 'setup' ? 'New vault passphrase' : 'Vault passphrase'}
        htmlFor={id}
        error={error}
      >
        <Field
          ref={field}
          id={id}
          type="password"
          secret
          value={passphrase}
          autoComplete={step === 'setup' ? 'new-password' : 'current-password'}
          readOnly={busy}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </Labelled>
      <div className="zen-v2-af-gate-actions">
        <Btn onClick={cancel}>Cancel</Btn>
        <Btn type="submit" variant="primary" busy={busy} disabled={!passphrase && !busy}>
          {step === 'setup' ? 'Create' : 'Unlock'}
        </Btn>
      </div>
    </form>
  )
  if (phone) {
    return (
      <Section heading={title} description={description}>
        {step === 'idle' ? (
          <div className="zen-v2-af-rows">
            <button
              type="button"
              className="zen-v2-af-srow zen-v2-af-tap-row zen-v2-af-action-row"
              aria-busy={busy || undefined}
              disabled={Boolean(status.error)}
              onClick={() => {
                if (!busy) void unlock()
              }}
            >
              <span className="zen-v2-af-srow-text">
                <span className="zen-v2-af-srow-label">Unlock</span>
              </span>
              {busy && <span className="zen-v2-af-row-spinner" aria-hidden />}
            </button>
          </div>
        ) : (
          form
        )}
      </Section>
    )
  }
  return (
    <section className="zen-v2-af-section">
      <div className="zen-v2-af-card zen-v2-af-gate">
        <div className="zen-v2-af-gate-head">
          <Lock aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="zen-v2-af-card-title">{title}</div>
            <div className="zen-v2-af-muted">{description}</div>
          </div>
        </div>
        {step === 'idle' ? (
          <div className="zen-v2-af-gate-actions">
            <Btn
              variant="primary"
              busy={busy}
              disabled={Boolean(status.error)}
              onClick={() => void unlock()}
            >
              Unlock
            </Btn>
          </div>
        ) : (
          form
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The managers
// ---------------------------------------------------------------------------

/** A vault list, fetched on mount and again whenever the core's autofill revision moves. */
function useVaultList<T>(fetch: () => Promise<T[]>, revision: number): T[] | null {
  const [list, setList] = useState<T[] | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch()
      .then((items) => {
        if (!cancelled) setList(items)
      })
      .catch(() => {
        if (!cancelled) setList([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fetch` is a command wrapper; the revision is what changes
  }, [revision])
  return list
}

function AddressesGroup({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const a = state.settings.autofill
  const addresses = useVaultList<AddressEntry>(
    () => cmd('autofill.listAddresses', undefined),
    state.autofill.revision
  )
  return (
    <Section heading="Addresses">
      <div className="zen-v2-af-rows">
        <CheckRow
          label="Save and fill addresses"
          description="Offer to save addresses typed into forms, and fill them back into checkouts and sign-ups."
          checked={a.addresses}
          onChange={(v) => set({ autofill: { ...a, addresses: v } })}
        />
      </div>
      <List>
        {addresses?.map((address) => (
          <EntryRow
            key={address.id}
            icon={MapPin}
            title={addressTitle(address)}
            description={addressRowSubtitle(address)}
          >
            <IconBtn
              title="Edit address"
              onClick={() => openAutofillEdit({ kind: 'address', id: address.id })}
            >
              <Pencil aria-hidden />
            </IconBtn>
            <IconBtn
              title="Delete address"
              onClick={() => run('autofill.removeAddress', { id: address.id })}
            >
              <Trash2 aria-hidden />
            </IconBtn>
          </EntryRow>
        ))}
        {addresses && addresses.length === 0 && <EmptyRow>No addresses saved yet</EmptyRow>}
        <AddRow
          label="Add address"
          onClick={() => openAutofillEdit({ kind: 'address', id: null })}
        />
      </List>
    </Section>
  )
}

function CardsGroup({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const a = state.settings.autofill
  const cards = useVaultList<PaymentCardSummary>(
    () => cmd('autofill.listCards', undefined),
    state.autofill.revision
  )
  // Copying a number is behind re-authentication: the passphrase dialog (`PassphraseDialog`,
  // over the frame) takes over when the vault asks for its passphrase.
  const [busy, setBusy] = useState(false)
  const copy = async (card: PaymentCardSummary): Promise<void> => {
    setBusy(true)
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
    setBusy(false)
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
  return (
    <Section
      heading="Payment methods"
      description="Card numbers stay in the vault; security codes are never saved."
    >
      <div className="zen-v2-af-rows">
        <CheckRow
          label="Save and fill payment methods"
          description="Offer to save cards typed into checkouts, and fill them back after you verify it is you."
          checked={a.cards}
          onChange={(v) => set({ autofill: { ...a, cards: v } })}
        />
      </div>
      <List>
        {cards?.map((card) => (
          <EntryRow
            key={card.id}
            icon={CreditCard}
            title={cardTitle(card)}
            description={cardSubtitle(card)}
          >
            <IconBtn title="Copy card number" disabled={busy} onClick={() => void copy(card)}>
              <Copy aria-hidden />
            </IconBtn>
            <IconBtn
              title="Edit card"
              onClick={() => openAutofillEdit({ kind: 'card', id: card.id })}
            >
              <Pencil aria-hidden />
            </IconBtn>
            <IconBtn
              title="Delete card"
              onClick={() => run('autofill.removeCard', { id: card.id })}
            >
              <Trash2 aria-hidden />
            </IconBtn>
          </EntryRow>
        ))}
        {cards && cards.length === 0 && <EmptyRow>No cards saved yet</EmptyRow>}
        <AddRow label="Add card" onClick={() => openAutofillEdit({ kind: 'card', id: null })} />
      </List>
    </Section>
  )
}

function PasskeysGroup({ state }: { state: UIState }): JSX.Element {
  const passkeys = useVaultList<PasskeyEntry>(
    () => cmd('autofill.listPasskeys', undefined),
    state.autofill.revision
  )
  return (
    <Section
      heading="Passkeys"
      description="Passkeys created in Zenium. The keys themselves stay with your device's authenticator (Windows Hello, Touch ID, Google Password Manager); this is where they exist and when they were last used."
    >
      <List>
        {passkeys?.map((passkey) => (
          <EntryRow
            key={passkey.id}
            icon={Fingerprint}
            title={passkey.userDisplayName || passkey.userName}
            description={[
              passkey.rpName || passkey.rpId,
              passkey.userDisplayName && passkey.userName !== passkey.userDisplayName
                ? passkey.userName
                : '',
              passkey.lastUsedAt
                ? `used ${relativeTime(passkey.lastUsedAt).toLowerCase()}`
                : `created ${relativeTime(passkey.createdAt).toLowerCase()}`
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <IconBtn
              title="Forget this passkey's record"
              onClick={() => run('autofill.removePasskey', { id: passkey.id })}
            >
              <Trash2 aria-hidden />
            </IconBtn>
          </EntryRow>
        ))}
        {passkeys && passkeys.length === 0 && <EmptyRow>No passkeys yet</EmptyRow>}
      </List>
    </Section>
  )
}

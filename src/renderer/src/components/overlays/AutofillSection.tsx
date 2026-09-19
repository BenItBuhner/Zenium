import type { JSX, ReactNode, RefObject } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
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
import type { PasswordsStatus, Settings, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  CLIPBOARD_CLEAR_OPTIONS,
  addressRowSubtitle,
  addressTitle,
  androidProviderHint,
  cardSubtitle,
  cardTitle,
  openAutofillEdit,
  passkeySubtitle,
  vaultGateCopy
} from '@renderer/lib/autofill'
import {
  useAutofillSettings,
  type AutofillSettingsData,
  type VaultGate
} from '@renderer/lib/autofillSettings'
import { VaultPassphraseForm } from '../autofill/PassphraseForm'
import { Btn, IconBtn, Menulist, type MenuOption } from '../autofill/controls'

/**
 * Settings > Autofill on a desktop (design-language-v2-draft §1–§3, §6, §9): how passwords
 * reach pages – the rows Settings > Passwords hosts once the password manager's section lands
 * (offer to save, automatic sign-in, who fills on Android, the clipboard clear) – then the
 * vault's addresses, payment methods and passkeys, each a 15/600 group with its manager in a
 * card (§9.27). Adding and editing an address or a card opens the editor dialog
 * (`AutofillEditor`); the lists re-fetch on every change the core announces
 * (`autofill.revision`) and once the vault unlocks (`useAutofillSettings`, shared with the
 * phone's Settings tab, whose rows are the `autofill` builder in `pages/settings/sections.tsx`).
 *
 * Rows are the shared `.zen-v2-row` (§9.34) with the pane's anatomy inside them: a check row is
 * the target and takes the row's fill; a row whose target is a control inside it – the
 * menulist, the entries' icon buttons – or that only says something (the empty line) is the
 * static form, `data-static`.
 */
export function AutofillSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const autofill = useAutofillSettings(state, true)
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
      {state.passwords.locked ? (
        <VaultGate status={state.passwords} gate={autofill.gate} />
      ) : (
        <>
          <AddressesGroup state={state} set={set} autofill={autofill} />
          <CardsGroup state={state} set={set} autofill={autofill} />
          <PasskeysGroup autofill={autofill} />
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
            description={androidProviderHint(system, zenium)}
            checked={!system?.enabled || zenium}
            disabled={!system?.enabled}
            onChange={(v) => set({ passwords: { ...s, androidProvider: v ? 'zenium' : 'system' } })}
          />
        )}
        <MenulistRow
          label="Clear copied passwords"
          description="Remove a copied password or card number from the clipboard again after this long."
          value={String(s.clipboardClearSeconds)}
          options={CLIPBOARD_CLEAR_OPTIONS as MenuOption<string>[]}
          onChange={(v) => set({ passwords: { ...s, clipboardClearSeconds: Number(v) } })}
        />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Building blocks (v2 §6, §9.2–9.3, §9.27, §9.34)
// ---------------------------------------------------------------------------

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

/** A row's text: the label on the first line, the description 13/69% under it, two lines at most. */
function RowText({
  label,
  description,
  htmlFor,
  ref
}: {
  label: string
  description?: string
  /** Makes the label a `<label>` for the control with this id. */
  htmlFor?: string
  ref?: RefObject<HTMLSpanElement | null>
}): JSX.Element {
  return (
    <span ref={ref} className="zen-v2-af-pane-text">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="zen-v2-af-pane-label">
          {label}
        </label>
      ) : (
        <span className="zen-v2-af-pane-label">{label}</span>
      )}
      {description && <span className="zen-v2-af-pane-desc">{description}</span>}
    </span>
  )
}

/**
 * A boolean row (§9.2, §6): the shared row as a label around one checkbox – the 16 px box on
 * the first text line, the whole row the target with the row's hover fill. Disabled, the row
 * says so (`aria-disabled`, which keeps the shared row's fill off it) and its text dims with
 * the box (§9.30's .4).
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
  return (
    <label className="zen-v2-row zen-v2-af-pane-row" aria-disabled={disabled || undefined}>
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <RowText label={label} description={description} />
    </label>
  )
}

/**
 * A row whose control is a menulist (§9.13, §9.21): the 220 px menulist trails the text, centred
 * on the row – on the label's line once the description wraps to a third text line (§9.18,
 * `data-wrapped`), which the row learns by measuring its text block. The menulist is the
 * target, so the row is static.
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
  const [text, wrapped] = useWrapped<HTMLSpanElement>()
  return (
    <div
      className="zen-v2-row zen-v2-af-pane-row"
      data-static=""
      data-wrapped={wrapped || undefined}
    >
      <RowText ref={text} label={label} description={description} htmlFor={id} />
      <Menulist id={id} label={label} value={value} options={options} onChange={onChange} />
    </div>
  )
}

/**
 * A manager's row (§9.2, §9.18): the entry's glyph on the first text line, the title and its
 * description, the icon buttons trailing – centred on the row until the description wraps, then
 * on the label's line (`data-wrapped`). The buttons are the targets, so the row is static.
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
  const [text, wrapped] = useWrapped<HTMLSpanElement>()
  return (
    <div
      className="zen-v2-row zen-v2-af-pane-row"
      data-static=""
      data-wrapped={wrapped || undefined}
    >
      <span className="zen-v2-af-row-icon">
        <Icon aria-hidden />
      </span>
      <RowText ref={text} label={title} description={description} />
      <div className="zen-v2-af-pane-actions">{children}</div>
    </div>
  )
}

/** The empty state in a card (§9.17): one plain static row, one sentence at 69%, no full stop. */
function EmptyRow({ children }: { children: string }): JSX.Element {
  return (
    <div className="zen-v2-row zen-v2-af-pane-empty" data-static="">
      {children}
    </div>
  )
}

/** The card's add action (§9.21): the secondary button with its glyph, 4 above and below. */
function AddRow({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
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

/**
 * Addresses, cards and passkeys live in the vault: while it is locked one card (§9.27) offers
 * to unlock it – the device's own check where it has one, the passphrase in a §9.12 field where
 * the vault has one, or creating one where the device cannot verify the user and no vault
 * exists yet (`useVaultGate`). The card's name is inside it (its 17/600 title with the lock
 * glyph, 16 padding, nothing above it); the form is the shared passphrase form (§9.30).
 */
function VaultGate({ status, gate }: { status: PasswordsStatus; gate: VaultGate }): JSX.Element {
  const { title, description } = vaultGateCopy(gate.step, status, gate.error)
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
        {gate.step === 'idle' ? (
          <div className="zen-v2-af-gate-actions">
            <Btn
              variant="primary"
              busy={gate.busy}
              disabled={status.error !== null}
              onClick={() => gate.unlock()}
            >
              Unlock
            </Btn>
          </div>
        ) : (
          <VaultPassphraseForm gate={gate} />
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The managers
// ---------------------------------------------------------------------------

function AddressesGroup({
  state,
  set,
  autofill: { addresses }
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
  autofill: AutofillSettingsData
}): JSX.Element {
  const a = state.settings.autofill
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
      <div className="zen-v2-af-card">
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
      </div>
    </Section>
  )
}

function CardsGroup({
  state,
  set,
  autofill: { cards, copying, copyCard }
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
  autofill: AutofillSettingsData
}): JSX.Element {
  const a = state.settings.autofill
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
      <div className="zen-v2-af-card">
        {cards?.map((card) => (
          <EntryRow
            key={card.id}
            icon={CreditCard}
            title={cardTitle(card)}
            description={cardSubtitle(card)}
          >
            {/* Copying is behind re-authentication (the passphrase dialog takes over when the
                vault asks): the button is busy meanwhile – the spinner in the glyph's place,
                full opacity, no second press (§9.30). */}
            <IconBtn
              title="Copy card number"
              aria-busy={copying === card.id || undefined}
              onClick={() => {
                if (copying === null) copyCard(card)
              }}
            >
              {copying === card.id ? (
                <span className="zen-v2-spinner" aria-hidden />
              ) : (
                <Copy aria-hidden />
              )}
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
      </div>
    </Section>
  )
}

function PasskeysGroup({
  autofill: { passkeys }
}: {
  autofill: AutofillSettingsData
}): JSX.Element {
  return (
    <Section
      heading="Passkeys"
      description="Passkeys created in Zenium. The keys themselves stay with your device's authenticator (Windows Hello, Touch ID, Google Password Manager); this is where they exist and when they were last used."
    >
      <div className="zen-v2-af-card">
        {passkeys?.map((passkey) => (
          <EntryRow
            key={passkey.id}
            icon={Fingerprint}
            title={passkey.userDisplayName || passkey.userName}
            description={passkeySubtitle(passkey)}
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
      </div>
    </Section>
  )
}

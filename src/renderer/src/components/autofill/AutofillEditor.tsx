import type { FormEvent, JSX, ReactNode, Ref } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { CreditCard, MapPin, type LucideIcon } from 'lucide-react'
import type {
  AddressEntry,
  AddressFieldSpec,
  AddressFormat,
  AddressInput,
  PaymentCardInput,
  PaymentCardSummary,
  UIState
} from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { useFrameDialog } from '@renderer/lib/portals'
import { closeAutofillEdit, type AutofillEdit } from '@renderer/lib/autofill'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import {
  Btn,
  Field,
  Footer,
  InSheet,
  Labelled,
  Menulist,
  SheetCopy,
  SheetTitleBlock,
  TextArea,
  TitleBlock,
  useEscape,
  useScrolled,
  wrapTab,
  type MenuOption
} from './controls'

/**
 * The address and card editors of Settings > Autofill (`uiStore.autofillEdit`, opened by the
 * section's Add and Edit controls): a modal dialog in the frame on desktop (§9.5, 400 wide,
 * through the `FrameDialogHost` `TabDialogs` mounts, so it centres over Settings), a sheet on
 * phones (§9.11, §9.16). An address form takes its lines from the country's format
 * (`autofill.addressFormat`): pick another country and the lines change under it; a card form
 * is the number, its expiry as two menulists, the name on it and a nickname – never the security
 * code. Save writes through the `autofill.*` commands and the section's lists follow.
 */
export function AutofillEditor({ state }: { state: UIState }): JSX.Element | null {
  const edit = uiStore.use((s) => s.autofillEdit)
  const phone = useViewport().formFactor === 'phone'
  const locked = state.passwords.locked
  // The vault locking under the editor takes its entries away: the editor goes with them.
  useEffect(() => {
    if (locked) closeAutofillEdit()
  }, [locked])
  if (!edit || locked) return null
  return <Editor key={`${edit.kind}:${edit.id ?? 'new'}`} edit={edit} phone={phone} />
}

interface EditorCopy {
  icon: LucideIcon
  title: string
  description: string
}

function copyFor(edit: AutofillEdit): EditorCopy {
  if (edit.kind === 'address') {
    return {
      icon: MapPin,
      title: edit.id ? 'Edit address' : 'Add address',
      description: edit.id
        ? 'The country decides which lines the address has.'
        : 'Zenium fills the address into forms after this. The country decides which lines it has.'
    }
  }
  return {
    icon: CreditCard,
    title: edit.id ? 'Edit card' : 'Add card',
    description: edit.id
      ? 'Leave the number empty to keep the saved one. The security code is never saved.'
      : 'The number, its expiry and the name on it. The security code is never saved.'
  }
}

/** The editor's form, once the entry it edits (if any) has arrived. */
function Editor({ edit, phone }: { edit: AutofillEdit; phone: boolean }): JSX.Element | null {
  const copy = copyFor(edit)
  const [busy, setBusy] = useState(false)
  const submit = useRef<(() => Promise<void>) | null>(null)
  const form =
    edit.kind === 'address' ? (
      <AddressForm
        edit={edit}
        phone={phone}
        busy={busy}
        setBusy={setBusy}
        register={(fn) => (submit.current = fn)}
      />
    ) : (
      <CardForm
        edit={edit}
        phone={phone}
        busy={busy}
        setBusy={setBusy}
        register={(fn) => (submit.current = fn)}
      />
    )
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!busy) void submit.current?.()
  }
  return phone ? (
    <EditorSheet copy={copy} busy={busy} onSubmit={onSubmit}>
      {form}
    </EditorSheet>
  ) : (
    <EditorDialog copy={copy} busy={busy} onSubmit={onSubmit}>
      {form}
    </EditorDialog>
  )
}

/**
 * The editor's actions. A busy form (§9.30): only Save is busy, Cancel sits at .4 and the fields
 * hold their values read-only until the save answers. `onCancel` is the shell's way out – the
 * dialog closes, the sheet leaves with its motion.
 */
function EditorFooter({ busy, onCancel }: { busy: boolean; onCancel: () => void }): JSX.Element {
  return (
    <Footer count={2}>
      <Btn disabled={busy} onClick={onCancel}>
        Cancel
      </Btn>
      <Btn type="submit" variant="primary" busy={busy}>
        Save
      </Btn>
    </Footer>
  )
}

// ---------------------------------------------------------------------------
// The two shells
// ---------------------------------------------------------------------------

/**
 * The desktop shell: a title block of the title alone, then the body – the paragraph that
 * introduces the form is body copy at 15/400 in the text colour (§9.23), not the title block's
 * description – scrolling between the block and the footer, which stays put (a long address
 * form, its validation lines added, runs past a frame 800 tall); §9.7's hairline on the title
 * block once scrolled. The footer draws none: a dialog ends in its actions – the last field, 16,
 * the buttons, 16 to the edge (§9.20's footer ruling).
 */
function EditorDialog({
  copy,
  busy,
  onSubmit,
  children
}: {
  copy: EditorCopy
  busy: boolean
  onSubmit: (e: FormEvent) => void
  children: ReactNode
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(bodyRef)
  const titleId = useId()
  useFrameDialog({ onScrimPress: closeAutofillEdit })
  useEscape(closeAutofillEdit)
  useBackSurface({ name: 'autofill-editor', onCommit: closeAutofillEdit })
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="zen-v2-af zen-v2-af-dialog zen-animate-pop"
      data-surface="page"
      onKeyDown={(e) => wrapTab(e, panelRef.current)}
    >
      <TitleBlock id={titleId} icon={copy.icon} title={copy.title} scrolled={scrolled} />
      <form className="zen-v2-af-dialog-form" onSubmit={onSubmit}>
        <div ref={bodyRef} className="zen-v2-af-body">
          <SheetCopy>{copy.description}</SheetCopy>
          <div className="zen-v2-af-form">{children}</div>
        </div>
        <div className="zen-v2-af-dialog-footer">
          <EditorFooter busy={busy} onCancel={closeAutofillEdit} />
        </div>
      </form>
    </div>
  )
}

/**
 * The phone shell: the chassis sheet (§9.11) in the frame's dialog host – `TabDialogs` renders
 * the editor inside `FrameDialogHost`, so the sheet is `hosted` and owns its scrim
 * (`useFrameDialog`); the chassis takes focus, traps Tab, holds the chrome inert and lifts the
 * form above the keyboard (#172). The editor carries a description, so the sheet opens on a
 * §9.23 title block rather than the 48 header (a phone sheet takes the block when it has a
 * description and keeps the header when it has none): the glyph on the title's start at the
 * gutter, the description 4 below, 16 to the form, which ends in its actions, Cancel leaving
 * through the sheet's own motion.
 */
function EditorSheet({
  copy,
  busy,
  onSubmit,
  children
}: {
  copy: EditorCopy
  busy: boolean
  onSubmit: (e: FormEvent) => void
  children: ReactNode
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'autofill-editor',
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  // The sheet's layer is the host slot's child itself (`data-sheet-layer`: a sheet on its own
  // chassis keeps the pointer while the host's chassis stays down for it).
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={closeAutofillEdit}
      handleLabel="Dismiss"
      labelledBy={titleId}
      className="zen-v2-af zen-v2-af-sheet"
      fitContent
    >
      <InSheet.Provider value>
        <div className="zen-v2-af" data-surface="page">
          <SheetTitleBlock
            id={titleId}
            icon={copy.icon}
            title={copy.title}
            description={copy.description}
          />
          <form className="zen-v2-af-form" onSubmit={onSubmit}>
            {children}
            <EditorFooter busy={busy} onCancel={dismiss} />
          </form>
        </div>
      </InSheet.Provider>
    </BottomSheet>
  )
}

interface FormProps {
  edit: AutofillEdit
  phone: boolean
  busy: boolean
  setBusy: (busy: boolean) => void
  /** Hands the shell the form's save routine, which its Save button and Enter run. */
  register: (submit: () => Promise<void>) => void
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const EMPTY_ADDRESS: AddressInput = {
  country: '',
  name: '',
  organization: '',
  streetAddress: '',
  locality: '',
  region: '',
  postalCode: '',
  sortingCode: '',
  phone: '',
  email: ''
}

/** The `autocomplete` token of each line, so the platform's own suggestions line up with it. */
const AUTOCOMPLETE: Partial<Record<keyof AddressInput, string>> = {
  name: 'name',
  organization: 'organization',
  streetAddress: 'street-address',
  locality: 'address-level2',
  region: 'address-level1',
  postalCode: 'postal-code',
  sortingCode: 'address-level3',
  phone: 'tel',
  email: 'email'
}

/** A menulist item cannot carry the empty string: this stands for "no region" in an optional one. */
const NO_REGION = '__none__'

/** The country a new address starts in: the one the UI language names, else the United States. */
function defaultCountry(): string {
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  const region = language.split('-')[1]
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : 'US'
}

function AddressForm({ edit, phone, busy, setBusy, register }: FormProps): JSX.Element | null {
  const [draft, setDraft] = useState<AddressInput | null>(null)
  const [countries, setCountries] = useState<MenuOption<string>[] | null>(null)
  const [format, setFormat] = useState<AddressFormat | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof AddressInput, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  // The entry being edited and the country list, both local and quick.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await cmd('autofill.countries', undefined).catch(() => [])
      let entry: AddressEntry | undefined
      if (edit.id) {
        const addresses = await cmd('autofill.listAddresses', undefined).catch(() => [])
        entry = addresses.find((a) => a.id === edit.id)
      }
      if (cancelled) return
      setCountries(list.map((c) => ({ value: c.code, label: c.name })))
      if (edit.id && !entry) {
        // Gone meanwhile (deleted in another window): nothing to edit.
        closeAutofillEdit()
        return
      }
      setDraft(
        entry
          ? {
              country: entry.country,
              name: entry.name,
              organization: entry.organization,
              streetAddress: entry.streetAddress,
              locality: entry.locality,
              region: entry.region,
              postalCode: entry.postalCode,
              sortingCode: entry.sortingCode,
              phone: entry.phone,
              email: entry.email
            }
          : { ...EMPTY_ADDRESS, country: defaultCountry() }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [edit.id])

  // The country's lines; another country's arrive under the values already typed.
  const country = draft?.country ?? null
  useEffect(() => {
    if (!country) return
    let cancelled = false
    cmd('autofill.addressFormat', { country })
      .then((f) => {
        if (!cancelled) setFormat(f)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [country])

  // The first line takes the keyboard once the form is up (not on a phone: the sheet is rising).
  const ready = draft !== null && format !== null && countries !== null
  useEffect(() => {
    if (ready && !phone) first.current?.focus()
  }, [ready, phone])

  const set = (field: keyof AddressInput, value: string): void => {
    setDraft((d) => (d ? { ...d, [field]: value } : d))
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e))
    setFormError(null)
  }

  useEffect(() => {
    register(async () => {
      if (!draft || !format) return
      const missing = format.fields.filter((f) => f.required && !draft[f.field].trim())
      if (missing.length) {
        const next: Partial<Record<keyof AddressInput, string>> = {}
        for (const f of missing) next[f.field] = 'Required'
        setErrors(next)
        document
          .querySelector<HTMLElement>(`[data-af-field="${missing[0].field}"]`)
          ?.focus({ preventScroll: false })
        return
      }
      const trimmed = Object.fromEntries(
        Object.entries(draft).map(([k, v]) => [k, v.trim()])
      ) as unknown as AddressInput
      setBusy(true)
      try {
        if (edit.id) await cmd('autofill.updateAddress', { id: edit.id, patch: trimmed })
        else await cmd('autofill.addAddress', { address: trimmed })
        closeAutofillEdit()
      } catch (e) {
        setFormError(messageOf(e))
        setBusy(false)
      }
    })
  })

  if (!ready) return null

  const lines = format.fields.filter((f) => f.field !== 'country')
  return (
    <>
      <Labelled label="Country" htmlFor={`${edit.kind}-country`}>
        <Menulist
          id={`${edit.kind}-country`}
          label="Country"
          value={draft.country}
          options={countries}
          readOnly={busy}
          onChange={(v) => set('country', v)}
        />
      </Labelled>
      {lines.map((spec, i) => (
        <AddressLine
          key={spec.field}
          spec={spec}
          value={draft[spec.field]}
          error={errors[spec.field] ?? null}
          hint={
            spec.field === 'postalCode' && format.postalCodeExamples[0]
              ? `For example ${format.postalCodeExamples[0]}`
              : undefined
          }
          readOnly={busy}
          ref={i === 0 ? first : undefined}
          onChange={(v) => set(spec.field, v)}
        />
      ))}
      {formError && (
        <p className="zen-v2-af-error" role="alert">
          {formError}
        </p>
      )}
    </>
  )
}

function AddressLine({
  spec,
  value,
  error,
  hint,
  readOnly,
  ref,
  onChange
}: {
  spec: AddressFieldSpec
  value: string
  error: string | null
  hint?: string
  readOnly: boolean
  ref?: Ref<HTMLInputElement | HTMLTextAreaElement>
  onChange: (value: string) => void
}): JSX.Element {
  const id = useId()
  const label = spec.required ? spec.label : `${spec.label} (optional)`
  let control: JSX.Element
  if (spec.options && spec.options.length) {
    const options: MenuOption<string>[] = spec.options.map((o) => ({ value: o.key, label: o.name }))
    if (!spec.required) options.unshift({ value: NO_REGION, label: 'None' })
    // A required region not chosen yet shows the placeholder, not the first option as if chosen.
    control = (
      <Menulist
        id={id}
        label={spec.label}
        value={value || (spec.required ? '' : NO_REGION)}
        options={options}
        placeholder={spec.required ? 'Select' : undefined}
        readOnly={readOnly}
        onChange={(v) => onChange(v === NO_REGION ? '' : v)}
      />
    )
  } else if (spec.field === 'streetAddress') {
    control = (
      <TextArea
        ref={ref as Ref<HTMLTextAreaElement>}
        id={id}
        data-af-field={spec.field}
        value={value}
        rows={2}
        autoComplete={AUTOCOMPLETE[spec.field]}
        aria-invalid={error ? true : undefined}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else {
    const type = spec.field === 'email' ? 'email' : spec.field === 'phone' ? 'tel' : 'text'
    control = (
      <Field
        ref={ref as Ref<HTMLInputElement>}
        id={id}
        data-af-field={spec.field}
        type={type}
        value={value}
        autoComplete={AUTOCOMPLETE[spec.field]}
        inputMode={spec.field === 'phone' ? 'tel' : spec.field === 'email' ? 'email' : undefined}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <Labelled label={label} htmlFor={id} error={error} hint={hint}>
      {control}
    </Labelled>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardDraft {
  /** As typed, grouped in fours; digits only reach the core. */
  number: string
  expMonth: string
  expYear: string
  name: string
  nickname: string
}

/** Digits in groups of four, the way the card prints them. */
function groupDigits(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 19)
  return digits.replace(/(.{4})(?=.)/g, '$1 ')
}

const MONTHS: MenuOption<string>[] = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1).padStart(2, '0')
}))

/** This year and the fifteen after it (a card's own year joins the list when it lies outside). */
function yearOptions(
  current: number | null,
  now: number = new Date().getFullYear()
): MenuOption<string>[] {
  const years = new Set<number>()
  if (current) years.add(current)
  for (let y = now; y < now + 16; y++) years.add(y)
  return [...years].sort((a, b) => a - b).map((y) => ({ value: String(y), label: String(y) }))
}

function CardForm({ edit, phone, busy, setBusy, register }: FormProps): JSX.Element | null {
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [existing, setExisting] = useState<PaymentCardSummary | null>(null)
  const [numberError, setNumberError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const number = useRef<HTMLInputElement>(null)
  const ids = { number: useId(), month: useId(), year: useId(), name: useId(), nickname: useId() }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let entry: PaymentCardSummary | undefined
      if (edit.id) {
        const cards = await cmd('autofill.listCards', undefined).catch(() => [])
        entry = cards.find((c) => c.id === edit.id)
        if (!cancelled && !entry) {
          closeAutofillEdit()
          return
        }
      }
      if (cancelled) return
      const now = new Date()
      setExisting(entry ?? null)
      setDraft({
        number: '',
        expMonth: String(entry?.expMonth ?? now.getMonth() + 1),
        expYear: String(entry?.expYear ?? now.getFullYear() + 3),
        name: entry?.name ?? '',
        nickname: entry?.nickname ?? ''
      })
    })()
    return () => {
      cancelled = true
    }
  }, [edit.id])

  const ready = draft !== null
  useEffect(() => {
    if (ready && !phone) number.current?.focus()
  }, [ready, phone])

  useEffect(() => {
    register(async () => {
      if (!draft) return
      const digits = draft.number.replace(/\D/g, '')
      if (!digits && !edit.id) {
        setNumberError('Enter the card number.')
        number.current?.focus()
        return
      }
      const card: PaymentCardInput = {
        number: digits,
        expMonth: Number(draft.expMonth),
        expYear: Number(draft.expYear),
        name: draft.name.trim(),
        nickname: draft.nickname.trim()
      }
      setBusy(true)
      try {
        if (edit.id) {
          const patch: Partial<PaymentCardInput> = { ...card }
          if (!digits) delete patch.number
          await cmd('autofill.updateCard', { id: edit.id, patch })
        } else {
          await cmd('autofill.addCard', { card })
        }
        closeAutofillEdit()
      } catch (e) {
        const message = messageOf(e)
        if (/number/i.test(message)) {
          setNumberError(message)
          number.current?.focus()
        } else setFormError(message)
        setBusy(false)
      }
    })
  })

  if (!draft) return null

  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]): void => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    if (key === 'number') setNumberError(null)
    setFormError(null)
  }
  return (
    <>
      <Labelled
        label="Card number"
        htmlFor={ids.number}
        error={numberError}
        hint={existing ? 'Leave empty to keep the saved number.' : undefined}
      >
        <Field
          ref={number}
          id={ids.number}
          secret
          value={draft.number}
          placeholder={
            existing
              ? `\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 ${existing.last4}`
              : ''
          }
          inputMode="numeric"
          autoComplete="cc-number"
          spellCheck={false}
          aria-invalid={numberError ? true : undefined}
          readOnly={busy}
          onChange={(e) => set('number', groupDigits(e.target.value))}
        />
      </Labelled>
      <div className="zen-v2-af-field-row">
        <Labelled label="Expiry month" htmlFor={ids.month}>
          <Menulist
            id={ids.month}
            label="Expiry month"
            value={draft.expMonth}
            options={MONTHS}
            readOnly={busy}
            onChange={(v) => set('expMonth', v)}
          />
        </Labelled>
        <Labelled label="Expiry year" htmlFor={ids.year}>
          <Menulist
            id={ids.year}
            label="Expiry year"
            value={draft.expYear}
            options={yearOptions(existing?.expYear ?? null)}
            readOnly={busy}
            onChange={(v) => set('expYear', v)}
          />
        </Labelled>
      </div>
      <Labelled label="Name on card" htmlFor={ids.name}>
        <Field
          id={ids.name}
          value={draft.name}
          autoComplete="cc-name"
          spellCheck={false}
          readOnly={busy}
          onChange={(e) => set('name', e.target.value)}
        />
      </Labelled>
      <Labelled
        label="Nickname (optional)"
        htmlFor={ids.nickname}
        hint="Names the card in the picker instead of its network and last digits."
      >
        <Field
          id={ids.nickname}
          value={draft.nickname}
          spellCheck={false}
          readOnly={busy}
          onChange={(e) => set('nickname', e.target.value)}
        />
      </Labelled>
      {formError && (
        <p className="zen-v2-af-error" role="alert">
          {formError}
        </p>
      )}
    </>
  )
}

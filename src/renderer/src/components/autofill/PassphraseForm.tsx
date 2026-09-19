import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { vaultGateForm } from '@renderer/lib/autofill'
import type { VaultGate } from '@renderer/lib/autofillSettings'
import { Btn, Field, Footer, Labelled } from './controls'

/**
 * The one passphrase form (§9.12, §9.30 as ruled 00:59 09-19), shared by the passphrase dialog,
 * the picker's unlock step and Settings' vault gate so the three cannot drift: the field with
 * its label above, the refused attempt as its validation text, the secondary and the primary in
 * the footer.
 *
 * Busy is one shape everywhere: the field turns read-only at full opacity with the typed value
 * in place – still masked, `type="password"` – ONLY the primary is busy (the spinner, `aria-busy`,
 * full opacity) and the secondary sits at .4, disabled. A refusal (busy ends with an error)
 * clears the field, gives it the focus and shows the validation text; a success leaves the
 * field as it is, values shown until the form is gone – the surface unmounts it.
 *
 * The field takes the focus as the form opens on desktop (`focusOnOpen`; a dialog's or a
 * popover's own rule, §9.22); a phone sheet leaves the opening focus to the sheet chassis, which
 * never puts it in a text field – the keyboard would come up with the sheet.
 */
export function PassphraseForm({
  label = 'Vault passphrase',
  autoComplete = 'current-password',
  error,
  busy,
  action = 'Unlock',
  cancel = 'Cancel',
  focusOnOpen = true,
  className,
  onCancel,
  onSubmit
}: {
  /** The field's label: "Vault passphrase", or "New vault passphrase" when creating one. */
  label?: string
  autoComplete?: 'current-password' | 'new-password'
  /** The refused attempt's message, shown under the field (§9.12). */
  error: string | null
  busy: boolean
  /** The primary's label: Unlock, or Create for a new passphrase. */
  action?: string
  /** The secondary's label: Cancel, or Back inside a picker. */
  cancel?: string
  /** The field takes the focus as the form mounts (desktop dialogs and popovers). */
  focusOnOpen?: boolean
  /** Layout class in place of the form body's default (`zen-v2-af-form`). */
  className?: string
  onCancel: () => void
  onSubmit: (passphrase: string) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusOnOpen) field.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, [])
  // A refused attempt: busy ended and an error came with it.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy && error) {
      setValue('')
      field.current?.focus()
    }
    wasBusy.current = busy
  }, [busy, error])
  return (
    <form
      className={className ?? 'zen-v2-af-form'}
      onSubmit={(e) => {
        e.preventDefault()
        if (!value || busy) return
        onSubmit(value)
      }}
    >
      <Labelled label={label} htmlFor={id} error={error}>
        <Field
          ref={field}
          id={id}
          type="password"
          secret
          value={value}
          autoComplete={autoComplete}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
      </Labelled>
      <Footer count={2}>
        <Btn disabled={busy} onClick={onCancel}>
          {cancel}
        </Btn>
        <Btn type="submit" variant="primary" busy={busy} disabled={!value && !busy}>
          {action}
        </Btn>
      </Footer>
    </form>
  )
}

/**
 * The vault gate's form (Settings > Autofill while the vault is locked, `useVaultGate`): the
 * shared form asking for the vault's passphrase, or – where the device cannot verify the user
 * and no vault exists yet – for a new one to create it with (`vaultGateForm`). In the desktop
 * card and at the phone page's gutter alike; Cancel returns to the idle gate.
 */
export function VaultPassphraseForm({ gate }: { gate: VaultGate }): JSX.Element {
  const form = vaultGateForm(gate.step)
  return (
    <PassphraseForm
      className="zen-v2-af-form zen-v2-af-gate-form"
      label={form.label}
      action={form.action}
      autoComplete={form.autoComplete}
      error={gate.error}
      busy={gate.busy}
      onCancel={gate.reset}
      onSubmit={(passphrase) => gate.unlock(passphrase)}
    />
  )
}

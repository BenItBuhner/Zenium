import type { JSX, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { Download, KeyRound, Lock, Upload } from 'lucide-react'
import type { ImportConflict, Settings, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PASSWORD_GRACE_OPTIONS, PASSWORDS_COPY, vaultProtectionLabel } from '../settingsCopy'
import { MIN_PASSPHRASE, usePhone } from './lib'
import {
  ActionRow,
  Btn,
  CheckRow,
  ChoiceRow,
  Description,
  Field,
  FormActions,
  Heading,
  PromptSheet,
  type PromptSheetHandle,
  Rows,
  SettingRow,
  TextField
} from './shared'
import type { Gate } from './useReauth'

const CONFLICT_OPTIONS: Array<{ value: ImportConflict; label: string }> = [
  { value: 'skip', label: 'Keep the saved one' },
  { value: 'replace', label: 'Replace it with the file' },
  { value: 'keep-both', label: 'Keep both' }
]

const CONFLICT_COPY = {
  label: 'If a login is already saved',
  description: 'What happens to a login in the file that matches one in the vault.'
}

const PASSPHRASE_WARNING =
  'It cannot be recovered: a forgotten passphrase means a new, empty vault.'

/**
 * The manager's own settings view (Chrome's Settings > Passwords, Firefox's about:logins menu):
 * saving, re-authentication, the vault's protection, import and export. Rows sit directly on
 * the page surface under 15/600 headings (v2 §6, §9.27). On the desktop a row's control trails
 * its text – a menulist, a button, the passphrase editor unfolding in an inner box – and Export
 * is armed inline and confirmed with a danger-ink button, never a filled red. On a phone the
 * rows are §10.4's: a choice is a value row opening a picker sheet (no menulist drawn), a thing
 * to do is an action row, a form (the passphrase) is a sheet, and the export's warning is a
 * confirmation sheet, never an inline button.
 */
export function ManagerSettings({ state, gate }: { state: UIState; gate: Gate }): JSX.Element {
  const phone = usePhone()
  const status = state.passwords
  const s = state.settings.passwords
  const set = (patch: Partial<Settings>): void => run('settings.update', patch)
  const [conflict, setConflict] = useState<ImportConflict>('skip')
  const [exportArmed, setExportArmed] = useState(false)
  const [passphraseOpen, setPassphraseOpen] = useState(false)

  const protection = vaultProtectionLabel(status)
  const verifies = status.osReauth
    ? 'This device can verify you with Touch ID, Windows Hello, a fingerprint or the screen lock.'
    : status.protection.passphrase
      ? 'The passphrase is asked for before a password is shown, copied or exported.'
      : 'Add a passphrase to be asked for one before a password is shown, copied or exported.'
  const passphraseAction = status.protection.passphrase ? 'Change passphrase' : 'Add passphrase'

  const doExport = async (): Promise<void> => {
    const result = await gate('Export every saved password', (passphrase) =>
      cmd('passwords.export', { passphrase })
    )
    setExportArmed(false)
    if (result && !result.saved) pushToast('Export cancelled')
  }

  return (
    <div className="zen-v2-pw-gutter zen-v2-pw-sections flex flex-col gap-6 pb-8">
      <Section title="Saving">
        <CheckRow
          label={PASSWORDS_COPY.offerToSave.label}
          description={PASSWORDS_COPY.offerToSave.description}
          checked={s.offerToSave}
          onChange={(v) => set({ passwords: { ...s, offerToSave: v } })}
        />
      </Section>

      <Section title="Security">
        <ChoiceRow
          label={PASSWORDS_COPY.grace.label}
          description={PASSWORDS_COPY.grace.description}
          value={String(s.reauthGraceSeconds)}
          options={PASSWORD_GRACE_OPTIONS}
          onChange={(v) => set({ passwords: { ...s, reauthGraceSeconds: Number(v) } })}
        />
        {phone ? (
          <ActionRow
            label={PASSWORDS_COPY.protection.label}
            description={protection}
            onPress={() => setPassphraseOpen(true)}
          />
        ) : (
          <SettingRow
            label={PASSWORDS_COPY.protection.label}
            description={`${protection}. ${verifies}`}
            clamp={false}
            stack={passphraseOpen}
          >
            {passphraseOpen ? (
              <PassphraseEditor
                hasPassphrase={status.protection.passphrase}
                gate={gate}
                onDone={() => setPassphraseOpen(false)}
              />
            ) : (
              <Btn onClick={() => setPassphraseOpen(true)}>
                <KeyRound />
                {passphraseAction}
              </Btn>
            )}
          </SettingRow>
        )}
        {phone ? (
          <ActionRow
            label={PASSWORDS_COPY.lock.label}
            description={PASSWORDS_COPY.lock.description}
            onPress={() => run('passwords.lock', undefined)}
          />
        ) : (
          <SettingRow
            label={PASSWORDS_COPY.lock.label}
            description={PASSWORDS_COPY.lock.description}
          >
            <Btn onClick={() => run('passwords.lock', undefined)}>
              <Lock /> Lock now
            </Btn>
          </SettingRow>
        )}
      </Section>

      <Section title="Import and export">
        {phone ? (
          <ActionRow
            label={PASSWORDS_COPY.importCsv.label}
            description={PASSWORDS_COPY.importCsv.description}
            onPress={() => void cmd('passwords.import', { conflict })}
          />
        ) : (
          <SettingRow
            label={PASSWORDS_COPY.importCsv.label}
            description={PASSWORDS_COPY.importCsv.description}
          >
            <Btn onClick={() => void cmd('passwords.import', { conflict })}>
              <Upload /> Choose file
            </Btn>
          </SettingRow>
        )}
        <ChoiceRow
          label={CONFLICT_COPY.label}
          description={CONFLICT_COPY.description}
          value={conflict}
          options={CONFLICT_OPTIONS}
          onChange={setConflict}
        />
        {phone ? (
          <ActionRow
            label={PASSWORDS_COPY.exportCsv.label}
            description={PASSWORDS_COPY.exportCsv.description}
            disabled={status.count === 0}
            onPress={() => setExportArmed(true)}
          />
        ) : (
          <SettingRow
            label={PASSWORDS_COPY.exportCsv.label}
            description={
              exportArmed ? PASSWORDS_COPY.exportCsv.armed : PASSWORDS_COPY.exportCsv.description
            }
            clamp={false}
          >
            {exportArmed ? (
              <>
                <Btn onClick={() => setExportArmed(false)}>Cancel</Btn>
                <Btn variant="danger" onClick={() => void doExport()}>
                  Export anyway
                </Btn>
              </>
            ) : (
              <Btn disabled={status.count === 0} onClick={() => setExportArmed(true)}>
                <Download /> Export
              </Btn>
            )}
          </SettingRow>
        )}
      </Section>

      {phone && passphraseOpen && (
        <PassphraseSheet
          title={passphraseAction}
          description={`${verifies} ${PASSPHRASE_WARNING}`}
          hasPassphrase={status.protection.passphrase}
          gate={gate}
          onClosed={() => setPassphraseOpen(false)}
        />
      )}
      {phone && exportArmed && (
        <ExportSheet onConfirm={() => void doExport()} onCancel={() => setExportArmed(false)} />
      )}
    </div>
  )
}

/** A group of rows under a 15/600 sentence-case heading; groups are 24–32 apart, without lines. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col">
      <Heading>{title}</Heading>
      <Rows>{children}</Rows>
    </section>
  )
}

/** The two passphrase fields and their state, shared by the desktop editor and the phone sheet. */
function usePassphraseForm(
  hasPassphrase: boolean,
  gate: Gate,
  onSaved: () => void
): {
  value: string
  confirm: string
  setValue: (v: string) => void
  setConfirm: (v: string) => void
  busy: boolean
  mismatch: boolean
  ready: boolean
  save: () => Promise<void>
} {
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== value
  const ready = value.length >= MIN_PASSPHRASE && confirm === value
  const save = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    const result = await gate(
      hasPassphrase ? 'Enter the current passphrase to change it' : 'Add a passphrase',
      (current) => cmd('passwords.setPassphrase', { passphrase: value, current })
    )
    setBusy(false)
    if (result !== null) {
      pushToast(hasPassphrase ? 'Passphrase changed' : 'Passphrase added')
      onSaved()
    }
  }
  return { value, confirm, setValue, setConfirm, busy, mismatch, ready, save }
}

/**
 * The fields (§9.12): the new passphrase and its confirmation, the mismatch said under the
 * second. The desktop's inline editor takes the focus itself as it appears in the pane
 * (`autoFocus`); in a sheet the chassis puts the focus on the first field (§9.22).
 */
function PassphraseFields({
  form,
  autoFocus = false,
  className
}: {
  form: ReturnType<typeof usePassphraseForm>
  autoFocus?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <Field id="vault-new-passphrase" label="New passphrase">
        {(aria) => (
          <TextField
            {...aria}
            type="password"
            autoFocus={autoFocus}
            readOnly={form.busy}
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSPHRASE} characters`}
            value={form.value}
            onChange={(e) => form.setValue(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="vault-new-passphrase-confirm"
        label="Confirm passphrase"
        error={form.mismatch ? 'The two passphrases differ.' : null}
      >
        {(aria) => (
          <TextField
            {...aria}
            type="password"
            readOnly={form.busy}
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => form.setConfirm(e.target.value)}
          />
        )}
      </Field>
    </div>
  )
}

/**
 * The desktop's Vault protection row while a passphrase is being added or changed: the form in
 * an inner box under the row's text (§6), a busy form per §9.30 while the vault takes it.
 */
function PassphraseEditor({
  hasPassphrase,
  gate,
  onDone
}: {
  hasPassphrase: boolean
  gate: Gate
  onDone: () => void
}): JSX.Element {
  const form = usePassphraseForm(hasPassphrase, gate, onDone)
  return (
    <form
      className="zen-v2-pw-inner-box zen-animate-fade flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void form.save()
      }}
    >
      <PassphraseFields
        form={form}
        autoFocus
        className="sm:flex-row sm:items-start sm:[&>*]:flex-1"
      />
      <Description>{PASSPHRASE_WARNING}</Description>
      <FormActions>
        <Btn onClick={onDone} disabled={form.busy}>
          Cancel
        </Btn>
        <Btn type="submit" variant="primary" busy={form.busy} disabled={!form.ready}>
          {hasPassphrase ? 'Change passphrase' : 'Add passphrase'}
        </Btn>
      </FormActions>
    </form>
  )
}

/** The phone's passphrase form as a sheet (§10.4, §9.23): title block, the two fields, the footer. */
function PassphraseSheet({
  title,
  description,
  hasPassphrase,
  gate,
  onClosed
}: {
  title: string
  description: string
  hasPassphrase: boolean
  gate: Gate
  onClosed: () => void
}): JSX.Element {
  const sheet = useRef<PromptSheetHandle>(null)
  const formId = useId()
  const form = usePassphraseForm(hasPassphrase, gate, () => sheet.current?.dismiss())
  return (
    <PromptSheet
      ref={sheet}
      name="passwords-passphrase-editor"
      title={title}
      description={description}
      onClosed={onClosed}
      // The mismatch line under the second field is the one thing that changes the body's height.
      contentKey={form.mismatch ? 'mismatch' : 'clean'}
      footer={
        <>
          <Btn onClick={() => sheet.current?.dismiss()} disabled={form.busy}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            form={formId}
            variant="primary"
            busy={form.busy}
            disabled={!form.ready}
          >
            {title}
          </Btn>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          void form.save()
        }}
      >
        <PassphraseFields form={form} className="px-4" />
      </form>
    </PromptSheet>
  )
}

/** The phone's export warning as a confirmation sheet (§10.4): Export anyway in the danger ink. */
function ExportSheet({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const sheet = useRef<PromptSheetHandle>(null)
  const confirmed = useRef(false)
  return (
    <PromptSheet
      ref={sheet}
      name="passwords-export"
      title="Export every password?"
      description={PASSWORDS_COPY.exportCsv.armed}
      onClosed={() => (confirmed.current ? onConfirm() : onCancel())}
      footer={
        <>
          <Btn onClick={() => sheet.current?.dismiss()}>Cancel</Btn>
          <Btn
            variant="danger"
            onClick={() => {
              confirmed.current = true
              sheet.current?.dismiss()
            }}
          >
            Export anyway
          </Btn>
        </>
      }
    />
  )
}

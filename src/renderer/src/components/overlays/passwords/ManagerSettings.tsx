import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Download, KeyRound, Lock, Upload } from 'lucide-react'
import type { ImportConflict, Settings, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PASSWORD_GRACE_OPTIONS, PASSWORDS_COPY, vaultProtectionLabel } from '../settingsCopy'
import { MIN_PASSPHRASE, usePhone } from './lib'
import {
  Btn,
  CheckRow,
  Description,
  ErrorNote,
  Field,
  Heading,
  Menulist,
  SettingRow,
  TextField
} from './shared'
import type { Gate } from './useReauth'

const CONFLICT_OPTIONS: Array<{ value: ImportConflict; label: string }> = [
  { value: 'skip', label: 'Keep the saved one' },
  { value: 'replace', label: 'Replace it with the file' },
  { value: 'keep-both', label: 'Keep both' }
]

/**
 * The manager's own settings view (Chrome's Settings > Passwords, Firefox's about:logins menu):
 * saving, re-authentication, the vault's protection, import and export. Rows sit directly on the
 * page surface under 15/600 headings (v2 §6); wide controls drop under their label on a phone.
 * Export is armed inline and confirmed with a danger-ink button, never a filled red.
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
        <SettingRow
          label={PASSWORDS_COPY.grace.label}
          description={PASSWORDS_COPY.grace.description}
          stack={phone}
        >
          <Menulist
            label={PASSWORDS_COPY.grace.label}
            value={String(s.reauthGraceSeconds)}
            options={PASSWORD_GRACE_OPTIONS}
            onChange={(v) => set({ passwords: { ...s, reauthGraceSeconds: Number(v) } })}
          />
        </SettingRow>
        <SettingRow
          label={PASSWORDS_COPY.protection.label}
          description={`${protection}. ${verifies}`}
          clamp={false}
          stack={phone || passphraseOpen}
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
              {status.protection.passphrase ? 'Change passphrase' : 'Add passphrase'}
            </Btn>
          )}
        </SettingRow>
        <SettingRow label={PASSWORDS_COPY.lock.label} description={PASSWORDS_COPY.lock.description}>
          <Btn onClick={() => run('passwords.lock', undefined)}>
            <Lock /> Lock now
          </Btn>
        </SettingRow>
      </Section>

      <Section title="Import and export">
        <SettingRow
          label={PASSWORDS_COPY.importCsv.label}
          description={PASSWORDS_COPY.importCsv.description}
        >
          <Btn onClick={() => void cmd('passwords.import', { conflict })}>
            <Upload /> Choose file
          </Btn>
        </SettingRow>
        <SettingRow
          label="If a login is already saved"
          description="What happens to a login in the file that matches one in the vault."
          stack={phone}
        >
          <Menulist
            label="If a login is already saved"
            value={conflict}
            options={CONFLICT_OPTIONS}
            onChange={setConflict}
          />
        </SettingRow>
        <SettingRow
          label={PASSWORDS_COPY.exportCsv.label}
          description={
            exportArmed ? PASSWORDS_COPY.exportCsv.armed : PASSWORDS_COPY.exportCsv.description
          }
          clamp={false}
          stack={phone && exportArmed}
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
      </Section>
    </div>
  )
}

/** A group of rows under a 15/600 sentence-case heading; groups are 24–32 apart, without lines. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col">
      <Heading>{title}</Heading>
      {children}
    </section>
  )
}

/** The Vault protection row's control while a passphrase is being added or changed. */
function PassphraseEditor({
  hasPassphrase,
  gate,
  onDone
}: {
  hasPassphrase: boolean
  gate: Gate
  onDone: () => void
}): JSX.Element {
  const phone = usePhone()
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== value
  const ready = value.length >= MIN_PASSPHRASE && confirm === value
  const save = async (): Promise<void> => {
    setBusy(true)
    const result = await gate(
      hasPassphrase ? 'Enter the current passphrase to change it' : 'Add a passphrase',
      (current) => cmd('passwords.setPassphrase', { passphrase: value, current })
    )
    setBusy(false)
    if (result !== null) {
      pushToast(hasPassphrase ? 'Passphrase changed' : 'Passphrase added')
      onDone()
    }
  }
  return (
    <form
      className="zen-v2-pw-inner-box zen-animate-fade flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) void save()
      }}
    >
      <div className={cn('flex gap-3', phone ? 'flex-col' : 'items-start')}>
        <Field label="New passphrase" htmlFor="vault-new-passphrase" className="min-w-0 flex-1">
          <TextField
            id="vault-new-passphrase"
            type="password"
            autoFocus
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSPHRASE} characters`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field
          label="Confirm passphrase"
          htmlFor="vault-new-passphrase-confirm"
          className="min-w-0 flex-1"
        >
          <TextField
            id="vault-new-passphrase-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
          />
          {mismatch && <ErrorNote>The two passphrases differ.</ErrorNote>}
        </Field>
      </div>
      <Description>
        It cannot be recovered: a forgotten passphrase means a new, empty vault.
      </Description>
      <div className={cn('flex gap-2', phone ? 'flex-col-reverse' : 'justify-end')}>
        <Btn onClick={onDone}>Cancel</Btn>
        <Btn type="submit" variant="primary" busy={busy} disabled={!ready}>
          {hasPassphrase ? 'Change passphrase' : 'Add passphrase'}
        </Btn>
      </div>
    </form>
  )
}

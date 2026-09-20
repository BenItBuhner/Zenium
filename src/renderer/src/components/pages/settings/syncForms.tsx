import type { JSX } from 'react'
import { useRef, useState } from 'react'
import type { SyncScope } from '@shared/types'
import { run } from '@renderer/lib/api'
import { SYNC_COPY, SYNC_PASSPHRASE_MIN, syncSetupStore, turnOnSync } from '@renderer/lib/syncSetup'
import { cn } from '@renderer/lib/utils'
import { V2CheckRow } from '../../extensions/v2'
import { Field, RadioOption, SheetActions, ValidationMessage } from './blocks'

/**
 * The forms inside Settings › Sync's sheets (`sync.tsx` builds the rows that open them): the
 * passphrase form of Turn on sync, the first sync's merge question, and Turn off sync's prompt.
 */

/**
 * The passphrase form (§9.12): two secret fields in the platform monospace (§4), the second
 * checked against the first. Too short or unequal is said under the field at fault before
 * anything is sent (§9.12); then the §9.30 busy form while the engine derives the key and reads
 * the folder – fields read-only with their values, the primary busy, Cancel at .4 – and a
 * refusal from the engine clears both fields, gives the first the focus and shows its reason
 * under it. Sync on, the sheet closes (its row is gone from the page with it).
 */
export function SyncPassphraseForm({
  folder,
  deviceName,
  scope,
  close
}: {
  folder: string
  deviceName: string
  scope: SyncScope
  close: () => void
}): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'passphrase' | 'confirm'; message: string } | null>(
    null
  )
  const first = useRef<HTMLInputElement>(null)
  const second = useRef<HTMLInputElement>(null)
  const submit = (): void => {
    if (busy) return
    if (passphrase.length < SYNC_PASSPHRASE_MIN) {
      setError({ field: 'passphrase', message: SYNC_COPY.tooShort })
      first.current?.focus()
      return
    }
    if (confirm !== passphrase) {
      setError({ field: 'confirm', message: SYNC_COPY.mismatch })
      second.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    void turnOnSync({ folder, passphrase, deviceName, scope }).then((refusal) => {
      if (refusal === null) {
        syncSetupStore.set({ folder: null })
        close()
        return
      }
      setBusy(false)
      setPassphrase('')
      setConfirm('')
      setError({ field: 'passphrase', message: refusal })
      first.current?.focus()
    })
  }
  const field = (
    id: 'passphrase' | 'confirm',
    ref: typeof first,
    value: string,
    onChange: (value: string) => void
  ): JSX.Element => {
    const message = error?.field === id ? error.message : null
    return (
      <Field
        id={`sync-${id}`}
        label={id === 'passphrase' ? SYNC_COPY.passphrase : SYNC_COPY.confirm}
      >
        <input
          ref={ref}
          id={`sync-${id}`}
          className={cn('zen-settings-input zen-v2-field zen-settings-secret')}
          type="password"
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          readOnly={busy}
          aria-invalid={message ? true : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {message && <ValidationMessage message={message} />}
      </Field>
    )
  }
  return (
    <div
      className="zen-settings-form"
      aria-busy={busy || undefined}
      data-testid="sync-passphrase-form"
    >
      {field('passphrase', first, passphrase, setPassphrase)}
      {field('confirm', second, confirm, setConfirm)}
      <SheetActions
        action={SYNC_COPY.turnOn}
        busy={busy}
        disabled={!passphrase || !confirm}
        onCancel={close}
        onAction={submit}
      />
    </div>
  )
}

/**
 * The first sync's question (§9.23, §9.14): merge, or keep only this device's data – two radio
 * rows, Merge picked, Continue answers `sync.confirmMerge`. Cancel leaves the question standing;
 * its row stays on the page until it is answered.
 */
export function SyncMergeForm({ close }: { close: () => void }): JSX.Element {
  const [merge, setMerge] = useState(true)
  return (
    <div className="zen-settings-form" data-testid="sync-merge-form">
      <div role="radiogroup" aria-label={SYNC_COPY.mergeTitle} className="zen-settings-radio-list">
        <RadioOption
          label={SYNC_COPY.merge}
          description={SYNC_COPY.mergeHint}
          checked={merge}
          onSelect={() => setMerge(true)}
        />
        <RadioOption
          label={SYNC_COPY.replace}
          description={SYNC_COPY.replaceHint}
          checked={!merge}
          onSelect={() => setMerge(false)}
        />
      </div>
      <SheetActions
        action={SYNC_COPY.continue}
        onCancel={close}
        onAction={() => {
          run('sync.confirmMerge', { merge })
          close()
        }}
      />
    </div>
  )
}

/**
 * Turn off sync (§9.23): the prompt's one choice – also removing this device's file from the
 * folder – is a checkbox row (the shared `.zen-v2-checkbox`, 20 on a phone) submitted with the
 * destructive action, never a switch: nothing happens until Turn off.
 */
export function SyncDisconnectForm({ close }: { close: () => void }): JSX.Element {
  const [wipeRemote, setWipeRemote] = useState(false)
  return (
    <div className="zen-settings-form" data-testid="sync-disconnect-form">
      <V2CheckRow
        label={SYNC_COPY.wipeRemote}
        description={SYNC_COPY.wipeRemoteHint}
        checked={wipeRemote}
        onChange={setWipeRemote}
      />
      <SheetActions
        action={SYNC_COPY.turnOffAction}
        destructive
        onCancel={close}
        onAction={() => {
          run('sync.disconnect', { wipeRemote })
          syncSetupStore.set({ folder: null })
          close()
        }}
      />
    </div>
  )
}

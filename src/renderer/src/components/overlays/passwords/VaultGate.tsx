import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Fingerprint, KeyRound, ShieldAlert } from 'lucide-react'
import type { PasswordsStatus } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { MIN_PASSPHRASE } from './lib'
import { Btn, Description, ErrorNote, Field, StatusGlyph, TextField } from './shared'

/**
 * What the manager shows while the vault is closed: an unreadable vault with a way to start over,
 * the first-run passphrase setup on devices without an OS keystore, a passphrase prompt, or the
 * OS unlock (attempted once automatically, so desktop keychains open silently and Android shows
 * its device credential sheet right away).
 */
export function VaultGate({ status }: { status: PasswordsStatus }): JSX.Element {
  const exists = status.protection.os || status.protection.passphrase
  const needsSetup = !exists && !status.osKeystore && !status.error
  // The device key opens the vault (or creates it) without the user typing anything.
  const deviceOpens = !status.error && (status.protection.os || (!exists && status.osKeystore))
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [needPassphrase, setNeedPassphrase] = useState(
    () => !needsSetup && !deviceOpens && status.protection.passphrase
  )
  const [confirmReset, setConfirmReset] = useState(false)

  const unlock = async (value?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await cmd(
        'passwords.unlock',
        value === undefined ? {} : { passphrase: value }
      )
      if (outcome.status === 'passphrase') setNeedPassphrase(true)
      else if (outcome.status === 'setup-passphrase') setNeedPassphrase(false)
      else if (outcome.status === 'denied') {
        // A refused device key is something to try again: a dismissed prompt or a keystore that
        // is unusable right now. Only the engine decides a vault is unreadable (`status.error`),
        // and only there is starting over offered.
        setError(
          value === undefined
            ? (outcome.reason ?? 'Zenium could not open the vault with the device key.')
            : 'That passphrase does not open the vault.'
        )
      }
    } finally {
      setBusy(false)
    }
  }

  // Open silently where the device can (safeStorage), or show the device prompt once, after the
  // gate has painted.
  useEffect(() => {
    if (!deviceOpens) return
    const timer = setTimeout(() => void unlock(), 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a one-time attempt when the gate mounts
  }, [])

  // Throwing the vault away, always behind a second step that says what it costs.
  const startOver = confirmReset ? (
    <div className="flex flex-col items-center gap-3">
      <ErrorNote>Every saved password in it will be lost.</ErrorNote>
      <div className="flex flex-wrap justify-center gap-2">
        <Btn onClick={() => setConfirmReset(false)}>Keep the file</Btn>
        <Btn variant="danger" onClick={() => void cmd('passwords.reset', undefined)}>
          Start over
        </Btn>
      </div>
    </div>
  ) : (
    <Btn onClick={() => setConfirmReset(true)}>Start over with an empty vault</Btn>
  )

  if (status.error) {
    return (
      <Hero
        icon={<ShieldAlert />}
        tone="danger"
        title="The password vault could not be read"
        text={status.error}
      >
        {startOver}
      </Hero>
    )
  }

  if (needsSetup) {
    const mismatch = confirm.length > 0 && confirm !== passphrase
    const ready = passphrase.length >= MIN_PASSPHRASE && confirm === passphrase
    return (
      <Hero
        icon={<KeyRound />}
        title="Protect your passwords with a passphrase"
        text="This device has no system keychain Zenium can use, so a passphrase encrypts the vault and is asked for before a password is shown, copied or exported. It cannot be recovered."
      >
        <form
          className="flex w-full max-w-[360px] flex-col gap-3 text-left"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && !busy) void unlock(passphrase)
          }}
        >
          <Field label="Passphrase" htmlFor="vault-new">
            <TextField
              id="vault-new"
              type="password"
              autoFocus
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSPHRASE} characters`}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
          <Field label="Confirm passphrase" htmlFor="vault-new-confirm">
            <TextField
              id="vault-new-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {mismatch && <ErrorNote>The two passphrases differ.</ErrorNote>}
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Btn
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!ready}
            className="mt-1 self-end"
          >
            Create vault
          </Btn>
        </form>
      </Hero>
    )
  }

  if (needPassphrase) {
    return (
      <Hero
        icon={<KeyRound />}
        title="Unlock your passwords"
        text={
          status.protection.os
            ? 'The device key did not open the vault; the passphrase still does.'
            : 'Enter the vault passphrase to see your saved logins.'
        }
      >
        <form
          className="flex w-full max-w-[360px] flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (passphrase && !busy) void unlock(passphrase)
          }}
        >
          <TextField
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Passphrase"
            aria-label="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          <Btn
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!passphrase}
            className="self-end"
          >
            Unlock
          </Btn>
        </form>
      </Hero>
    )
  }

  return (
    <Hero
      icon={<Fingerprint />}
      title="Unlock your passwords"
      text={
        status.osReauth
          ? 'Confirm it is you to open the vault.'
          : 'The vault is protected by this device.'
      }
    >
      <div className="flex flex-col items-center gap-3">
        {error && <ErrorNote>{error}</ErrorNote>}
        <Btn variant="primary" busy={busy} onClick={() => void unlock()}>
          Unlock
        </Btn>
      </div>
    </Hero>
  )
}

function Hero({
  icon,
  tone = 'accent',
  title,
  text,
  children
}: {
  icon: JSX.Element
  tone?: 'accent' | 'danger'
  title: string
  text: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="zen-animate-fade zen-v2-pw-gutter flex min-h-0 flex-1 items-center justify-center overflow-y-auto py-6">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-5 text-center">
        <StatusGlyph tone={tone} hero>
          {icon}
        </StatusGlyph>
        <div className="flex flex-col gap-1">
          <h3 className="zen-v2-pw-panel-title">{title}</h3>
          <Description>{text}</Description>
        </div>
        {children}
      </div>
    </div>
  )
}

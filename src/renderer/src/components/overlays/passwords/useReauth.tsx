import type { JSX } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { ReauthOutcome } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { PassphrasePrompt, type PassphraseRequest } from './PassphrasePrompt'

/** Runs a command that may ask for re-authentication; null when the user backs out. */
export type Gate = <T>(
  reason: string,
  call: (passphrase?: string) => Promise<ReauthOutcome<T>>
) => Promise<T | null>

interface Pending extends PassphraseRequest {
  resolve: (passphrase: string | null) => void
}

/**
 * Runs a re-authenticated command and turns its `ReauthOutcome` into a value. The OS prompt (Touch
 * ID, Windows Hello, Android biometrics or PIN) happens inside the core; when the core instead
 * asks for the vault passphrase, or for one to be created first, this hook shows the prompt and
 * calls the command again with it. Resolves null when the user backs out or cannot be verified.
 */
export function useReauth(): { gate: Gate; prompt: JSX.Element | null } {
  const [request, setRequest] = useState<Pending | null>(null)
  const requestRef = useRef<Pending | null>(null)

  const ask = useCallback(
    (mode: PassphraseRequest['mode'], reason: string, error: string | null) => {
      return new Promise<string | null>((resolve) => {
        const next: Pending = { mode, reason, error, resolve }
        requestRef.current = next
        setRequest(next)
      })
    },
    []
  )

  const settle = useCallback((passphrase: string | null) => {
    const current = requestRef.current
    requestRef.current = null
    setRequest(null)
    current?.resolve(passphrase)
  }, [])

  const gate = useCallback<Gate>(
    async (reason, call) => {
      let outcome = await call()
      if (outcome.status === 'setup-passphrase') {
        const passphrase = await ask('setup', reason, null)
        if (passphrase === null) return null
        const set = await cmd('passwords.setPassphrase', { passphrase })
        if (set.status !== 'ok') return null
        outcome = await call(passphrase)
      }
      let error: string | null = null
      for (let attempt = 0; attempt < 5 && outcome.status === 'passphrase'; attempt++) {
        const passphrase = await ask('passphrase', reason, error)
        if (passphrase === null) return null
        outcome = await call(passphrase)
        if (outcome.status === 'denied') {
          error = 'That passphrase does not open the vault.'
          outcome = { status: 'passphrase' }
        }
      }
      return outcome.status === 'ok' ? outcome.value : null
    },
    [ask]
  )

  const prompt = request ? <PassphrasePrompt request={request} onSettle={settle} /> : null
  return { gate, prompt }
}

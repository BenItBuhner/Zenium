import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import type { ReauthOutcome } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { PassphrasePrompt, type PassphraseRequest } from './PassphrasePrompt'

/** Runs a command that may ask for re-authentication; null when the user backs out. */
export type Gate = <T>(
  reason: string,
  call: (passphrase?: string) => Promise<ReauthOutcome<T>>
) => Promise<T | null>

/** What one try of a passphrase came to: the command's value, or why the vault refused it. */
type Tried<T> = { kind: 'accepted'; value: T | null } | { kind: 'refused'; reason: string }

interface Pending extends PassphraseRequest {
  /** The prompt has left the screen; `accepted` says whether a passphrase opened the vault. */
  onGone: (accepted: boolean) => void
}

/**
 * Runs a re-authenticated command and turns its `ReauthOutcome` into a value. The OS prompt (Touch
 * ID, Windows Hello, Android biometrics or PIN) happens inside the core; when the core instead
 * asks for the vault passphrase, or for one to be created first, this hook shows the prompt and
 * calls the command again with what is typed. The prompt is a busy form (v2 §9.30): it stays up
 * while a passphrase is verified and, refused, clears its field and says so under it, as often
 * as the user tries; accepted, it leaves with the value in place. Resolves null when the user
 * backs out or cannot be verified.
 */
export function useReauth(): { gate: Gate; prompt: JSX.Element | null } {
  const [request, setRequest] = useState<Pending | null>(null)

  /**
   * Show the prompt and resolve with the first accepted try's value – at once, while the
   * prompt is still leaving, so what asked (a reveal, a copy) goes ahead under it – or with
   * null once it has left unanswered.
   */
  const ask = useCallback(
    <T,>(
      mode: PassphraseRequest['mode'],
      reason: string,
      attempt: (passphrase: string) => Promise<Tried<T>>
    ): Promise<T | null> =>
      new Promise((resolve) => {
        setRequest({
          mode,
          reason,
          verify: async (passphrase) => {
            const tried = await attempt(passphrase)
            if (tried.kind === 'refused') return tried.reason
            resolve(tried.value)
            return null
          },
          onGone: (accepted) => {
            setRequest(null)
            if (!accepted) resolve(null)
          }
        })
      }),
    []
  )

  const gate = useCallback<Gate>(
    async <T,>(
      reason: string,
      call: (passphrase?: string) => Promise<ReauthOutcome<T>>
    ): Promise<T | null> => {
      let outcome = await call()
      if (outcome.status === 'setup-passphrase') {
        // No OS verification on this device: a passphrase is created first, then the command
        // runs behind it.
        const created = await ask<string>('setup', reason, async (passphrase) => {
          const set = await cmd('passwords.setPassphrase', { passphrase })
          if (set.status === 'ok') return { kind: 'accepted', value: passphrase }
          return {
            kind: 'refused',
            reason: (set.status === 'denied' && set.reason) || 'That passphrase could not be set.'
          }
        })
        if (created === null) return null
        outcome = await call(created)
      }
      if (outcome.status === 'passphrase') {
        return ask<T>('passphrase', reason, async (passphrase) => {
          const next = await call(passphrase)
          if (next.status === 'denied')
            return { kind: 'refused', reason: 'That passphrase does not open the vault.' }
          return { kind: 'accepted', value: next.status === 'ok' ? next.value : null }
        })
      }
      return outcome.status === 'ok' ? outcome.value : null
    },
    [ask]
  )

  const prompt = request ? <PassphrasePrompt request={request} onGone={request.onGone} /> : null
  return { gate, prompt }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddressEntry, PasskeyEntry, PaymentCardSummary, UIState } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import {
  IDLE_VAULT_GATE,
  copyCardNumber,
  unlockRefusal,
  unlockVault,
  type VaultGateState
} from '@renderer/lib/autofill'

/**
 * What Settings > Autofill reads of the vault and does to it, on both platforms: the desktop
 * section's groups (`overlays/AutofillSection.tsx`) and the phone page's builder
 * (`pages/settings/sections.tsx`, `autofillSection`) share these hooks. The builder is a plain
 * function of the state, so the phone page runs `useAutofillSettings` once and hands the
 * result in through its `SectionContext`; the desktop groups call the hooks themselves.
 */

/**
 * A vault list, fetched while `live` and again whenever the core's autofill revision moves
 * (`autofill.revision`: a save, an edit, a removal, in this window or another); `null` until it
 * has arrived, and whenever the list is not live – the vault locked, the section not shown –
 * so a group that lists it draws nothing rather than a stale or an empty state.
 */
export function useVaultList<T>(
  fetch: () => Promise<T[]>,
  revision: number,
  live = true
): T[] | null {
  const [list, setList] = useState<T[] | null>(null)
  useEffect(() => {
    if (!live) return
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fetch` is a command wrapper; the revision and `live` are what change
  }, [revision, live])
  return live ? list : null
}

/** The gate's state and what moves it. */
export interface VaultGate extends VaultGateState {
  /**
   * One unlock attempt (§9.30: the action or the form's Unlock busy meanwhile): without a
   * passphrase first – the device's own check where it has one – then with the form's answer.
   * `passphrase` and `setup-passphrase` bring the form up; a refusal is the form's validation
   * text (the idle gate's description, when there was no form); success leaves the gate as it
   * stands until the vault's status takes it away.
   */
  unlock(passphrase?: string): void
  /** The form's Cancel: back to the idle gate. */
  reset(): void
}

/**
 * The vault gate (Settings > Autofill while the vault is locked) as state: idle offers Unlock,
 * a `passphrase` outcome brings the passphrase form up, `setup-passphrase` the form that
 * creates one. `locked` is the vault's status: the gate resets when the vault locks again, so
 * it opens idle each time, and a successful attempt leaves it busy – the form's values shown
 * until the unlocked status takes the gate away (§9.30).
 */
export function useVaultGate(locked: boolean): VaultGate {
  const [gate, setGate] = useState<VaultGateState>(IDLE_VAULT_GATE)
  // Adjusting state on a prop change during render (React's own pattern): a lock or an unlock
  // starts the gate over.
  const [wasLocked, setWasLocked] = useState(locked)
  if (locked !== wasLocked) {
    setWasLocked(locked)
    setGate(IDLE_VAULT_GATE)
  }
  // An attempt that answers after the surface has gone writes nothing (StrictMode's dry run
  // of the effect leaves the flag true again on the real mount).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const unlock = useCallback((passphrase?: string): void => {
    setGate((g) => ({ ...g, busy: true, error: null }))
    void unlockVault(passphrase).then((result) => {
      if (!alive.current) return
      switch (result.status) {
        case 'ok':
          // Busy until the status flips: the form closes with its values shown (§9.30).
          return
        case 'passphrase':
          setGate({ step: 'passphrase', busy: false, error: null })
          return
        case 'setup-passphrase':
          setGate({ step: 'setup', busy: false, error: null })
          return
        case 'denied':
          setGate((g) => ({
            ...g,
            busy: false,
            error: unlockRefusal(result, passphrase !== undefined)
          }))
      }
    })
  }, [])
  const reset = useCallback(() => setGate(IDLE_VAULT_GATE), [])
  return { ...gate, unlock, reset }
}

/** The vault as the phone page's builder reads it, and the actions its rows run. */
export interface AutofillSettingsData {
  /** The vault's lists: `null` until fetched, and while the vault is locked or the section is not shown. */
  addresses: AddressEntry[] | null
  cards: PaymentCardSummary[] | null
  passkeys: PasskeyEntry[] | null
  gate: VaultGate
  /** The card whose number is on its way to the clipboard: its row is busy (§9.30). */
  copying: string | null
  /** Copy a card's number, behind re-authentication (the passphrase sheet takes over when asked). */
  copyCard(card: PaymentCardSummary): void
}

/**
 * Settings > Autofill's vault data for the phone page: the three lists while the Autofill
 * section is shown (`active`) and the vault is unlocked, the gate while it is locked, and the
 * card-copy action with its busy card. The landing's search builds every section with this too,
 * with no lists (`active` false): the switches and choices are searchable, the entries are not.
 */
export function useAutofillSettings(state: UIState, active: boolean): AutofillSettingsData {
  const locked = state.passwords.locked
  const live = active && !locked && state.capabilities.passwords
  const revision = state.autofill.revision
  const addresses = useVaultList<AddressEntry>(
    () => cmd('autofill.listAddresses', undefined),
    revision,
    live
  )
  const cards = useVaultList<PaymentCardSummary>(
    () => cmd('autofill.listCards', undefined),
    revision,
    live
  )
  const passkeys = useVaultList<PasskeyEntry>(
    () => cmd('autofill.listPasskeys', undefined),
    revision,
    live
  )
  const gate = useVaultGate(locked)
  const [copying, setCopying] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const copyCard = useCallback((card: PaymentCardSummary): void => {
    setCopying(card.id)
    void copyCardNumber(card).finally(() => {
      if (alive.current) setCopying(null)
    })
  }, [])
  return { addresses, cards, passkeys, gate, copying, copyCard }
}

/** The idle vault data: no lists, the gate idle, actions that do nothing (a test's, a preview's). */
export function idleAutofillSettings(): AutofillSettingsData {
  return {
    addresses: null,
    cards: null,
    passkeys: null,
    gate: { ...IDLE_VAULT_GATE, unlock: () => undefined, reset: () => undefined },
    copying: null,
    copyCard: () => undefined
  }
}

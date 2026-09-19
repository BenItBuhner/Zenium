import { useCallback, useEffect, useState } from 'react'
import {
  BROWSING_DATA_ADVANCED,
  BROWSING_DATA_BASIC,
  type BrowsingDataCount,
  type BrowsingDataRange,
  type BrowsingDataType,
  type ClearBrowsingDataResult,
  type ReauthOutcome
} from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { clearedToast } from '@renderer/lib/browsingData'
import { pushToast } from '@renderer/lib/ui'

/**
 * The state of the Clear browsing data form, shared by the desktop dialog
 * (`ClearBrowsingDataDialog`) and the phone form sheet the Settings builder opens
 * (`ClearBrowsingDataForm`): the range, Basic or Advanced, the types checked, the counts for the
 * range (`privacy.clearBrowsingDataCounts`, read again for every range), and the submission
 * through `privacy.clearBrowsingData` with its re-authentication round – the vault wants its
 * passphrase before saved passwords go. §9.30 while it clears: the form is busy, not disabled –
 * every field keeps its value at full opacity and only the primary works; a refused passphrase
 * clears the field (`refusals` counts the refusals so the field can take the focus back) and
 * shows its validation text.
 */

export type ClearMode = 'basic' | 'advanced'

export interface ClearFormState {
  range: BrowsingDataRange
  mode: ClearMode
  checked: Set<BrowsingDataType>
  counts: BrowsingDataCount[] | null
  busy: boolean
  /** The vault wants its passphrase before passwords go; the field's value once it shows. */
  passphrase: string | null
  /** Why the last attempt stopped, under the passphrase field or the list. */
  error: string | null
  /** How many passphrases the vault has refused: the field re-focuses on each. */
  refusals: number
}

export interface ClearForm {
  form: ClearFormState
  /** The types the current mode lists. */
  types: readonly BrowsingDataType[]
  /** The checked types the range can clear now: what a submit sends. */
  selected: BrowsingDataType[]
  /** Whether the type's count says it cannot go now, with the reason. */
  unavailableFor(type: BrowsingDataType): string | null
  setRange(range: BrowsingDataRange): void
  setMode(mode: ClearMode): void
  toggle(type: BrowsingDataType, on: boolean): void
  setPassphrase(value: string): void
  submit(): void
}

const INITIAL_CHECKED: BrowsingDataType[] = ['history', 'cookies', 'cache']

export function useClearForm(onDone: () => void): ClearForm {
  const [form, setForm] = useState<ClearFormState>({
    range: 'hour',
    mode: 'basic',
    checked: new Set(INITIAL_CHECKED),
    counts: null,
    busy: false,
    passphrase: null,
    error: null,
    refusals: 0
  })
  // One counts reading per range; a change of range while one is in flight drops the older
  // (`setRange` clears the counts, so the lines read "Counting…" meanwhile).
  useEffect(() => {
    let cancelled = false
    cmd('privacy.clearBrowsingDataCounts', { range: form.range }).then(
      (counts) => {
        if (!cancelled) setForm((f) => ({ ...f, counts }))
      },
      () => {
        if (!cancelled) setForm((f) => ({ ...f, counts: [] }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [form.range])

  const types = form.mode === 'basic' ? BROWSING_DATA_BASIC : BROWSING_DATA_ADVANCED
  const unavailable = new Set(
    (form.counts ?? []).filter((c) => c.unavailable !== null).map((c) => c.type)
  )
  const selected = types.filter((t) => form.checked.has(t) && !unavailable.has(t))

  const submit = useCallback((): void => {
    if (form.busy || selected.length === 0) return
    setForm((f) => ({ ...f, busy: true, error: null }))
    const args = {
      range: form.range,
      types: selected,
      ...(form.passphrase !== null ? { passphrase: form.passphrase } : {})
    }
    cmd('privacy.clearBrowsingData', args).then(
      (outcome: ReauthOutcome<ClearBrowsingDataResult>) => {
        switch (outcome.status) {
          case 'ok':
            pushToast(clearedToast(outcome.value.cleared))
            onDone()
            return
          case 'passphrase':
            // The field appears on the first ask; a refused passphrase leaves it empty (§9.30)
            // with the validation text under it.
            setForm((f) => ({
              ...f,
              busy: false,
              passphrase: '',
              error: f.passphrase ? 'That passphrase is not right' : null,
              refusals: f.passphrase ? f.refusals + 1 : f.refusals
            }))
            return
          case 'setup-passphrase':
            setForm((f) => ({
              ...f,
              busy: false,
              error:
                'This device cannot verify you. Set a vault passphrase in Passwords first, or leave saved passwords out.'
            }))
            return
          default:
            setForm((f) => ({
              ...f,
              busy: false,
              error: outcome.reason ?? 'Authentication did not pass; nothing was cleared'
            }))
        }
      },
      () => {
        setForm((f) => ({ ...f, busy: false, error: 'That did not work. Try again.' }))
      }
    )
  }, [form.busy, form.range, form.passphrase, selected, onDone])

  // A busy form takes no edits (§9.30): the values stay as they are until the clear is done.
  const edit = (change: (f: ClearFormState) => ClearFormState): void => {
    if (!form.busy) setForm(change)
  }
  return {
    form,
    types,
    selected,
    unavailableFor: (type) => form.counts?.find((c) => c.type === type)?.unavailable ?? null,
    setRange: (range) => edit((f) => ({ ...f, range, counts: null })),
    setMode: (mode) => edit((f) => ({ ...f, mode })),
    toggle: (type, on) =>
      edit((f) => {
        const checked = new Set(f.checked)
        if (on) checked.add(type)
        else checked.delete(type)
        return { ...f, checked, error: type === 'passwords' && !on ? null : f.error }
      }),
    setPassphrase: (value) => edit((f) => ({ ...f, passphrase: value, error: null })),
    submit
  }
}

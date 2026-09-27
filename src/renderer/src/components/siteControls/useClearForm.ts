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
 * The state of the Delete browsing data form, shared by the desktop dialog
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

/**
 * What differs between the two surfaces the form serves: the desktop dialog (the defaults) and
 * the phone's form, which is Chrome Android's Quick Delete (`QUICK_DELETE_FORM`).
 */
export interface ClearFormOptions {
  /** The range the form opens on: the last hour (Chrome's desktop dialog), or Quick Delete's 15 minutes. */
  initialRange?: BrowsingDataRange
  /** The types a mode lists, in order. */
  types?: (mode: ClearMode) => readonly BrowsingDataType[]
  /** The types checked when the form opens. */
  initialChecked?: readonly BrowsingDataType[]
}

function modeTypes(mode: ClearMode): readonly BrowsingDataType[] {
  return mode === 'basic' ? BROWSING_DATA_BASIC : BROWSING_DATA_ADVANCED
}

/**
 * The phone's list: the mode's set with the Tabs row after Cached images and files, the seat
 * Chrome's Delete browsing data page gives its Tabs checkbox (`clear_browsing_data_preferences.xml`:
 * history :20, cookies :26, cache :32, tabs :37, then passwords, form data, site settings;
 * `ClearBrowsingDataFragment.java:472–475` adds `DialogOption.CLEAR_TABS` to the page's options),
 * in Basic and Advanced alike (ADDENDUM D). The row is a switch of the form, so it goes after the
 * three the form ticks by default, as Chrome's page has it.
 */
export function quickDeleteTypes(mode: ClearMode): BrowsingDataType[] {
  const base = modeTypes(mode)
  const at = base.indexOf('cache') + 1
  return [...base.slice(0, at), 'tabs', ...base.slice(at)]
}

/**
 * The phone form as Chrome Android's Quick Delete (HB-07): it opens on the last 15 minutes
 * (Quick Delete's default period) and lists the Tabs row OFF – Chrome's `kCloseTabs` pref, the
 * page's Tabs checkbox, starts false on Android (`pref_names.cc:66–68`;
 * `browser.clear_data.close_tabs`, `pref_names.h:51`); the Quick Delete dialog itself, which
 * always closes the period's tabs, has no switch, and the form is the page's shape. The toast
 * once it is done is W8-7's `clearedToast(range, cleared)`, the period's words on every host.
 */
export const QUICK_DELETE_FORM: ClearFormOptions = {
  initialRange: '15min',
  types: quickDeleteTypes,
  initialChecked: INITIAL_CHECKED
}

export function useClearForm(onDone: () => void, options: ClearFormOptions = {}): ClearForm {
  const listTypes = options.types ?? modeTypes
  const [form, setForm] = useState<ClearFormState>({
    range: options.initialRange ?? 'hour',
    mode: 'basic',
    checked: new Set(options.initialChecked ?? INITIAL_CHECKED),
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

  const types = listTypes(form.mode)
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
            // The toast names the period the form cleared, in the picker's words.
            pushToast(clearedToast(args.range, outcome.value.cleared))
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
              error: outcome.reason ?? 'Authentication did not pass; nothing was deleted'
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

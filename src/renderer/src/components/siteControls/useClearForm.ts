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
import { DEFAULT_CLEAR_BROWSING_DATA_RANGE } from '@shared/privacy'
import { cmd, run } from '@renderer/lib/api'
import { browserStore } from '@renderer/lib/browserStore'
import { clearedToast } from '@renderer/lib/browsingData'
import { pushToast } from '@renderer/lib/ui'

/**
 * The state of the Delete browsing data form, shared by the desktop dialog
 * (`ClearBrowsingDataDialog`) and the phone form sheet the Settings builder opens
 * (`ClearBrowsingDataForm`): the range, Basic or Advanced, the types checked, the counts for the
 * range (`privacy.clearBrowsingDataCounts`, read again for every range), and the submission
 * through `privacy.clearBrowsingData` with its re-authentication round – the vault wants its
 * passphrase before saved passwords go. The desktop dialog's range is remembered as Chrome's
 * is (seed #20, `rememberedRange`): the form opens on the range the user last deleted with and
 * a Delete writes its range to `Settings.clearBrowsingDataRange`, one key over Basic and
 * Advanced (they share the range row); Quick Delete's form opens on its fixed 15 minutes and
 * writes nothing. §9.30 while it clears: the form is busy, not disabled –
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
  /**
   * A fixed range the form opens on every time – Quick Delete's 15 minutes – remembering
   * nothing. Absent, the form is Chrome's desktop dialog's: it opens on the range the user last
   * deleted with (`rememberedRange`, the last hour until then) and a Delete writes its range.
   */
  initialRange?: BrowsingDataRange
  /** The types a mode lists, in order. */
  types?: (mode: ClearMode) => readonly BrowsingDataType[]
  /** The types checked when the form opens. */
  initialChecked?: readonly BrowsingDataType[]
  /**
   * How a submit clears: `privacy.clearBrowsingData` with the form's arguments by default. The
   * phone's Quick Delete runs its tab motion around the command (`quickDeleteClear`, MOT-24)
   * and may take the form down before it is through – `dismiss` is the form's `onDone`, which
   * runs once however many times it is called – with the outcome the form then reports as it
   * reports the command's own: the toast on `ok`, the passphrase field or the error else.
   */
  clear?: (args: ClearArgs, dismiss: () => void) => Promise<ClearOutcome>
}

/** What a submit sends. */
export interface ClearArgs {
  range: BrowsingDataRange
  types: BrowsingDataType[]
  passphrase?: string
}

export type ClearOutcome = ReauthOutcome<ClearBrowsingDataResult>

const clearWithCommand = (args: ClearArgs): Promise<ClearOutcome> =>
  cmd('privacy.clearBrowsingData', args)

/** `fn`, run on the first call alone. */
function once(fn: () => void): () => void {
  let ran = false
  return () => {
    if (ran) return
    ran = true
    fn()
  }
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
 * The 15 minutes are fixed: the phone's form neither reads nor writes the desktop dialog's
 * remembered range (the lead's ruling on #624; `Settings.clearBrowsingDataRange` is the
 * desktop's, and device-local besides).
 */
export const QUICK_DELETE_FORM: ClearFormOptions = {
  initialRange: '15min',
  types: quickDeleteTypes,
  initialChecked: INITIAL_CHECKED
}

/**
 * The range the desktop dialog opens on (seed #20): the one the user last deleted with on this
 * device, `Settings.clearBrowsingDataRange` – Chrome's `browser.clear_data.time_period`, which
 * its dialog's time picker mirrors into the selection (`clear_browsing_data_time_picker.ts`,
 * `mirrorPrefs` → `onTimePeriodPrefUpdated_`) – or the last hour before any deletion, Chrome's
 * default on the desktop (`pref_names.cc:23–25`). Read once, as the form mounts: a change of the
 * setting while the dialog is open does not move the range under the user.
 */
function rememberedRange(): BrowsingDataRange {
  return (
    browserStore.get().state?.settings.clearBrowsingDataRange ?? DEFAULT_CLEAR_BROWSING_DATA_RANGE
  )
}

export function useClearForm(onDone: () => void, options: ClearFormOptions = {}): ClearForm {
  const listTypes = options.types ?? modeTypes
  // A fixed opening range (Quick Delete's) is never remembered; without one the form opens on
  // the remembered range and its Delete writes the range it went with.
  const remembers = options.initialRange === undefined
  const [form, setForm] = useState<ClearFormState>(() => ({
    range: options.initialRange ?? rememberedRange(),
    mode: 'basic',
    checked: new Set(options.initialChecked ?? INITIAL_CHECKED),
    counts: null,
    busy: false,
    passphrase: null,
    error: null,
    refusals: 0
  }))
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

  const clear = options.clear ?? clearWithCommand
  const submit = useCallback((): void => {
    if (form.busy || selected.length === 0) return
    setForm((f) => ({ ...f, busy: true, error: null }))
    const args: ClearArgs = {
      range: form.range,
      types: selected,
      ...(form.passphrase !== null ? { passphrase: form.passphrase } : {})
    }
    // Chrome's dialog commits the period as Delete is pressed, before the clear and whatever it
    // then says (`clear_browsing_data_dialog.ts` `onDeleteBrowsingDataClick_`:
    // `timePicker.sendPrefChange()`, then `clearBrowsingData`); a pick alone is not remembered,
    // so a look at another range's counts and a Cancel leave the dialog opening as before. A
    // range already remembered is not written again (Chrome's `PrefService` drops an equal value).
    if (remembers && args.range !== rememberedRange())
      run('settings.update', { clearBrowsingDataRange: args.range })
    // The form closes once, whether the clear took it down on its way or `ok` does now.
    const done = once(onDone)
    clear(args, done).then(
      (outcome: ClearOutcome) => {
        switch (outcome.status) {
          case 'ok':
            // The toast names the period the form cleared, in the picker's words.
            pushToast(clearedToast(args.range, outcome.value.cleared))
            done()
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
  }, [form.busy, form.range, form.passphrase, selected, remembers, onDone, clear])

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

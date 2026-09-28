import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BrowsingDataRange, BrowsingDataType } from '@shared/types'
import { RANGE_OPTIONS, TYPE_LABEL, countLine } from '@renderer/lib/browsingData'
import { isTouchLayout, useViewport } from '@renderer/lib/formFactor'
import { Field, RadioOption, ValidationMessage } from '../pages/settings/blocks'
import { choice, type SettingsRow, type ValueRow } from '../pages/settings/model'
import { RowView, type RowContext } from '../pages/settings/rows'
import { useSheetRelayout } from '../pages/settings/sheetContext'
import { OptionsSheet } from '../pages/settings/sheets'
import { usePhone } from '@renderer/lib/surfaces'
import { quickDeleteClear } from '../phone/quickDelete'
import { BusyButton } from './primitives'
import { QUICK_DELETE_FORM, useClearForm, type ClearFormOptions } from './useClearForm'

/**
 * The phone's form clears through Quick Delete's runner (MOT-24): with the Tabs row on, the
 * overview opens and the period's cards depart before the core closes them; without it the
 * runner is the plain command.
 */
const QUICK_DELETE_PHONE_FORM: ClearFormOptions = { ...QUICK_DELETE_FORM, clear: quickDeleteClear }

/**
 * Delete browsing data under a finger (design-language-v2-draft §9.12–§9.14, §9.23, §9.25,
 * §9.30, §10.4; Chrome's words since M124, `IDS_CLEAR_DATA_DELETE` "Delete data" on Android):
 * the form sheet the Privacy and security row opens through the Settings builder
 * (`settingsRows.tsx`, `clear-data-open`), drawn with the builder's own rows so it is the
 * page's list continued – the time range as a value row whose picker is the §9.13 sheet over
 * this one (48 header, the range's label centred), Basic or Advanced as two radio rows, a
 * switch row per type with how much the range holds under its label (a type the range cannot
 * delete now is laid out at 40 % and takes no press), the vault passphrase as a §9.12 field
 * when the outcome asks for it, and the two footer actions splitting the width. The state is
 * the dialog's (`useClearForm`), §9.30 included: while it deletes every row keeps its value at
 * full opacity and takes no press, the passphrase stays masked in place, only Delete data is
 * busy and Cancel sits at .4; a refused passphrase clears the field, which takes the focus back
 * under its validation text; on success the sheet closes with its values shown until it is gone.
 *
 * On the desktop layout the form is the Settings dialog's (`FormDialog`), and the range is the
 * builder's §10.5 value row there – the text, then the 32 px menulist the desktop dialog and the
 * settings page trail (`MenulistRow`, `V2Menulist`), whose popup is the shared §9.13 popover
 * under the control with §9.20's keyboard (the current option focused, arrows, Enter or Space
 * pick, Escape back to the control) rather than a sheet in a dialog (W8-12, the lead's item);
 * the same `RANGE_OPTIONS` words, and while the form is busy the control opens nothing
 * (`readOnly`, §9.30) as the dialog's does. The layouts a finger drives (`isTouchLayout`: the
 * phone's, the tablet's) keep the §10.4 value row and its sheet, unchanged.
 *
 * On the PHONE the form is Chrome Android's Quick Delete (HB-07, `QUICK_DELETE_FORM`): it opens
 * on the last 15 minutes and carries the Tabs row after Cached images and files – the seat
 * Chrome's Delete browsing data page gives it (`clear_browsing_data_preferences.xml:32–39`) – OFF
 * until the user turns it on (Chrome's `kCloseTabs` pref starts false on Android,
 * `pref_names.cc:66–68`); on, the tabs whose last navigation falls in the range close with the
 * data, no undo, no Recently-closed entry. "Phone" is the layout, not the host: `usePhone()` is
 * `classifyViewport` (`PHONE_MAX_WIDTH = 600`), so a desktop window narrower than 600 px gets
 * this form too and an Android tablet's wide layout gets the dialog's rows without the Tabs row.
 * The toast once it is done is W8-7's `clearedToast(range, cleared)` on both – "Last 15 minutes
 * deleted". With the Tabs row on, the phone's clear is Chrome's Quick Delete sequence around the
 * command (`quickDeleteClear`, MOT-24): the data first, then this sheet goes, the overview opens
 * and the period's cards depart in place before the core closes their tabs; the toast follows.
 */
export function ClearBrowsingDataForm({ close }: { close: () => void }): JSX.Element {
  const phone = usePhone()
  const state = useClearForm(close, phone ? QUICK_DELETE_PHONE_FORM : undefined)
  const { form, types, selected, unavailableFor, setRange, setMode, toggle, setPassphrase } = state
  const busy = form.busy
  const [picker, setPicker] = useState(false)
  const desktop = !isTouchLayout(useViewport().formFactor)
  const fieldId = 'clear-data-passphrase'
  const passphraseShown = form.passphrase !== null && form.checked.has('passwords')

  // The sheet took its detents from the Basic list: Advanced's rows, the passphrase field and a
  // validation line change the body's height, so it is measured again (not on the first render,
  // which the chassis measures itself).
  const relayout = useSheetRelayout()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    relayout()
  }, [form.mode, passphraseShown, form.error, relayout])

  // A refused passphrase left the field empty: it takes the focus back (§9.30).
  useEffect(() => {
    if (form.refusals > 0) document.getElementById(fieldId)?.focus()
  }, [form.refusals])

  const range: ValueRow = choice<BrowsingDataRange>({
    id: 'clear-data-range',
    label: 'Time range',
    value: form.range,
    options: RANGE_OPTIONS,
    onChange: setRange,
    readOnly: busy
  })
  // The range row's press opens the picker over this sheet (the phone's row; the desktop's
  // menulist opens its own popover); nothing else here opens a sheet.
  const ctx: RowContext = {
    open: (request) => {
      if (request.kind === 'options' && !busy) setPicker(true)
    }
  }
  const typeRows: SettingsRow[] = types.map((type: BrowsingDataType) => {
    const unavailable = unavailableFor(type)
    return {
      kind: 'switch',
      id: `clear-data-type:${type}`,
      label: TYPE_LABEL[type],
      description: countLine(type, form.counts, form.range),
      checked: form.checked.has(type) && unavailable === null,
      disabled: unavailable !== null,
      onChange: (on) => toggle(type, on)
    }
  })

  return (
    <>
      <div
        className="zen-settings-sheet-rows"
        aria-busy={busy || undefined}
        data-busy={busy ? '' : undefined}
        data-testid="clear-browsing-data-form"
      >
        <RowView row={range} ctx={ctx} variant={desktop ? 'desktop' : 'phone'} />
        <div
          role="radiogroup"
          aria-label="What to show"
          aria-readonly={busy || undefined}
          className="zen-settings-sheet-rows"
        >
          <RadioOption
            label="Basic"
            checked={form.mode === 'basic'}
            onSelect={() => setMode('basic')}
          />
          <RadioOption
            label="Advanced"
            checked={form.mode === 'advanced'}
            onSelect={() => setMode('advanced')}
          />
        </div>
        <div className="zen-settings-sheet-rows" data-testid="clear-data-types">
          {typeRows.map((row) => (
            <div key={row.id} data-browsing-data={row.id.slice('clear-data-type:'.length)}>
              <RowView row={row} ctx={ctx} />
            </div>
          ))}
        </div>
        <div className="zen-settings-form mt-2">
          {passphraseShown && (
            <Field
              id={fieldId}
              label="Vault passphrase"
              description={
                form.error
                  ? undefined
                  : 'Saved passwords are protected; the vault opens with your passphrase.'
              }
            >
              <input
                id={fieldId}
                className="zen-settings-input zen-v2-field"
                type="password"
                autoFocus
                autoComplete="current-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                readOnly={busy}
                value={form.passphrase ?? ''}
                aria-invalid={form.error ? true : undefined}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') state.submit()
                }}
              />
              {form.error && <ValidationMessage message={form.error} />}
            </Field>
          )}
          {form.error && !passphraseShown && <ValidationMessage message={form.error} />}
          <div className="zen-settings-sheet-actions">
            <button type="button" className="zen-v2-button" disabled={busy} onClick={() => close()}>
              Cancel
            </button>
            <BusyButton
              variant="primary"
              busy={busy}
              disabled={selected.length === 0}
              onClick={state.submit}
              data-testid="clear-data-submit"
            >
              Delete data
            </BusyButton>
          </div>
        </div>
      </div>
      {picker && <OptionsSheet row={range} under={false} close={() => setPicker(false)} />}
    </>
  )
}

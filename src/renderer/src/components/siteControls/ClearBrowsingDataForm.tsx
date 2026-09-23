import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BrowsingDataRange, BrowsingDataType } from '@shared/types'
import { RANGE_OPTIONS, TYPE_LABEL, countLine } from '@renderer/lib/browsingData'
import { Field, RadioOption, ValidationMessage } from '../pages/settings/blocks'
import { choice, type SettingsRow, type ValueRow } from '../pages/settings/model'
import { RowView, type RowContext } from '../pages/settings/rows'
import { useSheetRelayout } from '../pages/settings/sheetContext'
import { OptionsSheet } from '../pages/settings/sheets'
import { BusyButton } from './primitives'
import { useClearForm } from './useClearForm'

/**
 * Clear browsing data under a finger (design-language-v2-draft §9.12–§9.14, §9.23, §9.25,
 * §9.30, §10.4): the form sheet the Privacy and security row opens through the Settings
 * builder (`settingsRows.tsx`, `clear-data-open`), drawn with the builder's own rows so it is
 * the page's list continued – the time range as a value row whose picker is the §9.13 sheet
 * over this one (48 header, the range's label centred), Basic or Advanced as two radio rows,
 * a switch row per type with how much the range holds under its label (a type the range cannot
 * clear now is laid out at 40 % and takes no press), the vault passphrase as a §9.12 field when
 * the outcome asks for it, and the two footer actions splitting the width. The state is the
 * dialog's (`useClearForm`), §9.30 included: while it clears every row keeps its value at full
 * opacity and takes no press, the passphrase stays masked in place, only Clear data is busy and
 * Cancel sits at .4; a refused passphrase clears the field, which takes the focus back under its
 * validation text; on success the sheet closes with its values shown until it is gone.
 */
export function ClearBrowsingDataForm({ close }: { close: () => void }): JSX.Element {
  const state = useClearForm(close)
  const { form, types, selected, unavailableFor, setRange, setMode, toggle, setPassphrase } = state
  const busy = form.busy
  const [picker, setPicker] = useState(false)
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
    onChange: setRange
  })
  // The range row's press opens the picker over this sheet; nothing else here opens a sheet.
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
        <RowView row={range} ctx={ctx} />
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
              Clear data
            </BusyButton>
          </div>
        </div>
      </div>
      {picker && <OptionsSheet row={range} under={false} close={() => setPicker(false)} />}
    </>
  )
}

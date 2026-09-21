import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { BrowsingDataRange } from '@shared/types'
import { RANGE_OPTIONS, TYPE_LABEL, countLine } from '@renderer/lib/browsingData'
import { closeClearBrowsingData, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'
import {
  BusyButton,
  Checkbox,
  ChoiceRow,
  DesktopDialog,
  Field,
  Footer,
  Radio,
  TitleBlock,
  type DialogApi
} from './primitives'
import { useClearForm, type ClearForm } from './useClearForm'

/**
 * Clear browsing data on a mouse (design-language-v2-draft §9.5, §9.11–§9.14, §9.20, §9.23,
 * §9.30): a `--v2-dialog` through the frame dialog host at the 400 form width, the type list
 * being one column. A title block, the time range as a menulist, Basic or Advanced as plain
 * radios, then a checkbox per type with a line under it saying how much the range holds
 * (`privacy.clearBrowsingDataCounts`, read again for every range), and the dialog form of
 * footer: Cancel and the primary Clear data 16 under the last row, no hairline. Passwords need
 * re-authentication: the outcome of `privacy.clearBrowsingData` says whether to ask for the
 * vault passphrase (a field appears under the list), to set one first, or that the OS refused;
 * nothing is cleared until it passes. While it clears the form is busy (§9.30): every field
 * keeps its value at full opacity and takes no edit, the range and the boxes read-only, the
 * passphrase masked in place; only Clear data is busy and Cancel sits at .4. A refused
 * passphrase clears the field, which takes the focus back under its validation text; on success
 * the dialog closes with its values still shown until it is gone. Mounted by `TabDialogs`
 * while `clearBrowsingDataOpen` is set. The phone's form of the same surface is a sheet of the
 * Settings builder (`ClearBrowsingDataForm`), opened by the Privacy and security row.
 */
export function ClearBrowsingDataDialog(): JSX.Element | null {
  const open = uiStore.use((s) => s.clearBrowsingDataOpen)
  if (!open) return null
  return <ClearDialog />
}

function ClearDialog(): JSX.Element {
  const titleId = useId()
  const api = useRef<DialogApi | null>(null)
  // Cancel and a finished clear close through the dialog, which hands focus back to the anchor
  // (§9.22); Escape does the same inside it, and the scrim press comes straight to the store.
  const close = useCallback((): void => {
    if (api.current) api.current.close()
    else closeClearBrowsingData()
  }, [])
  const state = useClearForm(close)
  const [scrolled, setScrolled] = useState(false)
  return (
    <DesktopDialog
      labelledBy={titleId}
      onCancel={closeClearBrowsingData}
      api={api}
      data-testid="clear-browsing-data"
      data-busy={state.form.busy ? '' : undefined}
    >
      <TitleBlock
        id={titleId}
        title="Clear browsing data"
        description="Removes what Zenium kept from the time range you choose, in every container."
        scrolled={scrolled}
      />
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <ClearBody {...state} />
      </div>
      <Footer count={2} hairline={false}>
        <V2Button onClick={close} disabled={state.form.busy}>
          Cancel
        </V2Button>
        <BusyButton
          variant="primary"
          busy={state.form.busy}
          disabled={state.selected.length === 0}
          onClick={state.submit}
          data-testid="clear-data-submit"
        >
          Clear data
        </BusyButton>
      </Footer>
    </DesktopDialog>
  )
}

/** The dialog's body: the range row, the two radios, the type list and the passphrase. */
function ClearBody({
  form,
  types,
  unavailableFor,
  setRange,
  setMode,
  toggle,
  setPassphrase,
  submit
}: ClearForm): JSX.Element {
  const fieldId = useId()
  // A refused passphrase left the field empty: it takes the focus back (§9.30).
  useEffect(() => {
    if (form.refusals > 0) document.getElementById(fieldId)?.focus()
  }, [form.refusals, fieldId])
  const busy = form.busy
  return (
    <>
      <ChoiceRow<BrowsingDataRange>
        label="Time range"
        value={form.range}
        options={RANGE_OPTIONS}
        onChange={setRange}
        readOnly={busy}
      />
      <div
        role="radiogroup"
        aria-label="What to show"
        aria-readonly={busy || undefined}
        className="flex flex-col px-4"
      >
        <Radio label="Basic" checked={form.mode === 'basic'} onSelect={() => setMode('basic')} />
        <Radio
          label="Advanced"
          checked={form.mode === 'advanced'}
          onSelect={() => setMode('advanced')}
        />
      </div>
      <div className="flex flex-col" data-testid="clear-data-types">
        {types.map((type) => {
          const unavailable = unavailableFor(type)
          return (
            // A type the range cannot clear is one disabled row: the check row puts the .4 on
            // its content, text and box together (§9.30, `.zen-v2-check-row` in main.css).
            <Checkbox
              key={type}
              className="min-h-[var(--v2-row-two-line)] px-4 py-[calc((var(--v2-row-two-line)-40px)/2)]"
              checked={form.checked.has(type) && !unavailable}
              disabled={unavailable !== null}
              aria-readonly={busy || undefined}
              onChange={(e) => toggle(type, e.currentTarget.checked)}
              data-browsing-data={type}
              data-disabled={unavailable ? '' : undefined}
              label={
                <>
                  <span className="block">{TYPE_LABEL[type]}</span>
                  <span className="block text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)] [font-variant-numeric:tabular-nums]">
                    {countLine(type, form.counts, form.range)}
                  </span>
                </>
              }
            />
          )
        })}
      </div>
      {form.passphrase !== null && form.checked.has('passwords') && (
        <div className="flex flex-col px-4 pt-2">
          <label htmlFor={fieldId} className="text-[15px] leading-5">
            Vault passphrase
          </label>
          <Field
            id={fieldId}
            className="mt-1"
            type="password"
            secret
            autoFocus
            autoComplete="current-password"
            readOnly={busy}
            value={form.passphrase}
            onChange={(e) => setPassphrase(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            aria-invalid={form.error ? true : undefined}
            aria-describedby={form.error ? `${fieldId}-error` : `${fieldId}-hint`}
          />
          {!form.error && (
            <p
              id={`${fieldId}-hint`}
              className="mt-1 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]"
            >
              Saved passwords are protected; the vault opens with your passphrase.
            </p>
          )}
        </div>
      )}
      {form.error && (
        <p
          id={`${fieldId}-error`}
          role="alert"
          className="flex items-start gap-2 px-4 pt-1 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-danger)]"
        >
          <CircleAlert className={cn(V2_GLYPH, 'mt-0.5')} aria-hidden />
          <span>{form.error}</span>
        </p>
      )}
    </>
  )
}

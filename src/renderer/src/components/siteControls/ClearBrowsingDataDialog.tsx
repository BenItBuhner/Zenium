import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import {
  BROWSING_DATA_ADVANCED,
  BROWSING_DATA_BASIC,
  type BrowsingDataCount,
  type BrowsingDataRange,
  type BrowsingDataType,
  type ReauthOutcome,
  type ClearBrowsingDataResult
} from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { RANGE_OPTIONS, TYPE_LABEL, clearedToast, countLine } from '@renderer/lib/browsingData'
import { usePhone } from '@renderer/lib/surfaces'
import { closeClearBrowsingData, pushToast, uiStore } from '@renderer/lib/ui'
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
  V2Sheet,
  type DialogApi,
  type SheetApi
} from './primitives'

type Mode = 'basic' | 'advanced'

/**
 * Clear browsing data (design-language-v2-draft §9.5, §9.11–§9.14, §9.20, §9.23): a
 * `--v2-dialog` through the frame dialog host on a mouse – at the 400 form width, the type list
 * being one column – a sheet on a phone; one composition. A title block, the time range as a
 * menulist (a value row and picker on phones), Basic or Advanced as plain radios, then a
 * checkbox per type with a line under it saying how much the range holds
 * (`privacy.clearBrowsingDataCounts`, read again for every range), and the dialog form of
 * footer: Cancel and the primary Clear data 16 under the last row, no hairline. Passwords need
 * re-authentication: the outcome of `privacy.clearBrowsingData` says
 * whether to ask for the vault passphrase (a field appears under the list), to set one first,
 * or that the OS refused; nothing is cleared until it passes. Mounted by `TabDialogs` while
 * `clearBrowsingDataOpen` is set.
 */
export function ClearBrowsingDataDialog(): JSX.Element | null {
  const open = uiStore.use((s) => s.clearBrowsingDataOpen)
  const phone = usePhone()
  if (!open) return null
  return phone ? <ClearSheet /> : <ClearDialog />
}

interface Form {
  range: BrowsingDataRange
  mode: Mode
  checked: Set<BrowsingDataType>
  counts: BrowsingDataCount[] | null
  busy: boolean
  /** The vault wants its passphrase before passwords go. */
  passphrase: string | null
  /** Why the last attempt stopped, under the passphrase field or the list. */
  error: string | null
}

const INITIAL_CHECKED: BrowsingDataType[] = ['history', 'cookies', 'cache']

function useClearForm(onDone: () => void): {
  form: Form
  setRange: (range: BrowsingDataRange) => void
  setMode: (mode: Mode) => void
  toggle: (type: BrowsingDataType, on: boolean) => void
  setPassphrase: (value: string) => void
  submit: () => void
  types: readonly BrowsingDataType[]
  selected: BrowsingDataType[]
} {
  const [form, setForm] = useState<Form>({
    range: 'hour',
    mode: 'basic',
    checked: new Set(INITIAL_CHECKED),
    counts: null,
    busy: false,
    passphrase: null,
    error: null
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
            setForm((f) => ({
              ...f,
              busy: false,
              passphrase: f.passphrase ?? '',
              error: f.passphrase ? 'That passphrase is not right' : null
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

  return {
    form,
    types,
    selected,
    setRange: (range) => setForm((f) => ({ ...f, range, counts: null })),
    setMode: (mode) => setForm((f) => ({ ...f, mode })),
    toggle: (type, on) =>
      setForm((f) => {
        const checked = new Set(f.checked)
        if (on) checked.add(type)
        else checked.delete(type)
        return { ...f, checked, error: type === 'passwords' && !on ? null : f.error }
      }),
    setPassphrase: (value) => setForm((f) => ({ ...f, passphrase: value, error: null })),
    submit
  }
}

// ---------------------------------------------------------------------------
// The body both surfaces share
// ---------------------------------------------------------------------------

function ClearBody({
  form,
  types,
  setRange,
  setMode,
  toggle,
  setPassphrase,
  submit
}: ReturnType<typeof useClearForm>): JSX.Element {
  const phone = usePhone()
  const modeId = useId()
  const fieldId = useId()
  const unavailableFor = (type: BrowsingDataType): string | null =>
    form.counts?.find((c) => c.type === type)?.unavailable ?? null
  // Plain radios (§9.14): a vertical list at 32 pitch on desktop and 40 on phones, which is the
  // control's height, not the 44 row the picker sheets draw – so the phone pitch is set here.
  const pitch = phone ? 'py-2.5' : undefined
  return (
    <>
      <ChoiceRow<BrowsingDataRange>
        label="Time range"
        value={form.range}
        options={RANGE_OPTIONS}
        onChange={setRange}
        sheetName="clear-data-range"
      />
      <div role="radiogroup" aria-label="What to show" className="flex flex-col px-4">
        <Radio
          name={modeId}
          label="Basic"
          className={pitch}
          checked={form.mode === 'basic'}
          onChange={() => setMode('basic')}
        />
        <Radio
          name={modeId}
          label="Advanced"
          className={pitch}
          checked={form.mode === 'advanced'}
          onChange={() => setMode('advanced')}
        />
      </div>
      <div className="flex flex-col" data-testid="clear-data-types">
        {types.map((type) => {
          const unavailable = unavailableFor(type)
          return (
            // A type the range cannot clear is one disabled row: the .4 sits on the row, for its
            // text and box together, and the box adds none (§9.30; `data-disabled` in main.css).
            <div
              key={type}
              className={cn(
                'flex min-h-[var(--v2-row-two-line)] items-start px-4 py-[calc((var(--v2-row-two-line)-40px)/2)]',
                unavailable && 'opacity-40'
              )}
              data-browsing-data={type}
              data-disabled={unavailable ? '' : undefined}
            >
              <Checkbox
                className="flex-1"
                checked={form.checked.has(type) && !unavailable}
                disabled={unavailable !== null}
                onChange={(e) => toggle(type, e.currentTarget.checked)}
                label={
                  <>
                    <span className="block">{TYPE_LABEL[type]}</span>
                    <span className="block text-[13px] leading-5 text-[var(--v2-text-deemphasized)] [font-variant-numeric:tabular-nums]">
                      {countLine(type, form.counts, form.range)}
                    </span>
                  </>
                }
              />
            </div>
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
              className="mt-1 text-[13px] leading-5 text-[var(--v2-text-deemphasized)]"
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
          className="flex items-start gap-2 px-4 pt-1 text-[13px] leading-5 text-[var(--v2-danger)]"
        >
          <CircleAlert className={cn(V2_GLYPH, 'mt-0.5')} aria-hidden />
          <span>{form.error}</span>
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Desktop dialog and phone sheet
// ---------------------------------------------------------------------------

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

function ClearSheet(): JSX.Element {
  const api = useRef<SheetApi | null>(null)
  const done = useRef(false)
  const finish = useCallback((): void => {
    done.current = true
    api.current?.dismiss()
  }, [])
  const state = useClearForm(finish)
  const { form } = state
  // Advanced reveals a list taller than the peek: the sheet expands to show what was asked for
  // (after the re-measure below, effects running after layout effects).
  useEffect(() => {
    if (form.mode === 'advanced') api.current?.expand()
  }, [form.mode])
  // The body changes height when the list switches Basic / Advanced, when the passphrase field
  // or an error line appears, and when the counts arrive; the sheet's detents follow.
  const contentKey = [
    form.mode,
    form.passphrase !== null && form.checked.has('passwords') ? 'passphrase' : '',
    form.error ? 'error' : '',
    form.counts === null ? 'counting' : 'counted'
  ].join(':')
  return (
    <V2Sheet
      name="clear-browsing-data"
      api={api}
      title="Clear browsing data"
      handleLabel="Resize Clear browsing data"
      onDismissed={() => closeClearBrowsingData()}
      contentKey={contentKey}
      data-testid="clear-browsing-data"
    >
      <div className="flex flex-col pt-1">
        <ClearBody {...state} />
        <Footer count={2}>
          <V2Button onClick={() => api.current?.dismiss()} disabled={state.form.busy}>
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
      </div>
    </V2Sheet>
  )
}

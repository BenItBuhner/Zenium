import type { JSX } from 'react'
import { useState } from 'react'
import { normalizeSiteException } from '@shared/blocking'
import { Field, SheetActions, ValidationMessage } from './blocks'

/**
 * The forms the request engine's phone rows (`tracking.tsx`) raise in §9.12 form sheets: add a
 * list by its URL, add a site without blocking, edit your filters. Components only, so the
 * builder module beside them stays a plain function file (react-refresh).
 */

/** Your lists › Add a list: one URL field (§9.12), validated as typed, the sheet held on refusal. */
export function AddListForm({
  taken,
  onAdd,
  close
}: {
  taken: readonly string[]
  onAdd: (url: string) => void
  close: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  const valid = /^https?:\/\/\S+$/i.test(trimmed)
  const message =
    trimmed && !valid
      ? 'Enter the address of a filter list, starting with https://'
      : taken.includes(trimmed)
        ? 'That list is already here'
        : null
  const submit = (): void => {
    if (!trimmed || message) return
    onAdd(trimmed)
    close()
  }
  return (
    <div className="zen-settings-form">
      <Field id="tracking-add-list-url" label="List URL">
        <input
          id="tracking-add-list-url"
          className="zen-settings-input zen-v2-field"
          placeholder="https://example.com/filters.txt"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={message ? true : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {message && <ValidationMessage message={message} />}
      </Field>
      <SheetActions
        action="Add list"
        disabled={!trimmed || message !== null}
        onCancel={close}
        onAction={submit}
      />
    </div>
  )
}

/** Sites without blocking › Add a site: a host, read as the exception store keeps it. */
export function AddSiteForm({
  onAdd,
  close
}: {
  onAdd: (site: string) => void
  close: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const site = normalizeSiteException(value)
  const message = value.trim() && !site ? 'Enter a site, like example.com' : null
  const submit = (): void => {
    if (!site) return
    onAdd(site)
    close()
  }
  return (
    <div className="zen-settings-form">
      <Field id="tracking-add-site-host" label="Site">
        <input
          id="tracking-add-site-host"
          className="zen-settings-input zen-v2-field"
          placeholder="example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={message ? true : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {message && <ValidationMessage message={message} />}
      </Field>
      <SheetActions action="Add site" disabled={!site} onCancel={close} onAction={submit} />
    </div>
  )
}

/**
 * Your filters › Edit: the uBlock-syntax editor in the body face (§4 keeps monospace for
 * secrets), saved by the sheet's primary button. The engine's parse errors for the stored text
 * stand under the field as §9.12 validation lines until the text is edited.
 */
export function FiltersForm({
  value,
  errors,
  onSave,
  close
}: {
  value: string
  errors: ReadonlyArray<{ line: number; message: string }>
  onSave: (text: string) => void
  close: () => void
}): JSX.Element {
  const [text, setText] = useState(value)
  const shown = text === value ? errors : []
  return (
    <div className="zen-settings-form">
      <Field id="tracking-user-filters-text" label="Filters">
        <textarea
          id="tracking-user-filters-text"
          className="zen-settings-input zen-v2-field zen-privacy-editor"
          aria-invalid={shown.length > 0 ? true : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={'||ads.example.com^\n@@||news.example.com^$document'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {shown.slice(0, 8).map((e) => (
          <ValidationMessage
            key={`${e.line}:${e.message}`}
            message={`Line ${e.line}: ${e.message}`}
          />
        ))}
        {shown.length > 8 && <ValidationMessage message={`${shown.length - 8} more…`} />}
      </Field>
      <SheetActions
        action="Save"
        disabled={text === value}
        onCancel={close}
        onAction={() => {
          onSave(text)
          close()
        }}
      />
    </div>
  )
}

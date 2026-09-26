import { useState, type JSX, type KeyboardEvent } from 'react'
import { startupPageUrl } from '@core/startup'
import { Field, SheetActions, ValidationMessage } from './blocks'

/**
 * The one-field form Add a new page and Edit share (§9.12): the address, checked once the field
 * is left or the form submitted – a web address alone, as Chrome's dialog takes, and not one the
 * list already has. `index` is the page being edited, whose own address is no duplicate.
 */
export function StartupPageForm({
  initial,
  action,
  pages,
  index,
  onSubmit,
  close
}: {
  initial?: string
  /** The primary button's verb: "Add" for a new page, "Save" for an edit. */
  action: string
  pages: readonly string[]
  index?: number
  onSubmit: (url: string) => void
  close: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial ?? '')
  const [touched, setTouched] = useState(false)
  const url = startupPageUrl(value)
  const problem = !url
    ? 'Enter a web address, like example.com'
    : pages.some((page, i) => page === url && i !== index)
      ? 'This page is already in the list'
      : null
  const shown = touched && value.trim() ? problem : null
  const submit = (): void => {
    if (problem || !url) {
      setTouched(true)
      return
    }
    onSubmit(url)
    close()
  }
  const onEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
  }
  return (
    <div className="zen-settings-form" data-testid="startup-page-form">
      <Field id="startup-page-url" label="Site URL">
        <input
          id="startup-page-url"
          className="zen-settings-input zen-v2-field"
          placeholder="example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? 'startup-page-url-error' : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={onEnter}
        />
        {shown && <ValidationMessage id="startup-page-url-error" message={shown} />}
      </Field>
      <SheetActions
        action={action}
        disabled={!url || problem !== null}
        onCancel={close}
        onAction={submit}
      />
    </div>
  )
}

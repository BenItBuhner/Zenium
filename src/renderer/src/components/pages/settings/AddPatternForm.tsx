import type { JSX } from 'react'
import { useId, useState } from 'react'
import type { SiteDataList, SiteDataStatus } from '@shared/siteData'
import { cmd } from '@renderer/lib/api'
import { SITE_DATA_TEXT, siteDataAddFeedback } from '@renderer/lib/siteDataUi'
import { Field, SheetActions, ValidationMessage } from './blocks'

/**
 * Add a site (§9.12 in a sheet, Chrome's "Add a site" dialog): one field read in Chrome's
 * pattern grammar, its hint under it until what is typed is refused – then the validation text
 * stands there and Add waits at .4 (§9.30); a pattern on another list says it will move. Add
 * asks the engine (`siteData.add`), the §9.30 busy form while it answers: a refusal (not a
 * pattern, the list full) clears the field, gives it the focus and shows the reason.
 */
export function AddPatternForm({
  list,
  status,
  windows,
  close
}: {
  list: SiteDataList
  status: SiteDataStatus
  windows: boolean
  close: () => void
}): JSX.Element {
  const id = useId()
  const [value, setValue] = useState('')
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const feedback = siteDataAddFeedback(status, list, value, windows)
  const problem = refused ?? feedback.problem
  const ready = value.trim() !== '' && problem === null
  const add = (): void => {
    if (!ready || busy) return
    setBusy(true)
    cmd('siteData.add', { list, pattern: value.trim() }).then(
      (result) => {
        setBusy(false)
        if (result.ok) {
          close()
          return
        }
        setRefused(result.problem)
        setValue('')
        document.getElementById(id)?.focus()
      },
      () => {
        setBusy(false)
        setRefused(SITE_DATA_TEXT.viewer.failed)
      }
    )
  }
  return (
    <div className="zen-settings-form" aria-busy={busy || undefined} data-testid="add-pattern-form">
      <Field
        id={id}
        label={SITE_DATA_TEXT.lists.field}
        description={problem ? undefined : feedback.hint}
      >
        <input
          id={id}
          className="zen-settings-input zen-v2-field"
          placeholder={SITE_DATA_TEXT.lists.placeholder}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          aria-invalid={problem ? true : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setRefused(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        {problem && <ValidationMessage message={problem} />}
      </Field>
      <SheetActions
        action={SITE_DATA_TEXT.lists.add}
        disabled={!ready}
        busy={busy}
        onCancel={close}
        onAction={add}
      />
    </div>
  )
}

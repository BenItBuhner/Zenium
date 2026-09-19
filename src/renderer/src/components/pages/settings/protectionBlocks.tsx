import type { JSX } from 'react'
import { useId, useState } from 'react'
import { normalizePrivacySite } from '@shared/privacy'
import { PROTECTION_TEXT } from '@renderer/lib/protectionUi'
import { Field, SheetActions, ValidationMessage } from './blocks'

/*
 * The form the protection rows of the phone Settings tab open (`protectionRows.tsx` builds the
 * rows as data; this file holds the one component among them, as `blocks.tsx` holds the tab's).
 */

/**
 * Related sites › Add a site (§9.12 in a sheet): one field, read as `normalizePrivacySite` reads
 * it, its hint under it until what is typed is refused – then the validation text stands there
 * and Add waits at .4 (§9.30) – exactly as the desktop pane's add row (`AddSite`) does.
 */
export function AddSiteForm({
  exists,
  onAdd,
  close
}: {
  exists: (site: string) => boolean
  onAdd: (site: string) => void
  close: () => void
}): JSX.Element {
  const id = useId()
  const [value, setValue] = useState('')
  const site = normalizePrivacySite(value)
  const text = PROTECTION_TEXT.relatedSites
  const problem =
    value.trim() === '' ? null : site === null ? text.invalid : exists(site) ? text.duplicate : null
  const add = (): void => {
    if (!site || problem) return
    onAdd(site)
    close()
  }
  return (
    <div className="zen-settings-form">
      <Field id={id} label="Site" description={problem ? undefined : text.siteHint}>
        <input
          id={id}
          className="zen-settings-input zen-v2-field"
          placeholder="example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        {problem && <ValidationMessage message={problem} />}
      </Field>
      <SheetActions
        action="Add site"
        disabled={!site || !!problem}
        onCancel={close}
        onAction={add}
      />
    </div>
  )
}

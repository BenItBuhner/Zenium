import type { JSX, KeyboardEvent } from 'react'
import { useState } from 'react'
import {
  engineKeywordProblem,
  searchTemplateProblem,
  uniqueEngineKeyword,
  type SearchEngineEdits
} from '@shared/search'
import type { SearchEngine } from '@shared/types'
import { Field, SheetActions, ValidationMessage } from './blocks'

/**
 * Search › Added search engines › Edit (omnibox-09, Chrome's "Edit search engine"): the Add
 * form's fields pre-filled from the engine – its name and the `%s` template – with the shortcut
 * between them (Chrome's Shortcut column), each checked as it is typed: the template through
 * `searchTemplateProblem`, the shortcut through `engineKeywordProblem` against the other
 * engines and Zenium's own `@tabs`, `@history`, `@bookmarks`. The shortcut may be left empty –
 * the field's placeholder is the one the name would derive – and `@` may be left off; the
 * browser normalises both. Save is held until the three are in order; the browser saves and
 * the sheet closes, or its refusal shows under the field it names.
 */
export function SearchEngineEditForm({
  engine,
  engines,
  onSave,
  close
}: {
  engine: SearchEngine
  /** Every engine of the profile, for the shortcut's uniqueness. */
  engines: readonly SearchEngine[]
  onSave: (edits: SearchEngineEdits) => Promise<unknown> | void
  close: () => void
}): JSX.Element {
  const [name, setName] = useState(engine.name)
  const [keyword, setKeyword] = useState(engine.keyword)
  const [url, setUrl] = useState(engine.searchUrl)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const urlProblem = searchTemplateProblem(url)
  const keywordProblem = engineKeywordProblem(keyword, engine.id, engines)
  const ready = Boolean(name.trim()) && !urlProblem && !keywordProblem
  const derived = uniqueEngineKeyword(
    name.trim() || engine.name,
    engines.filter((e) => e.id !== engine.id)
  )
  const submit = (): void => {
    if (!ready) {
      setTouched(true)
      return
    }
    void Promise.resolve(onSave({ name: name.trim(), searchUrl: url.trim(), keyword }))
      .then(close)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save the engine'))
  }
  const onEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
  }
  const shownUrl = error ?? (touched && url.trim() ? urlProblem : null)
  return (
    <div className="zen-settings-form" data-testid="search-engine-edit-form">
      <Field id="search-engine-edit-name" label="Name">
        <input
          id="search-engine-edit-name"
          className="zen-settings-input zen-v2-field"
          placeholder="Wikipedia"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnter}
        />
      </Field>
      <Field
        id="search-engine-edit-keyword"
        label="Shortcut"
        description={
          keywordProblem ? undefined : `Type it, then a space, to search here; empty for ${derived}`
        }
      >
        <input
          id="search-engine-edit-keyword"
          className="zen-settings-input zen-v2-field"
          placeholder={derived}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={keywordProblem ? true : undefined}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setError(null)
          }}
          onKeyDown={onEnter}
        />
        {keywordProblem && <ValidationMessage message={keywordProblem} />}
      </Field>
      <Field
        id="search-engine-edit-url"
        label="URL with %s in place of query"
        description={
          shownUrl ? undefined : 'Example: https://en.wikipedia.org/w/index.php?search=%s'
        }
      >
        <input
          id="search-engine-edit-url"
          className="zen-settings-input zen-v2-field"
          placeholder="https://example.com/search?q=%s"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={shownUrl ? true : undefined}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onBlur={() => setTouched(true)}
          onKeyDown={onEnter}
        />
        {shownUrl && <ValidationMessage message={shownUrl} />}
      </Field>
      <SheetActions action="Save" disabled={!ready} onCancel={close} onAction={submit} />
    </div>
  )
}

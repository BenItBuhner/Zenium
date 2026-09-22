import type { JSX } from 'react'
import { useState } from 'react'
import { filterLanguageChoices, type LanguageChoice } from '@renderer/lib/languageCatalogue'
import { PickList } from '../../translate/pickers'
import { RowText } from './rows'

/**
 * Settings › Languages › Add language's picker (CT-41; `languages.tsx` opens it from the action
 * row – a sheet on a phone, the builder's form dialog on a mouse): the filter field first, pinned
 * to the top of the scrolling body (§10.3), then the matching languages as the translate
 * pickers' pressable §10.4 rows – every pick adds, so no radio; the chassis focuses the first row
 * as a sheet opens, the dialog its field – the language's own name as the description; a pick
 * adds it and closes. Nothing left to add or nothing matching is §9.17's one line.
 */
export function LanguagePickList({
  label,
  choices,
  onPick,
  close
}: {
  label: string
  choices: readonly LanguageChoice[]
  onPick: (tag: string) => void
  close: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const shown = filterLanguageChoices(choices, query)
  const term = query.trim()
  return (
    <div className="zen-settings-sheet-rows">
      <div className="zen-settings-pick-filter">
        <input
          type="text"
          role="searchbox"
          className="zen-v2-field"
          placeholder="Find a language"
          aria-label="Find a language"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
      </div>
      {shown.length === 0 ? (
        <div data-static="" role="status" className="zen-settings-row zen-v2-row">
          <RowText
            label={
              choices.length === 0
                ? 'Every language is on the list'
                : `No language matches “${term}”`
            }
          />
        </div>
      ) : (
        <PickList label={label} options={shown} onPick={onPick} close={close} />
      )}
    </div>
  )
}

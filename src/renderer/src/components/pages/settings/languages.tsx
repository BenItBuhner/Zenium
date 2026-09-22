import type { JSX } from 'react'
import { useState } from 'react'
import { LANGUAGES_MAX } from '@shared/languages'
import { languageName } from '@shared/languageNames'
import {
  filterLanguageChoices,
  languageChoices,
  type LanguageChoice
} from '@renderer/lib/languageCatalogue'
import type { RowGroup, SettingsRow } from './model'
import { RowText } from './rows'
import type { SectionContext } from './sections'

/**
 * Settings › Languages › Preferred languages (CT-41; Chrome's chrome://settings/languages as
 * the shared builder's first group, §10.3): `Settings.languages` as §10.4 rows in the list's
 * order – the language's name, one line, a trailing ⋯ whose menu is Move Up / Move Down /
 * Remove, the item that does not apply listed at .4 (Move Up on the first row, Remove on the
 * last language: Chrome keeps one) – then Add language, an action row opening the §9.13 picker
 * (a sheet on a phone, the builder's form dialog on a mouse) with a filter field pinned under
 * its header (§10.3) over the catalogue's names in the UI's language and their own. The group's
 * description says what the order does; where the host cannot hand the list to its pages
 * (`capabilities.pageLanguages` false: Android's WebView sends the system's languages, the
 * interface note §3.4) the copy says so. The list is short by construction (Chrome's 32 at most,
 * a handful in practice), so it stays rows on the section rather than a drill-in page (§10.2).
 */

/** The list with the entry at `index` moved by `by` places (−1 up, +1 down); the same list when it cannot move. */
export function moveLanguage(list: readonly string[], index: number, by: -1 | 1): string[] {
  const target = index + by
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list]
  const out = [...list]
  const [moved] = out.splice(index, 1)
  out.splice(target, 0, moved)
  return out
}

/**
 * The picker (§9.13's sheet of pressable rows – every pick adds, so no radio; the chassis
 * focuses the first row as the sheet opens, the dialog its field): the filter field first,
 * pinned to the top of the scrolling body, then the matching languages as §10.4 rows, the
 * language's own name as the description; a pick adds it and closes. Nothing left to add or
 * nothing matching is §9.17's one line.
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
    <div role="group" aria-label={label} className="zen-settings-sheet-rows">
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
        <p className="zen-settings-empty" role="status">
          {choices.length === 0
            ? 'Every language is on the list'
            : `No language matches “${term}”`}
        </p>
      ) : (
        shown.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="zen-settings-row zen-settings-row-pressable zen-v2-row"
            onClick={() => {
              onPick(choice.value)
              close()
            }}
          >
            <RowText label={choice.label} description={choice.description} />
          </button>
        ))
      )}
    </div>
  )
}

/** The group: the list's rows with their menus, then the Add language row. */
export function preferredLanguagesGroups({
  state,
  set
}: Pick<SectionContext, 'state' | 'set'>): RowGroup[] {
  const languages = state.settings.languages
  const pagesFollow = state.capabilities.pageLanguages
  const keywords = ['preferred languages', 'accept-language', 'language order', 'translate into']
  const rows: SettingsRow[] = languages.map((code, index) => {
    const name = languageName(code)
    return {
      kind: 'info',
      id: `languages-preferred:${code}`,
      label: name,
      keywords: [code, ...keywords],
      menu: {
        label: `Options for ${name}`,
        items: [
          {
            id: 'up',
            label: 'Move Up',
            disabled: index === 0,
            onSelect: () => set({ languages: moveLanguage(languages, index, -1) })
          },
          {
            id: 'down',
            label: 'Move Down',
            disabled: index === languages.length - 1,
            onSelect: () => set({ languages: moveLanguage(languages, index, 1) })
          },
          {
            id: 'remove',
            label: 'Remove',
            disabled: languages.length <= 1,
            onSelect: () => set({ languages: languages.filter((_, i) => i !== index) })
          }
        ]
      }
    }
  })
  const full = languages.length >= LANGUAGES_MAX
  const choices = languageChoices(languages)
  rows.push({
    kind: 'action',
    id: 'languages-add',
    label: 'Add language',
    description: full
      ? `The list holds ${LANGUAGES_MAX} languages at most; remove one to add another.`
      : undefined,
    keywords: ['add language', ...keywords],
    disabled: full,
    button: 'Add…',
    form: {
      title: 'Add language',
      render: (close) => (
        <LanguagePickList
          label="Add language"
          choices={choices}
          onPick={(tag) => set({ languages: [...languages, tag] })}
          close={close}
        />
      )
    }
  })
  return [
    {
      id: 'preferred',
      heading: 'Preferred languages',
      description: pagesFollow
        ? 'In your order of preference. Sites that come in several languages show the first one here they have; pages are translated into the first language, and its dictionary checks spelling unless you chose others.'
        : 'In your order of preference. Pages are translated into the first language here. Sites that come in several languages show the one this device is set to – pages receive the system’s languages, not this list.',
      rows
    }
  ]
}

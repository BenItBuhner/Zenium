import { LANGUAGES_MAX } from '@shared/languages'
import { run } from '@renderer/lib/api'
import {
  catalogueLanguageName,
  languageChoices,
  nativeLanguageName,
  translateLanguageChoices,
  type LanguageChoice
} from '@renderer/lib/languageCatalogue'
import { LanguagePickList } from './LanguagePickList'
import type { ActionRow, ItemRow, RowGroup, SettingsRow } from './model'
import type { SectionContext } from './sections'

/**
 * Settings › Languages › Preferred languages (CT-41; Chrome's chrome://settings/languages as
 * the shared builder's first group, §10.3): `Settings.languages` as §10.4 item rows in the
 * list's order – a plain row, no control, no chevron, no ⋯, the language's name (in the UI's
 * language, the catalogue's English name where the runtime has none, so never a bare tag) as
 * its one line – whose whole tap opens the item sheet titled with the name: Move Up, Move Down,
 * Remove as action rows in the order they are used, the one that cannot apply at .4 (Move Up
 * on the first row, Move Down on the last, Remove on the last language: Chrome keeps one),
 * Remove in the plain ink and unconfirmed, since a preference removed is no data destroyed. On
 * a mouse the same rows trail §10.5's 28 ⋯ over the sheet's rows (`ItemRow.menu`). Then Add
 * language, the action row that on the phone opens the section's find-and-pick page
 * (`zen://settings/languages/add?list=preferred`, `AddLanguagePage`, §10.2) and on a mouse the
 * 400 list-bodied dialog with the same filter (`LanguagePickList`), one route for every Add row
 * of the section ({@link addLanguageRow}). The group's description says what the order does;
 * where the host cannot hand the list to its pages (`capabilities.pageLanguages` false:
 * Android's WebView sends the system's languages, the interface note §3.4) the copy says so.
 * The list is short by construction (Chrome's 32 at most, a handful in practice), so it stays
 * rows on the section rather than a drill-in page (§10.2).
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

/** The section's find-and-pick page (`InternalPageSection.pages`, `SUBPAGES['languages/add']`). */
export const ADD_LANGUAGE_PAGE = 'add'

/** The lists an Add language row adds to; the page's `?list=` names one. */
export type AddLanguageList = 'preferred' | 'always' | 'never'

export const ADD_LANGUAGE_LISTS: readonly AddLanguageList[] = ['preferred', 'always', 'never']

/** What one Add language row adds to: the page's and the dialog's title, the languages left, the write. */
export interface AddLanguageTarget {
  title: string
  choices: LanguageChoice[]
  add(tag: string): void
}

/**
 * The three lists as the Add rows and the page read them, from the state and the commands, so
 * the page opened for `?list=always` adds what the Always translate group's row would have: the
 * preferred list takes the catalogue less itself and writes `Settings.languages`; the translate
 * lists take the translator's languages less their own and write the language's rule.
 */
export function addLanguageTargets({
  state,
  set
}: Pick<SectionContext, 'state' | 'set'>): Record<AddLanguageList, AddLanguageTarget> {
  const languages = state.settings.languages
  const t = state.translate
  const prefs = t.preferences
  const rule = (language: string, value: 'always' | 'never'): void =>
    run('translate.setLanguageRule', { language, rule: value })
  const left = (taken: readonly string[]): LanguageChoice[] =>
    translateLanguageChoices(t.languages.filter((code) => !taken.includes(code)))
  return {
    preferred: {
      title: 'Add language',
      choices: languageChoices(languages),
      add: (tag) => set({ languages: [...languages, tag] })
    },
    always: {
      title: 'Always translate',
      choices: left(prefs.alwaysTranslate),
      add: (code) => rule(code, 'always')
    },
    never: {
      title: 'Never translate',
      choices: left(prefs.neverTranslate),
      add: (code) => rule(code, 'never')
    }
  }
}

/**
 * An Add language row (§10.2: every row on the page that adds a language opens the one page):
 * on the phone layout the section's find-and-pick page with the list in its address, on a mouse
 * – and where the page has no way to open one – the 400 list-bodied dialog with the same filter
 * field and rows (`LanguagePickList`, `body: 'list'`, #314 (c)).
 */
export function addLanguageRow(
  id: string,
  list: AddLanguageList,
  target: AddLanguageTarget,
  extra: { description?: string; disabled?: boolean; keywords?: readonly string[] } = {}
): ActionRow {
  return {
    kind: 'action',
    id,
    label: 'Add language',
    description: extra.description,
    keywords: extra.keywords,
    disabled: extra.disabled,
    button: 'Add…',
    page: ADD_LANGUAGE_PAGE,
    pageQuery: { list },
    form: {
      title: target.title,
      body: 'list',
      render: (close) => (
        <LanguagePickList
          label={target.title}
          choices={target.choices}
          onPick={target.add}
          close={close}
        />
      )
    }
  }
}

/** The group: the list's item rows, then the Add language row. */
export function preferredLanguagesGroups({
  state,
  set
}: Pick<SectionContext, 'state' | 'set'>): RowGroup[] {
  const languages = state.settings.languages
  const pagesFollow = state.capabilities.pageLanguages
  const keywords = ['preferred languages', 'accept-language', 'language order', 'translate into']
  const rows: SettingsRow[] = languages.map((code, index): ItemRow => {
    // The runtime's name for the tag, the catalogue's English one where it has none (Android's
    // ICU writes "as" for Assamese); a tag from outside the catalogue that no runtime names is
    // left to its own name, and the tag itself is the residual last resort for a stored value
    // the picker never offered.
    const name = catalogueLanguageName(code) ?? nativeLanguageName(code) ?? code
    const id = `languages-preferred:${code}`
    return {
      kind: 'item',
      id,
      label: name,
      keywords: [code, ...keywords],
      menu: `Options for ${name}`,
      sheet: {
        title: name,
        groups: [
          {
            id: `${id}-actions`,
            heading: null,
            rows: [
              {
                kind: 'action',
                id: `${id}:up`,
                label: 'Move Up',
                disabled: index === 0,
                onPress: () => set({ languages: moveLanguage(languages, index, -1) })
              },
              {
                kind: 'action',
                id: `${id}:down`,
                label: 'Move Down',
                disabled: index === languages.length - 1,
                onPress: () => set({ languages: moveLanguage(languages, index, 1) })
              },
              {
                kind: 'action',
                id: `${id}:remove`,
                label: 'Remove',
                disabled: languages.length <= 1,
                onPress: () => set({ languages: languages.filter((_, i) => i !== index) })
              }
            ]
          }
        ]
      }
    }
  })
  const full = languages.length >= LANGUAGES_MAX
  rows.push(
    addLanguageRow('languages-add', 'preferred', addLanguageTargets({ state, set }).preferred, {
      description: full
        ? `The list holds ${LANGUAGES_MAX} languages at most; remove one to add another.`
        : undefined,
      keywords: ['add language', ...keywords],
      disabled: full
    })
  )
  return [
    {
      id: 'preferred',
      heading: 'Preferred languages',
      // Two sentences (§10.3's density, the #322 Q6 precedent): what the order does for sites,
      // and for translation; the spell check group says what it does with the list.
      description: pagesFollow
        ? 'In your order of preference: sites that come in several languages show the first one here they have. Pages are translated into the first language.'
        : 'Pages are translated into the first language here. Sites that come in several languages follow this device’s languages, not this list.',
      rows
    }
  ]
}

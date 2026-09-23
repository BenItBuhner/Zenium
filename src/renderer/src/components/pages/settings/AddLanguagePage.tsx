import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { InternalPageQuery } from '@shared/internalPages'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { filterLanguageChoices } from '@renderer/lib/languageCatalogue'
import { PickList } from '../../translate/pickers'
import { useDrillInBack } from './drillIn'
import { ADD_LANGUAGE_LISTS, addLanguageTargets, type AddLanguageList } from './languages'
import type { SectionContext } from './sections'

/**
 * Settings › Languages › Add language on the phone: the section's find-and-pick page
 * (`zen://settings/languages/add?list=<preferred|always|never>`, design language v2 §10.2; the
 * #322 ruling (a) read for a set the user finds in rather than scans, §9.13). Under the pane's
 * 56 bar the §9.12 field is pinned in the gutter, "Find a language", with §9.7's hairline under
 * it once the list has scrolled; then the languages left to add as 44 / 64 rows – the name in
 * the UI's language, the own name beneath from the table the app ships (`languageCatalogue.ts`;
 * a language whose own name is the name draws one line) – filtered as the field is typed in
 * (`filterLanguageChoices`: name, own name or tag, accents ignored). A tap picks and returns:
 * the list named in the address takes the language and the pane leaves as back would. The page
 * opens on its first row (§9.22: the field is taken by a tap, so the keyboard does not come up
 * over the list); nothing matching, or nothing left, is §9.17's one sentence under the field.
 * The page owns its scroller so the field stays put and the hairline is the field's, not the
 * bar's; every Add row of the section opens this one page, whichever list it adds to.
 */
export function AddLanguagePage({
  ctx,
  query,
  tab
}: {
  ctx: SectionContext
  query: InternalPageQuery
  tab: Tab
}): JSX.Element {
  const list = addLanguageList(query)
  const target = addLanguageTargets(ctx)[list]
  const [filter, setFilter] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const back = useDrillInBack()
  const shown = filterLanguageChoices(target.choices, filter)
  const term = filter.trim()
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>('.zen-settings-row-pressable')
      ?.focus({ preventScroll: true })
  }, [])
  const leave = (): void => {
    if (back) back()
    else run('tab.back', { tabId: tab.id })
  }
  return (
    <div
      ref={root}
      className="zen-settings-add-language"
      data-scrolled={scrolled || undefined}
      data-list={list}
      data-testid="add-language-page"
    >
      <div className="zen-settings-add-language-filter">
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
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault()
              e.stopPropagation()
              setFilter('')
            }
          }}
        />
      </div>
      <div
        className="zen-settings-add-language-list"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {shown.length === 0 ? (
          <p role="status" className="zen-settings-empty zen-settings-pick-empty">
            {target.choices.length === 0
              ? 'Every language is on the list'
              : `No language matches “${term}”`}
          </p>
        ) : (
          <PickList label={target.title} options={shown} onPick={target.add} close={leave} />
        )}
      </div>
    </div>
  )
}

/** The list the address names (`?list=`), the preferred list for an address that names none or another. */
export function addLanguageList(query: InternalPageQuery): AddLanguageList {
  const list = query.list
  return ADD_LANGUAGE_LISTS.find((l) => l === list) ?? 'preferred'
}

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  LANGUAGE_CATALOGUE,
  filterLanguageChoices,
  languageChoices,
  nativeLanguageName
} from '@renderer/lib/languageCatalogue'
import { familiesOf } from '@renderer/lib/localFonts'
import { LanguagePickList } from '../LanguagePickList'
import { moveLanguage } from '../languages'

/*
 * CT-41's Add language picker and the pure rules under it: the catalogue is Chrome's
 * accept-language list as tags, each choice named in the UI's language with the language's own
 * name beside it where that says something more, sorted by name and less what is already on the
 * list; the filter matches every typed term against the name, the own name or the tag with
 * accents ignored; the list reorders by one place and never past its ends. The picker itself is
 * the filter field pinned first, then one pressable §10.4 row per match – a pick adds and closes –
 * and one static row (§9.17, §9.34) when nothing matches or nothing is left. CT-25's local-fonts
 * helper reduces the Local Font Access API's faces to distinct, sorted family names.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    // Past React's value tracker, so the change registers.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the language catalogue', () => {
  it('is Chrome’s list as canonical tags, each with a name the runtime knows', () => {
    expect(LANGUAGE_CATALOGUE.length).toBeGreaterThan(150)
    expect(new Set(LANGUAGE_CATALOGUE).size).toBe(LANGUAGE_CATALOGUE.length)
    for (const tag of LANGUAGE_CATALOGUE) {
      expect(tag, tag).toMatch(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/)
    }
    const choices = languageChoices()
    expect(choices.length).toBe(LANGUAGE_CATALOGUE.length)
    for (const choice of choices) expect(choice.label, choice.value).not.toBe(choice.value)
  })

  it('names each choice in the UI’s language, its own name beside it where that differs, sorted by name, less what is listed', () => {
    const choices = languageChoices(['en', 'en-GB'])
    expect(choices.find((c) => c.value === 'en')).toBeUndefined()
    expect(choices.find((c) => c.value === 'en-GB')).toBeUndefined()
    expect(choices.find((c) => c.value === 'en-US')).toMatchObject({
      label: 'English (United States)',
      description: undefined
    })
    expect(choices.find((c) => c.value === 'de')).toMatchObject({
      label: 'German',
      description: 'Deutsch'
    })
    expect(choices.find((c) => c.value === 'ja')).toMatchObject({
      label: 'Japanese',
      description: '日本語'
    })
    const labels = choices.map((c) => c.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
    // The listed tags are compared without regard to case (a synced `EN-gb`).
    expect(languageChoices(['EN-gb']).find((c) => c.value === 'en-GB')).toBeUndefined()
  })

  it('the language’s own name is null where the runtime has none or it is the UI’s', () => {
    expect(nativeLanguageName('de')).toBe('Deutsch')
    expect(nativeLanguageName('en')).toBe('English')
    expect(nativeLanguageName('zz')).toBeNull()
  })

  it('filters by every term against the name, the own name and the tag, accents and case aside', () => {
    const choices = languageChoices()
    const values = (query: string): string[] =>
      filterLanguageChoices(choices, query).map((c) => c.value)
    expect(values('')).toEqual(choices.map((c) => c.value))
    expect(values('   ')).toEqual(choices.map((c) => c.value))
    expect(values('deutsch')).toContain('de')
    expect(values('DEUTSCH')).toContain('de')
    expect(values('en-gb')).toEqual(['en-GB'])
    expect(values('espanol')).toContain('es')
    expect(values('german austria')).toEqual(['de-AT'])
    expect(values('portuguese brazil')).toEqual(['pt-BR'])
    expect(values('klingon')).toEqual([])
  })
})

describe('moving a language', () => {
  it('moves one place up or down and never past an end', () => {
    expect(moveLanguage(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveLanguage(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveLanguage(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveLanguage(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    expect(moveLanguage(['a'], 0, 1)).toEqual(['a'])
    expect(moveLanguage([], 0, 1)).toEqual([])
  })
})

describe('the Add language picker', () => {
  const choices = languageChoices(['en'])

  it('is the filter field first, then a pressable row per choice; a pick adds and closes', () => {
    const onPick = vi.fn()
    const close = vi.fn()
    const el = render(
      <LanguagePickList label="Add language" choices={choices} onPick={onPick} close={close} />
    )
    const body = el.firstElementChild!
    expect(body.firstElementChild?.classList.contains('zen-settings-pick-filter')).toBe(true)
    const field =
      body.firstElementChild!.querySelector<HTMLInputElement>('input[role="searchbox"]')!
    expect(field.getAttribute('aria-label')).toBe('Find a language')
    expect(field.getAttribute('inputmode')).toBe('search')
    // The rows are the translate pickers' `PickList` (one inset-row carrier, not a new one).
    const group = body.querySelector('[role="group"][aria-label="Add language"]')!
    expect(group.previousElementSibling).toBe(body.firstElementChild)
    const rows = [...group.querySelectorAll<HTMLButtonElement>('button.zen-settings-row')]
    expect(rows.length).toBe(choices.length)
    expect(rows[0].querySelector('.zen-settings-label')?.textContent).toBe(choices[0].label)
    const german = rows.find(
      (r) => r.querySelector('.zen-settings-label')?.textContent === 'German'
    )!
    expect(german.querySelector('.zen-settings-description')?.textContent).toBe('Deutsch')
    act(() => german.click())
    expect(onPick).toHaveBeenCalledWith('de')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('the filter narrows the rows as it is typed; no match is one static row naming the term; Escape clears the field before it would close the sheet', () => {
    const el = render(
      <LanguagePickList
        label="Add language"
        choices={choices}
        onPick={() => undefined}
        close={() => undefined}
      />
    )
    const field = el.querySelector<HTMLInputElement>('input[role="searchbox"]')!
    type(field, 'deu')
    let rows = [...el.querySelectorAll<HTMLButtonElement>('button.zen-settings-row')]
    expect(rows.map((r) => r.querySelector('.zen-settings-label')?.textContent)).toEqual([
      'German',
      'German (Austria)',
      'German (Germany)',
      'German (Liechtenstein)',
      'German (Switzerland)'
    ])
    type(field, 'klingon')
    rows = [...el.querySelectorAll<HTMLButtonElement>('button.zen-settings-row')]
    expect(rows).toEqual([])
    const empty = el.querySelector<HTMLElement>('[role="status"]')!
    expect(empty.hasAttribute('data-static')).toBe(true)
    expect(empty.textContent).toBe('No language matches “klingon”')

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      field.dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(true)
    expect(field.value).toBe('')
    expect(el.querySelectorAll('button.zen-settings-row').length).toBe(choices.length)
    // An empty field leaves Escape to the sheet.
    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      field.dispatchEvent(again)
    })
    expect(again.defaultPrevented).toBe(false)
  })

  it('nothing left to add is one static row', () => {
    const el = render(
      <LanguagePickList
        label="Add language"
        choices={[]}
        onPick={() => undefined}
        close={() => undefined}
      />
    )
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Every language is on the list')
    expect(el.querySelectorAll('button.zen-settings-row').length).toBe(0)
  })
})

describe('the computer’s font families (CT-25)', () => {
  it('reduces the API’s faces to distinct family names, sorted without regard to case, hidden families left out', () => {
    expect(
      familiesOf([
        { family: 'Inter' },
        { family: 'Inter' },
        { family: 'arial' },
        { family: '.SF NS' },
        { family: '  ' },
        { family: 'Georgia' }
      ])
    ).toEqual(['arial', 'Georgia', 'Inter'])
  })
})

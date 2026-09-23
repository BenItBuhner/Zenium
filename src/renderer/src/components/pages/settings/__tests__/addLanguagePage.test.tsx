// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import type { TranslateUIState } from '@shared/translate'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { AddLanguagePage } from '../AddLanguagePage'
import { DrillInBackContext } from '../drillIn'
import { addLanguageList, addLanguageTargets } from '../languages'
import type { SectionContext } from '../sections'

/*
 * Settings › Languages › Add language on the phone (the #350 lead check's ruling 3, §9.13,
 * §10.2): the section's find-and-pick page at `zen://settings/languages/add?list=<list>`, the
 * one page every Add row of the section opens. The §9.12 field is pinned first under the bar,
 * then one pressable row per language left to add – the name, the own name beneath from the
 * shipped table – filtered as the field is typed in; a tap adds to the list the address names
 * and leaves as back would; the page opens on its first row (§9.22), and nothing matching or
 * nothing left is §9.17's one sentence.
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
  vi.mocked(run).mockClear()
})

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['en'],
    alwaysTranslate: ['es'],
    neverTranslate: [],
    neverTranslateSites: [],
    autoOffer: true
  },
  languages: ['de', 'en', 'es', 'fr'],
  installed: [],
  downloading: [],
  registryDate: '2026-09-01',
  modelLicense: 'MPL-2.0',
  tabs: {}
}

const TAB = { id: 'settings' } as Tab

/** The section context the page reads: the state's languages and translator, and the settings write. */
function context(languages: string[]): { ctx: SectionContext; set: ReturnType<typeof vi.fn> } {
  const set = vi.fn()
  const state = { settings: { languages }, translate: TRANSLATE } as unknown as UIState
  return { ctx: { state, set } as unknown as SectionContext, set }
}

const rows = (el: ParentNode): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('[role="group"] > button')
]
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('.zen-settings-label')?.textContent
const field = (el: ParentNode): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('input[role="searchbox"]')!

describe('the list the address names', () => {
  it('is one of the three, the preferred list for none or another', () => {
    expect(addLanguageList({ list: 'preferred' })).toBe('preferred')
    expect(addLanguageList({ list: 'always' })).toBe('always')
    expect(addLanguageList({ list: 'never' })).toBe('never')
    expect(addLanguageList({})).toBe('preferred')
    expect(addLanguageList({ list: 'sites' })).toBe('preferred')
  })

  it('the three targets: the preferred list takes the catalogue less itself and writes the setting; the translate lists take the translator’s languages less their own and write the rule', () => {
    const { ctx, set } = context(['en', 'de'])
    const targets = addLanguageTargets(ctx)
    expect(targets.preferred.title).toBe('Add language')
    expect(targets.preferred.choices.map((c) => c.value)).not.toContain('en')
    expect(targets.preferred.choices.map((c) => c.value)).not.toContain('de')
    expect(targets.preferred.choices.length).toBeGreaterThan(150)
    targets.preferred.add('fr')
    expect(set).toHaveBeenCalledWith({ languages: ['en', 'de', 'fr'] })

    expect(targets.always.title).toBe('Always translate')
    expect(targets.always.choices.map((c) => c.value)).toEqual(['en', 'fr', 'de'])
    expect(targets.always.choices.map((c) => c.label)).toEqual(['English', 'French', 'German'])
    expect(targets.always.choices.map((c) => c.description)).toEqual([
      undefined,
      'français',
      'Deutsch'
    ])
    targets.always.add('de')
    expect(run).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'de',
      rule: 'always'
    })

    expect(targets.never.title).toBe('Never translate')
    expect(targets.never.choices.map((c) => c.value)).toEqual(['en', 'fr', 'de', 'es'])
    targets.never.add('es')
    expect(run).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'es',
      rule: 'never'
    })
  })
})

describe('the Add language page', () => {
  it('is the pinned field first, then a pressable row per language left – the name over the own name from the shipped table – and opens on its first row', () => {
    const { ctx } = context(['en'])
    const el = render(<AddLanguagePage ctx={ctx} query={{ list: 'preferred' }} tab={TAB} />)
    const page = el.querySelector<HTMLElement>('[data-testid="add-language-page"]')!
    expect(page.getAttribute('data-list')).toBe('preferred')
    expect(page.hasAttribute('data-scrolled')).toBe(false)
    expect(page.firstElementChild?.classList.contains('zen-settings-add-language-filter')).toBe(
      true
    )
    const input = field(page)
    expect(input.getAttribute('aria-label')).toBe('Find a language')
    expect(input.getAttribute('inputmode')).toBe('search')
    expect(input.classList.contains('zen-v2-field')).toBe(true)
    const list = page.children[1]
    expect(list.classList.contains('zen-settings-add-language-list')).toBe(true)
    const group = list.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Add language')
    const all = rows(page)
    expect(all.length).toBeGreaterThan(150)
    expect(all.map(labelOf)).not.toContain('English')
    for (const row of all) {
      expect(row.classList.contains('zen-settings-row-pressable')).toBe(true)
      expect(row.querySelector('svg')).toBeNull()
    }
    const german = all.find((r) => labelOf(r) === 'German')!
    expect(german.querySelector('.zen-settings-description')?.textContent).toBe('Deutsch')
    // A language whose own name is the name draws one line.
    const afrikaans = all.find((r) => labelOf(r) === 'Afrikaans')!
    expect(afrikaans.querySelector('.zen-settings-description')).toBeNull()
    // §9.22: the first row, not the field, so no keyboard comes up over the list.
    expect(document.activeElement).toBe(all[0])
  })

  it('a tap adds to the list the address names and leaves as back would', () => {
    const { ctx, set } = context(['en'])
    const back = vi.fn()
    const el = render(
      <DrillInBackContext.Provider value={back}>
        <AddLanguagePage ctx={ctx} query={{ list: 'preferred' }} tab={TAB} />
      </DrillInBackContext.Provider>
    )
    const german = rows(el).find((r) => labelOf(r) === 'German')!
    act(() => german.click())
    expect(set).toHaveBeenCalledWith({ languages: ['en', 'de'] })
    expect(back).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalledWith('tab.back', expect.anything())
  })

  it('without the pane’s back – the page reached by its address alone – the tab goes back', () => {
    const { ctx } = context(['en'])
    const el = render(<AddLanguagePage ctx={ctx} query={{ list: 'always' }} tab={TAB} />)
    const page = el.querySelector<HTMLElement>('[data-testid="add-language-page"]')!
    expect(page.getAttribute('data-list')).toBe('always')
    expect(page.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Always translate'
    )
    // The translator's languages less the list's own (Spanish is on it).
    expect(rows(page).map(labelOf)).toEqual(['English', 'French', 'German'])
    act(() =>
      rows(page)
        .find((r) => labelOf(r) === 'French')!
        .click()
    )
    expect(run).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'fr',
      rule: 'always'
    })
    expect(run).toHaveBeenCalledWith('tab.back', { tabId: 'settings' })
  })

  it('the field narrows the rows as it is typed in; nothing matching is §9.17’s one sentence; Escape clears the field', () => {
    const { ctx } = context(['en'])
    const el = render(<AddLanguagePage ctx={ctx} query={{}} tab={TAB} />)
    const input = field(el)
    type(input, 'deu')
    expect(rows(el).map(labelOf)).toEqual([
      'German',
      'German (Austria)',
      'German (Germany)',
      'German (Liechtenstein)',
      'German (Switzerland)'
    ])
    type(input, 'klingon')
    expect(rows(el)).toEqual([])
    const empty = el.querySelector<HTMLElement>('[role="status"]')!
    expect(empty.tagName).toBe('P')
    expect(empty.classList.contains('zen-settings-pick-empty')).toBe(true)
    expect(empty.textContent).toBe('No language matches “klingon”')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      input.dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(true)
    expect(input.value).toBe('')
    expect(rows(el).length).toBeGreaterThan(150)
  })

  it('nothing left to add is the same one sentence', () => {
    const { ctx } = context(['en'])
    const el = render(<AddLanguagePage ctx={ctx} query={{ list: 'never' }} tab={TAB} />)
    // The never list's target reads the translator's languages less the never list: all four
    // are left here, so take a translator with none instead.
    expect(rows(el).length).toBe(4)
    act(() => root?.unmount())
    host?.remove()
    const state = {
      settings: { languages: ['en'] },
      translate: { ...TRANSLATE, languages: [] }
    } as unknown as UIState
    const none = render(
      <AddLanguagePage
        ctx={{ state, set: vi.fn() } as unknown as SectionContext}
        query={{ list: 'never' }}
        tab={TAB}
      />
    )
    expect(rows(none)).toEqual([])
    expect(none.querySelector('[role="status"]')?.textContent).toBe('Every language is on the list')
  })

  it('the hairline under the field follows the list’s scroll, not the pane’s', () => {
    const { ctx } = context(['en'])
    const el = render(<AddLanguagePage ctx={ctx} query={{}} tab={TAB} />)
    const page = el.querySelector<HTMLElement>('[data-testid="add-language-page"]')!
    const list = page.querySelector<HTMLElement>('.zen-settings-add-language-list')!
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 40 })
    act(() => {
      list.dispatchEvent(new Event('scroll'))
    })
    expect(page.getAttribute('data-scrolled')).toBe('true')
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 0 })
    act(() => {
      list.dispatchEvent(new Event('scroll'))
    })
    expect(page.hasAttribute('data-scrolled')).toBe(false)
  })
})

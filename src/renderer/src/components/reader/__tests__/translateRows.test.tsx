// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReaderTranslateState, TranslateUIState } from '@shared/translate'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import {
  readerTranslateError,
  readerTranslateProgress,
  readerTranslateTarget,
  readerTranslateWorking
} from '@renderer/lib/readerTranslate'
import { DEFAULT_READER_PREFERENCES } from '@shared/reader'
import { Rows, TranslateRow } from '../ReaderPreferencesPanel'

/*
 * Translate inside Reader View's text preferences (CT-36; the #350 lead check's rulings 4 and
 * 5): ONE row, Listen's sibling at the panel's head, a 44 action row with the translate glyph.
 * The press opens the target picker – the languages the models reach, the remembered target
 * checked (the last pick here, else the translation's own, else the first preferred language a
 * model reaches; never the article's own language once known) – and the pick translates at
 * once. The row is §9.30's busy row with the progress as its second line while the core works
 * (a press doing nothing), keeps the reason in the danger ink when it failed (the press opens
 * the picker again: the pick is the retry), and gives way to the "Show original" switch row,
 * "Translated into <language>" its description, once the article is translated. Never a
 * menulist-plus-action pair. In the panel the head rows are one group before the type rows'
 * hairline, so #265's rule holds with the one head row: the live type rows stay whole above the
 * phone sheet's peek fold.
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

const desktop = (): void =>
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
const phone = (): void =>
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })

const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['fr', 'en'],
    alwaysTranslate: [],
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

function translation(patch: Partial<ReaderTranslateState> = {}): ReaderTranslateState {
  return {
    tabId: 't1',
    status: 'translating',
    source: 'de',
    target: 'fr',
    progress: { done: 12, total: 40 },
    download: null,
    error: null,
    showOriginal: false,
    ...patch
  }
}

const row = (el: HTMLElement, pref: string): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>(`[data-reader-pref="${pref}"]`)!

/** Press the row and let the popover's wait for the page's cover resolve (at once with no page). */
async function open(translate: HTMLElement): Promise<void> {
  await act(async () => {
    translate.click()
    await Promise.resolve()
  })
}

const listbox = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="listbox"][aria-label="Translate into"]')
const options = (): HTMLElement[] => [
  ...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
]
const optionLabel = (option: HTMLElement): string =>
  (option.querySelector('.truncate') ?? option).textContent ?? ''
const checkedOption = (): HTMLElement | undefined =>
  options().find((o) => o.getAttribute('aria-selected') === 'true')

describe('the rows’ rules', () => {
  it('the target is the pick, else the translation’s, else the first preferred language a model reaches, else English, else the first language; null with no languages', () => {
    expect(readerTranslateTarget(null, null, TRANSLATE)).toBe('fr')
    expect(readerTranslateTarget(null, 'es', TRANSLATE)).toBe('es')
    expect(readerTranslateTarget(null, 'xx', TRANSLATE)).toBe('fr')
    expect(readerTranslateTarget(translation({ target: 'de' }), null, TRANSLATE)).toBe('de')
    expect(readerTranslateTarget(translation({ target: 'de' }), 'es', TRANSLATE)).toBe('es')
    expect(
      readerTranslateTarget(null, null, {
        ...TRANSLATE,
        preferences: { ...TRANSLATE.preferences, preferred: ['ja'] }
      })
    ).toBe('en')
    expect(
      readerTranslateTarget(null, null, {
        languages: ['es'],
        preferences: { ...TRANSLATE.preferences, preferred: ['ja'] }
      })
    ).toBe('es')
    expect(
      readerTranslateTarget(null, null, { languages: [], preferences: TRANSLATE.preferences })
    ).toBeNull()
  })

  it('the article’s own language is never proposed once known: the next preferred language, else English, else the source itself when nothing else is reached', () => {
    // The reader's own translation named the source (a failure told it, or an earlier run).
    expect(
      readerTranslateTarget(
        translation({ status: 'error', source: 'fr', target: null }),
        null,
        TRANSLATE
      )
    ).toBe('en')
    // The page translate's detection stands in before the reader looked.
    expect(readerTranslateTarget(null, null, TRANSLATE, 'fr')).toBe('en')
    expect(readerTranslateTarget(null, null, TRANSLATE, 'de')).toBe('fr')
    // English is the pivot when no preferred language but the source is reached.
    expect(
      readerTranslateTarget(
        null,
        null,
        {
          ...TRANSLATE,
          preferences: { ...TRANSLATE.preferences, preferred: ['fr'] }
        },
        'fr'
      )
    ).toBe('en')
    // Only the source is reached: it stays the proposal rather than nothing.
    expect(
      readerTranslateTarget(
        null,
        null,
        {
          languages: ['fr'],
          preferences: { ...TRANSLATE.preferences, preferred: ['fr'] }
        },
        'fr'
      )
    ).toBe('fr')
    // The user's pick and the translation's target still win over the rule.
    expect(readerTranslateTarget(null, 'fr', TRANSLATE, 'fr')).toBe('fr')
    expect(
      readerTranslateTarget(translation({ target: 'fr', source: 'fr' }), null, TRANSLATE)
    ).toBe('fr')
  })

  it('the failure line: the core’s "already in <code>" names the language, another reason reads as a sentence, none reads "Translation failed."', () => {
    expect(readerTranslateError('This article is already in en.')).toBe(
      'This article is already in English.'
    )
    expect(readerTranslateError('This article is already in pt-BR')).toBe(
      'This article is already in Portuguese (Brazil).'
    )
    expect(readerTranslateError('no model for German to Japanese')).toBe(
      'No model for German to Japanese.'
    )
    expect(readerTranslateError(null)).toBe('Translation failed.')
    expect(readerTranslateError('  ')).toBe('Translation failed.')
  })

  it('at work while the language is told, the model arrives or the blocks translate; the progress line says which', () => {
    expect(readerTranslateWorking(null)).toBe(false)
    expect(readerTranslateWorking(translation({ status: 'detecting' }))).toBe(true)
    expect(readerTranslateWorking(translation({ status: 'downloading' }))).toBe(true)
    expect(readerTranslateWorking(translation())).toBe(true)
    expect(readerTranslateWorking(translation({ status: 'translated' }))).toBe(false)
    expect(readerTranslateWorking(translation({ status: 'error' }))).toBe(false)

    expect(readerTranslateProgress(translation({ status: 'detecting', source: null }))).toBe(
      'Working out the article’s language…'
    )
    expect(
      readerTranslateProgress(
        translation({
          status: 'downloading',
          download: { received: 12_000_000, total: 40_000_000 }
        })
      )
    ).toBe('Getting the German to French model (11.4 MB of 38.1 MB)…')
    expect(readerTranslateProgress(translation())).toBe(
      'Translating from German to French… 12 of 40'
    )
    expect(readerTranslateProgress(translation({ progress: null }))).toBe(
      'Translating from German to French…'
    )
  })
})

describe('the Translate row', () => {
  it('is one action row with its glyph that opens the target picker – no menulist beside it; the first preferred language a model reaches is checked, and the pick translates into it at once', async () => {
    desktop()
    const el = render(<TranslateRow tabId="t1" translate={TRANSLATE} translation={null} />)
    expect(el.querySelectorAll('[data-reader-pref]').length).toBe(1)
    expect(el.querySelector('.zen-v2-menulist')).toBeNull()
    const translate = row(el, 'translate')
    expect(translate.tagName).toBe('BUTTON')
    expect(translate.querySelector('.truncate')?.textContent).toBe('Translate')
    expect(translate.querySelector('svg')).not.toBeNull()
    expect(translate.hasAttribute('aria-busy')).toBe(false)
    expect(translate.disabled).toBe(false)
    expect(translate.getAttribute('aria-haspopup')).toBe('listbox')
    expect(translate.getAttribute('aria-expanded')).toBe('false')
    expect(listbox()).toBeNull()
    expect(run).not.toHaveBeenCalled()

    await open(translate)
    expect(translate.getAttribute('aria-expanded')).toBe('true')
    // The languages the models reach, by name, the language's own name under each where it
    // says something the name does not (the shipped table's, §10.2), French checked.
    expect(options().map(optionLabel)).toEqual(['English', 'French', 'German', 'Spanish'])
    expect(
      options().map((o) => o.querySelector('.zen-v2-menulist-option-description')?.textContent)
    ).toEqual([undefined, 'français', 'Deutsch', 'español'])
    expect(optionLabel(checkedOption()!)).toBe('French')

    const spanish = options().find((o) => optionLabel(o) === 'Spanish')!
    act(() => spanish.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'es' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(listbox()).toBeNull()
    expect(translate.getAttribute('aria-expanded')).toBe('false')
  })

  it('an article the page translate found in the first preferred language: the picker opens on the next one, so the pick does not answer "already in"; the picker remembers the pick', async () => {
    desktop()
    const el = render(
      <TranslateRow
        tabId="t1"
        translate={{
          ...TRANSLATE,
          tabs: {
            t1: {
              tabId: 't1',
              status: 'offered',
              source: 'fr',
              confidence: 0.9,
              target: 'en',
              progress: null,
              download: null,
              error: null,
              auto: true,
              dismissed: true
            }
          }
        }}
        translation={null}
      />
    )
    const translate = row(el, 'translate')
    await open(translate)
    expect(optionLabel(checkedOption()!)).toBe('English')
    act(() => options().find((o) => optionLabel(o) === 'German')!.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'de' })
    // The row is still the row (the core has not answered yet); opened again, the pick is checked.
    await open(translate)
    expect(optionLabel(checkedOption()!)).toBe('German')
  })

  it('at work: the busy row with the progress as its second line, a press doing nothing', async () => {
    desktop()
    const el = render(
      <TranslateRow tabId="t1" translate={TRANSLATE} translation={translation()} />
    )
    const translate = row(el, 'translate')
    expect(translate.getAttribute('aria-busy')).toBe('true')
    expect(translate.disabled).toBe(false)
    expect(translate.textContent).toContain('Translating from German to French… 12 of 40')
    await open(translate)
    expect(listbox()).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('failed: the reason in the danger ink under Translate, the press the picker again with the failed target checked – the pick is the retry', async () => {
    desktop()
    const el = render(
      <TranslateRow
        tabId="t1"
        translate={TRANSLATE}
        translation={translation({
          status: 'error',
          target: 'es',
          error: 'no model for German to Spanish'
        })}
      />
    )
    const translate = row(el, 'translate')
    expect(translate.hasAttribute('aria-busy')).toBe(false)
    const reason = translate.querySelector('.zen-settings-danger')
    expect(reason?.textContent).toBe('No model for German to Spanish.')
    await open(translate)
    expect(optionLabel(checkedOption()!)).toBe('Spanish')
    act(() => options().find((o) => optionLabel(o) === 'English')!.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'en' })
  })

  it('translated: the row is the Show original switch row naming the target; on shows the article as written', () => {
    desktop()
    const el = render(
      <TranslateRow
        tabId="t1"
        translate={TRANSLATE}
        translation={translation({ status: 'translated', progress: null })}
      />
    )
    expect(el.querySelector('[data-reader-pref="translate"]')).toBeNull()
    expect(el.querySelectorAll('[data-reader-pref]').length).toBe(1)
    const original = row(el, 'showOriginal')
    expect(original.getAttribute('role')).toBe('switch')
    expect(original.getAttribute('aria-checked')).toBe('false')
    expect(original.textContent).toContain('Show original')
    expect(original.textContent).toContain('Translated into French')
    // A setting row: no glyph (§9.13's control panel carries them on the head's action rows).
    expect(original.querySelector('svg')).toBeNull()
    act(() => original.click())
    expect(run).toHaveBeenCalledWith('translate.readerShowOriginal', {
      tabId: 't1',
      original: true
    })
  })

  it('under a finger the picker is the menulist sheet of radio rows, the target checked', async () => {
    phone()
    const el = render(<TranslateRow tabId="t1" translate={TRANSLATE} translation={null} />)
    const translate = row(el, 'translate')
    expect(translate.getAttribute('aria-haspopup')).toBe('dialog')
    await open(translate)
    const group = document.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Translate into"]'
    )!
    expect(group).not.toBeNull()
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios.length).toBe(4)
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.length).toBe(1)
    expect(checked[0].textContent).toContain('French')
    expect(radios.map((r) => r.textContent?.includes('Deutsch')).filter(Boolean).length).toBe(1)
  })

  it('no language the models reach: the row disabled', () => {
    desktop()
    const el = render(
      <TranslateRow tabId="t1" translate={{ ...TRANSLATE, languages: [] }} translation={null} />
    )
    expect(row(el, 'translate').disabled).toBe(true)
  })
})

describe('the panel’s order', () => {
  /** The rows container's children in order: a hairline as '—', a row as its label. */
  const outline = (el: HTMLElement): string[] =>
    [...el.querySelector('[data-reader-prefs-rows]')!.children].map((child) =>
      child.getAttribute('aria-hidden') === 'true' && child.childElementCount === 0
        ? '—'
        : (child.querySelector('.truncate')?.textContent ?? '?')
    )

  it('Listen and Translate are the head group, each with its glyph, before the type rows’ hairline; the type rows stay whole above the phone sheet’s peek fold (#265, lead rulings 4 and 5)', () => {
    desktop()
    const el = render(
      <Rows
        prefs={DEFAULT_READER_PREFERENCES}
        onChange={() => undefined}
        onListen={() => undefined}
        translate={{ tabId: 't1', translate: TRANSLATE, translation: null }}
      />
    )
    expect(outline(el)).toEqual([
      'Listen to this article',
      'Translate',
      '—',
      'Text size',
      'Font',
      'Colour theme',
      'Column width',
      'Text spacing',
      '—',
      'Line focus',
      'Lines in focus',
      'Syllables'
    ])
    // The head's action rows carry their glyphs together (§10.4's mixing rule within the
    // group): the leading slot is each row's first child. The setting rows carry none: their
    // first child is the text block, a menulist's chevron trailing in the control slot.
    const rows = el.querySelector('[data-reader-prefs-rows]')!
    expect(rows.children[0].querySelector('.lucide-audio-lines')).not.toBeNull()
    expect(rows.children[1].querySelector('.lucide-languages')).not.toBeNull()
    for (const index of [0, 1]) {
      expect(rows.children[index].firstElementChild?.tagName).toBe('SPAN')
      expect(rows.children[index].firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    }
    for (const child of [...rows.children].slice(3)) {
      expect(child.firstElementChild?.tagName).not.toBe('SPAN')
      expect(child.querySelector('.lucide-languages, .lucide-audio-lines')).toBeNull()
    }
  })

  it('Translate alone heads the panel where the article cannot be read aloud', () => {
    desktop()
    const el = render(
      <Rows
        prefs={DEFAULT_READER_PREFERENCES}
        onChange={() => undefined}
        onListen={null}
        translate={{ tabId: 't1', translate: TRANSLATE, translation: null }}
      />
    )
    expect(outline(el).slice(0, 3)).toEqual(['Translate', '—', 'Text size'])
  })

  it('without the engine the type rows run straight into the aids’ hairline', () => {
    desktop()
    const el = render(
      <Rows
        prefs={DEFAULT_READER_PREFERENCES}
        onChange={() => undefined}
        onListen={null}
        translate={null}
      />
    )
    expect(outline(el)).toEqual([
      'Text size',
      'Font',
      'Colour theme',
      'Column width',
      'Text spacing',
      '—',
      'Line focus',
      'Lines in focus',
      'Syllables'
    ])
  })
})

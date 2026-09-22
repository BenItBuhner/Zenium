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
  TranslateRows,
  readerTranslateProgress,
  readerTranslateTarget,
  readerTranslateWorking
} from '../ReaderPreferencesPanel'

/*
 * Translate inside Reader View's text preferences (CT-36): a "Translate into" menulist row over
 * the languages the models reach, the first preferred one chosen, and the action row – Translate
 * with the translate glyph, busy with the progress as its second line while the core works, the
 * reason in the danger ink when it failed (the press the retry) – which gives way to the Show
 * original switch once the article is translated. A pick of another language while translated
 * or at work redoes the translation at once; before that it only sets what Translate will do.
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

const row = (el: HTMLElement, pref: string): HTMLElement =>
  el.querySelector<HTMLElement>(`[data-reader-pref="${pref}"]`)!

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

describe('the Translate rows', () => {
  it('before any translation: the menulist on the first preferred language, the Translate row with its glyph; a press asks the core for that language', () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
    const el = render(<TranslateRows tabId="t1" translate={TRANSLATE} translation={null} />)
    const menulist = el.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    expect(menulist.textContent).toContain('French')
    expect(menulist.disabled).toBe(false)
    const translate = row(el, 'translate')
    expect(translate.tagName).toBe('BUTTON')
    expect(translate.textContent).toContain('Translate')
    expect(translate.hasAttribute('aria-busy')).toBe(false)
    expect(translate.querySelector('svg')).not.toBeNull()
    expect(el.querySelector('[data-reader-pref="showOriginal"]')).toBeNull()
    act(() => translate.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'fr' })
  })

  it('at work: a busy row with the progress as its second line, a press doing nothing', () => {
    const el = render(
      <TranslateRows tabId="t1" translate={TRANSLATE} translation={translation()} />
    )
    const translate = row(el, 'translate')
    expect(translate.getAttribute('aria-busy')).toBe('true')
    expect(translate.textContent).toContain('Translating from German to French… 12 of 40')
    act(() => translate.click())
    expect(run).not.toHaveBeenCalled()
  })

  it('failed: the reason in the danger ink under Translate, the press the retry', () => {
    const el = render(
      <TranslateRows
        tabId="t1"
        translate={TRANSLATE}
        translation={translation({ status: 'error', error: 'this article is already in French' })}
      />
    )
    const translate = row(el, 'translate')
    expect(translate.hasAttribute('aria-busy')).toBe(false)
    const reason = translate.querySelector('.text-\\[var\\(--v2-danger\\)\\]')
    expect(reason?.textContent).toBe('This article is already in French.')
    act(() => translate.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'fr' })
  })

  it('translated: Show original as a switch row naming the source; on shows the article as written', () => {
    const el = render(
      <TranslateRows
        tabId="t1"
        translate={TRANSLATE}
        translation={translation({ status: 'translated', progress: null })}
      />
    )
    expect(el.querySelector('[data-reader-pref="translate"]')).toBeNull()
    const original = row(el, 'showOriginal')
    expect(original.getAttribute('role')).toBe('switch')
    expect(original.getAttribute('aria-checked')).toBe('false')
    expect(original.textContent).toContain('Translated from German')
    act(() => original.click())
    expect(run).toHaveBeenCalledWith('translate.readerShowOriginal', {
      tabId: 't1',
      original: true
    })
  })

  it('a pick while translated redoes the translation into the new language at once; before any translation it only sets what Translate will do', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
    const el = render(
      <TranslateRows
        tabId="t1"
        translate={TRANSLATE}
        translation={translation({ status: 'translated', progress: null })}
      />
    )
    const menulist = el.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await act(async () => {
      menulist.click()
      await Promise.resolve()
    })
    const spanish = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === 'Spanish'
    )!
    act(() => spanish.click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'es' })
    expect(menulist.textContent).toContain('Spanish')
    act(() => root?.unmount())
    host?.remove()
    vi.mocked(run).mockClear()

    const fresh = render(<TranslateRows tabId="t1" translate={TRANSLATE} translation={null} />)
    const list = fresh.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await act(async () => {
      list.click()
      await Promise.resolve()
    })
    const german = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === 'German'
    )!
    act(() => german.click())
    expect(run).not.toHaveBeenCalled()
    expect(list.textContent).toContain('German')
    act(() => row(fresh, 'translate').click())
    expect(run).toHaveBeenCalledWith('translate.reader', { tabId: 't1', target: 'de' })
  })

  it('no language the models reach: both rows disabled', () => {
    const el = render(
      <TranslateRows tabId="t1" translate={{ ...TRANSLATE, languages: [] }} translation={null} />
    )
    expect(el.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.disabled).toBe(true)
    expect((row(el, 'translate') as HTMLButtonElement).disabled).toBe(true)
  })
})

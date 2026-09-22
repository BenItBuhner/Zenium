// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateTabState } from '../../../shared/translate'
import type {
  ByteSource,
  EngineAssets,
  EngineRequest,
  EngineResponse,
  EngineTransport
} from '../../../shared/translateEngine'
import { TRANSLATE_RUNTIME_GLOBAL } from '../../../shared/translateScript'
import { defaultLanguages, sanitizeLanguages } from '../../../shared/languages'
import { DEFAULT_READER_PREFERENCES } from '../../../shared/reader'
import type { Browser } from '../../browser'
import type {
  TabView,
  TranslateHost,
  TranslateModelDownload,
  TranslateModelStore
} from '../../platform'
import { TranslateService, translatablePageUrl } from '../service'
import { ReaderService, type RawArticle } from '../../reader'

/**
 * The service is exercised end to end below the hosts: the page side is the real runtime
 * evaluated against happy-dom (one document, so one tab per test), the engine is a scripted
 * transport that brackets what it translates, the model store lives in memory.
 */

const ASSETS: EngineAssets = { bergamotWasm: 'b', fastTextWasm: 'f', lid: 'l' }
const TAB = 'tab-1'
const PAGE_URL = 'https://ejemplo.es/articulo'

class MemoryStore implements TranslateModelStore {
  files = new Map<string, number>()
  downloads: string[] = []

  async list(): Promise<{ name: string; size: number }[]> {
    return [...this.files].map(([name, size]) => ({ name, size }))
  }

  async download(
    file: TranslateModelDownload,
    onProgress: (received: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.downloads.push(file.name)
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (signal?.aborted) {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    }
    onProgress(Math.floor(file.size / 2))
    onProgress(file.size)
    this.files.set(file.name, file.size)
  }

  async delete(names: string[]): Promise<void> {
    for (const name of names) this.files.delete(name)
  }

  async source(name: string): Promise<ByteSource> {
    return `store://${name}`
  }
}

class FakeTransport implements EngineTransport {
  posted: EngineRequest[] = []
  terminated = 0
  detection: { language: string; confidence: number } = { language: 'es', confidence: 0.98 }
  private listeners: ((message: EngineResponse) => void)[] = []

  post(message: EngineRequest): void {
    this.posted.push(message)
    let result: unknown = null
    if (message.op === 'init') result = { bergamotVersion: 'test' }
    if (message.op === 'translate') result = message.texts.map((text) => `[${text}]`)
    if (message.op === 'detect') result = { ...this.detection, second: null }
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ id: message.id, ok: true, result: result as never })
      }
    })
  }

  onMessage(listener: (message: EngineResponse) => void): void {
    this.listeners.push(listener)
  }

  onError(): void {
    /* the scripted worker never crashes */
  }

  terminate(): void {
    this.terminated++
  }
}

class FakeHost implements TranslateHost {
  readonly models = new MemoryStore()
  readonly locales: readonly string[]
  transports: FakeTransport[] = []
  /** What the next engine's detector answers (the engine is created lazily). */
  detection: { language: string; confidence: number } | null = null

  constructor(locales: readonly string[] = ['en-US']) {
    this.locales = locales
  }

  createEngine(): EngineTransport {
    const transport = new FakeTransport()
    if (this.detection) transport.detection = this.detection
    this.transports.push(transport)
    return transport
  }

  async assets(): Promise<EngineAssets> {
    return ASSETS
  }
}

/** A tab view whose page is the test's document: scripts run against happy-dom. */
class FakeView {
  constructor(public url: string) {}

  async executeJavaScript(script: string): Promise<unknown> {
    return await (new Function(`return ${script}`)() as Promise<unknown> | unknown)
  }
}

interface Harness {
  service: TranslateService
  host: FakeHost
  view: FakeView
  browser: Browser
  written: Map<string, string>
  fetched: string[]
  /** Events the service sent to the chrome (`browser.emit`). */
  emitted: Array<{ name: string; payload: unknown }>
  toasts: string[]
  /** The preferred languages setting as it stands. */
  languages: () => string[]
  reader: ReaderService
  /** Tabs whose read-aloud session was told the reader's text changed. */
  readAloudRestarts: string[]
}

const WINDOW = { id: 'win-1' }

function harness(
  options: {
    locales?: string[]
    stored?: string
    url?: string
    /** The profile's preferred languages (`Settings.languages`); the OS locales' when omitted. */
    languages?: string[]
    /** This load found no languages list and took the OS's (a pre-CT-41 profile). */
    languagesDefaulted?: boolean
  } = {}
): Harness {
  const host = new FakeHost(options.locales)
  const view = new FakeView(options.url ?? PAGE_URL)
  const written = new Map<string, string>()
  const fetched: string[] = []
  const emitted: Array<{ name: string; payload: unknown }> = []
  const toasts: string[] = []
  let present = true
  // The preferred languages setting the service reads its languages-you-read list from, and
  // the `LanguagesService` round trip a change to the rows takes (`set` → `onLanguagesChanged`).
  const state = {
    commitVolatile: vi.fn(),
    commit: vi.fn(),
    languagesDefaulted: options.languagesDefaulted ?? false,
    settings: {
      languages: options.languages ?? defaultLanguages(options.locales ?? ['en-US']),
      reader: structuredClone(DEFAULT_READER_PREFERENCES)
    }
  }
  const readAloudRestarts: string[] = []
  const browser = {
    languages: {
      set: (languages: readonly string[]) => {
        state.settings.languages = sanitizeLanguages(languages, state.settings.languages)
        service.onLanguagesChanged()
      }
    },
    readAloud: {
      onReaderTextChanged: (tabId: string) => {
        readAloudRestarts.push(tabId)
      }
    },
    emit: (name: string, payload: unknown) => {
      emitted.push({ name, payload })
    },
    toast: (message: string) => {
      toasts.push(message)
    },
    platform: {
      translate: host,
      io: {
        readSync: (name: string) => (name === 'translate.json' ? (options.stored ?? null) : null),
        write: async (name: string, text: string) => {
          written.set(name, text)
        },
        writeSync: (name: string, text: string) => {
          written.set(name, text)
        }
      },
      net: {
        fetchText: async (url: string) => {
          fetched.push(url)
          return { ok: false, status: 503, text: '' }
        }
      }
    },
    tabs: {
      tab: (id: string) => (id === TAB && present ? { id, url: view.url, title: 'Tab' } : null),
      view: (id: string) => (id === TAB && present ? (view as unknown as TabView) : null),
      navigate: (id: string, url: string) => {
        if (id === TAB) view.url = url
      },
      windowFor: () => WINDOW,
      close: () => {
        present = false
      }
    },
    state
  } as Record<string, unknown>
  // The real reader service: the article store and the document's rendering the reader
  // translation works through (`articleOf`, `split`, `shown`, `pushShown`).
  browser.reader = new ReaderService(browser as unknown as Browser)
  const service = new TranslateService(browser as unknown as Browser)
  return {
    service,
    host,
    view,
    browser: browser as unknown as Browser,
    reader: browser.reader as ReaderService,
    written,
    fetched,
    emitted,
    toasts,
    readAloudRestarts,
    languages: () => state.settings.languages
  }
}

const SPANISH = `
  <h1>Bienvenidos a la página</h1>
  <p>Este es un párrafo con <a href="/x">un enlace</a> dentro del texto.</p>
  <p>Segundo párrafo, también en español.</p>
  <p translate="no">Marca registrada</p>`

function state(h: Harness): TranslateTabState {
  const tab = h.service.tabState(TAB)
  if (!tab) throw new Error('no tab state')
  return tab
}

async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 2))
  if (!predicate()) throw new Error(`timed out waiting for ${label}`)
}

const paragraphs = (): string[] =>
  [...document.querySelectorAll('h1, p')].map(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  )

let active: TranslateService | null = null

beforeEach(() => {
  document.documentElement.setAttribute('lang', 'es')
  document.documentElement.removeAttribute('translate')
  document.head.innerHTML = ''
  document.body.innerHTML = SPANISH
  delete (globalThis as Record<string, unknown>)[TRANSLATE_RUNTIME_GLOBAL]
})

afterEach(() => {
  active?.stop()
  active = null
})

describe('translatablePageUrl', () => {
  it('accepts web and file documents only: the reader translates on request, never offered', () => {
    expect(translatablePageUrl('https://example.com/')).toBe(true)
    expect(translatablePageUrl('file:///tmp/a.html')).toBe(true)
    expect(translatablePageUrl('zen://reader?url=x')).toBe(false)
    expect(translatablePageUrl('zen://newtab')).toBe(false)
    expect(translatablePageUrl('about:blank')).toBe(false)
  })
})

describe('TranslateService', () => {
  it('reports itself unavailable without a host and refuses commands politely', async () => {
    const h = harness()
    const browser = {
      ...(h.browser as unknown as Record<string, unknown>),
      platform: {
        io: (h.browser.platform as unknown as { io: unknown }).io,
        net: h.browser.platform.net
      }
    }
    const service = new TranslateService(browser as unknown as Browser)
    expect(service.available).toBe(false)
    expect(service.uiState().available).toBe(false)
    service.onPageReady(TAB)
    expect(service.tabState(TAB)).toBeNull()
    await expect(service.downloadModel({ from: 'es', to: 'en' })).rejects.toThrow(/Zenium/)
  })

  it('detects the page language when it is ready and offers a translation', async () => {
    const h = harness()
    active = h.service
    expect(h.service.preferences.preferred).toEqual(['en'])
    h.service.onPageReady(TAB)
    expect(state(h).status).toBe('detecting')
    await until(() => state(h).status === 'offered', 'offer')
    expect(state(h)).toMatchObject({ source: 'es', target: 'en', auto: true, dismissed: false })
    expect(state(h).confidence).toBeGreaterThan(0.9)
    expect(h.host.transports).toHaveLength(1)
    expect(h.host.transports[0].posted.map((m) => m.op)).toEqual(['init', 'detect'])
    const ui = h.service.uiState()
    expect(ui.available).toBe(true)
    expect(ui.tabs[TAB]?.status).toBe('offered')
    expect(ui.languages).toContain('es')
    h.service.dismiss(TAB)
    expect(state(h).dismissed).toBe(true)
  })

  it('does not offer pages in a preferred language, on never-translate sites or with notranslate', async () => {
    const h = harness({ locales: ['es-MX'] })
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status !== 'detecting', 'decision')
    expect(state(h).status).toBe('idle')

    const site = harness()
    active = site.service
    site.service.setPreferences({ neverTranslateSites: ['ejemplo.es'] })
    site.service.onPageReady(TAB)
    expect(site.service.tabState(TAB)).toBeNull()

    document.documentElement.setAttribute('translate', 'no')
    const marked = harness()
    active = marked.service
    marked.service.onPageReady(TAB)
    await until(() => state(marked).status !== 'detecting', 'decision')
    expect(state(marked).status).toBe('idle')
    expect(state(marked).source).toBeNull()
  })

  it('stays quiet when auto-offer is off and nothing is on the always list', () => {
    const h = harness()
    active = h.service
    h.service.setPreferences({ autoOffer: false })
    h.service.onPageReady(TAB)
    expect(h.service.tabState(TAB)).toBeNull()
  })

  it('translates the page: downloads the models, translates viewport first, reverts', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    const seen: string[] = []
    ;(h.browser.state.commitVolatile as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const current = h.service.tabState(TAB)
      if (current && seen.at(-1) !== current.status) seen.push(current.status)
    })
    await h.service.translatePage(TAB)
    expect(seen).toEqual(['downloading', 'translating', 'translated'])
    expect(state(h)).toMatchObject({
      status: 'translated',
      source: 'es',
      target: 'en',
      download: null,
      error: null,
      auto: false
    })
    expect(state(h).progress).toEqual({ done: 3, total: 3 })
    expect(h.host.models.downloads).toEqual(
      expect.arrayContaining([expect.stringMatching(/^es_en_/)])
    )
    expect(paragraphs()).toEqual([
      '[Bienvenidos a la página]',
      '[Este es un párrafo con un enlace dentro del texto.]',
      '[Segundo párrafo, también en español.]',
      'Marca registrada'
    ])
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/x')
    const transport = h.host.transports[0]
    const loads = transport.posted.filter((m) => m.op === 'load')
    expect(loads).toHaveLength(1)
    expect(loads[0]).toMatchObject({ pair: { from: 'es', to: 'en' } })
    const translated = transport.posted.filter((m) => m.op === 'translate')
    expect(translated[0]).toMatchObject({ html: true })
    expect(h.service.uiState().installed.map((m) => `${m.from}-${m.to}`)).toEqual(['es-en'])
    const models = h.service.modelInfo()
    expect(models.length).toBeGreaterThan(20)
    expect(models.filter((m) => m.installed).map((m) => `${m.from}-${m.to}`)).toEqual(['es-en'])
    expect(models.find((m) => m.from === 'en' && m.to === 'es')).toMatchObject({
      installed: false,
      bytes: expect.any(Number)
    })

    h.service.revert(TAB)
    expect(state(h)).toMatchObject({ status: 'offered', progress: null, error: null })
    await until(() => paragraphs()[0] === 'Bienvenidos a la página', 'revert')
    expect(paragraphs()).toEqual([
      'Bienvenidos a la página',
      'Este es un párrafo con un enlace dentro del texto.',
      'Segundo párrafo, también en español.',
      'Marca registrada'
    ])
  })

  it('keeps translating content the page adds later', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    await h.service.translatePage(TAB)
    const added = document.createElement('p')
    added.textContent = 'Nuevo contenido cargado después.'
    document.body.appendChild(added)
    await until(() => added.textContent === '[Nuevo contenido cargado después.]', 'late content')
    expect(state(h).status).toBe('translated')
    expect(state(h).progress).toEqual({ done: 4, total: 4 })
  })

  it('pivots through English when no direct model exists', async () => {
    const h = harness({ locales: ['de-DE'] })
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    expect(state(h).target).toBe('de')
    await h.service.translatePage(TAB)
    const loads = h.host.transports[0].posted.filter((m) => m.op === 'load')
    expect(loads.map((m) => (m.op === 'load' ? `${m.pair.from}-${m.pair.to}` : ''))).toEqual([
      'es-en',
      'en-de'
    ])
    const translated = h.host.transports[0].posted.find((m) => m.op === 'translate')
    expect(translated).toMatchObject({
      route: [
        { from: 'es', to: 'en' },
        { from: 'en', to: 'de' }
      ]
    })
  })

  it('translates without asking for languages on the always list and honours the never list', async () => {
    const h = harness()
    active = h.service
    h.service.setLanguageRule('es', 'always')
    expect(h.service.preferences.alwaysTranslate).toEqual(['es'])
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'translated', 'auto translation')
    expect(state(h).auto).toBe(true)
    h.service.stop()

    document.body.innerHTML = SPANISH
    const never = harness()
    active = never.service
    never.service.setLanguageRule('es', 'never')
    never.service.onPageReady(TAB)
    await until(() => state(never).status !== 'detecting', 'decision')
    expect(state(never).status).toBe('idle')
  })

  it('reports an error state when there is no model for the requested pair', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    await expect(h.service.translatePage(TAB, { target: 'xx' })).rejects.toThrow(
      /no translation model/
    )
    expect(state(h)).toMatchObject({ status: 'error', error: expect.stringContaining('es to xx') })
    await expect(h.service.translatePage(TAB, { source: 'xx' })).rejects.toThrow(/Zenium/)
    h.service.revert(TAB)
    expect(state(h).status).toBe('offered')
    expect(state(h).error).toBeNull()
  })

  it('resets its state for a new document and keeps it across same-document navigations', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    h.view.url = 'https://ejemplo.es/articulo#seccion'
    h.service.onNavigated(TAB)
    await new Promise((r) => setTimeout(r, 5))
    expect(state(h).status).toBe('offered')

    // A fresh document has no runtime: the state goes away until its dom-ready samples it again.
    delete (globalThis as Record<string, unknown>)[TRANSLATE_RUNTIME_GLOBAL]
    h.view.url = 'https://ejemplo.es/otra'
    h.service.onNavigated(TAB)
    await until(() => h.service.tabState(TAB) === null, 'reset')
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer again')
  })

  it('translates a selection, detecting its language on its own', async () => {
    const h = harness()
    active = h.service
    const result = await h.service.translateSelection(TAB, { text: '  Hola   mundo ' })
    expect(result).toEqual({
      text: 'Hola mundo',
      source: 'es',
      target: 'en',
      translation: '[Hola mundo]'
    })
    const translated = h.host.transports[0].posted.find((m) => m.op === 'translate')
    expect(translated).toMatchObject({ html: false })
    expect(await h.service.translateSelection(TAB, { text: '   ' })).toBeNull()
  })

  it('falls back to the page language for a selection the detector is unsure about', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    h.host.transports[0].detection = { language: 'gl', confidence: 0.3 }
    const result = await h.service.translateSelection(TAB, { text: 'Bo día' })
    expect(result?.source).toBe('es')
  })

  it('hands a selection already in the only preferred language back untranslated', async () => {
    const h = harness()
    active = h.service
    h.host.detection = { language: 'en', confidence: 0.99 }
    const result = await h.service.translateSelection(TAB, { text: 'Already in English.' })
    expect(result).toEqual({
      text: 'Already in English.',
      source: 'en',
      target: 'en',
      translation: 'Already in English.'
    })
    expect(h.host.transports[0].posted.find((m) => m.op === 'translate')).toBeUndefined()
  })

  it('persists preferences (and only a refreshed registry) to translate.json', async () => {
    const h = harness()
    active = h.service
    h.service.setLanguageRule('fr', 'always')
    h.service.setSiteRule(TAB, true)
    h.service.setPreferences({ preferred: ['en', 'de'] })
    await h.service.flushSync()
    const stored = JSON.parse(h.written.get('translate.json') ?? '{}') as {
      preferences: { alwaysTranslate: string[]; neverTranslateSites: string[]; preferred: string[] }
      registry: unknown
    }
    expect(stored.preferences.alwaysTranslate).toEqual(['fr'])
    expect(stored.preferences.neverTranslateSites).toEqual(['ejemplo.es'])
    expect(stored.preferences.preferred).toEqual(['en', 'de'])
    expect(stored.registry).toBeNull()

    const reloaded = harness({ stored: h.written.get('translate.json') })
    active = reloaded.service
    expect(reloaded.service.preferences.alwaysTranslate).toEqual(['fr'])
    expect(reloaded.service.preferences.neverTranslateSites).toEqual(['ejemplo.es'])
  })

  it('asks Remote Settings for a fresher registry on start and survives a failed fetch', async () => {
    const h = harness()
    active = h.service
    h.service.start()
    await until(() => h.fetched.length === 1, 'registry fetch')
    expect(h.fetched[0]).toMatch(/^https:\/\/firefox\.settings\.services\.mozilla\.com\//)
    expect(h.service.registry.fetchedAt).toBe(0)
    expect(h.service.uiState().registryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('puts the offer up on request, ignoring the never rules, and only re-shows a running one', async () => {
    const h = harness()
    active = h.service
    // A page in a never-translate language stays idle on load; the user asks anyway.
    h.service.setLanguageRule('es', 'never')
    h.service.onPageReady(TAB)
    await until(() => state(h).status !== 'detecting', 'decision')
    expect(state(h).status).toBe('idle')
    await h.service.offer(TAB)
    expect(state(h)).toMatchObject({ status: 'offered', source: 'es', target: 'en', auto: false })
    // Dismissed, then asked again: the bar comes back.
    h.service.dismiss(TAB)
    await h.service.offer(TAB)
    expect(state(h).dismissed).toBe(false)
    // A finished translation only gets its bar shown again.
    h.service.setLanguageRule('es', 'ask')
    await h.service.translatePage(TAB)
    h.service.dismiss(TAB)
    await h.service.offer(TAB)
    expect(state(h)).toMatchObject({ status: 'translated', dismissed: false })
  })

  it('offers without a source for a page whose language it cannot tell', async () => {
    const h = harness()
    active = h.service
    h.service.setPreferences({ autoOffer: false })
    h.host.detection = { language: 'xx', confidence: 0.2 }
    document.body.innerHTML = '<p>ab</p>'
    document.documentElement.removeAttribute('lang')
    await h.service.offer(TAB)
    expect(state(h)).toMatchObject({ status: 'offered', source: null, target: 'en' })
    h.service.retarget(TAB, { source: 'fr' })
    expect(state(h)).toMatchObject({ source: 'fr', confidence: null })
  })

  it('open() answers other pages with a toast instead of an error', async () => {
    const h = harness({ url: 'zen://newtab' })
    active = h.service
    await expect(h.service.offer(TAB)).rejects.toThrow(/cannot be translated/)
    await h.service.open(TAB)
    expect(h.toasts).toEqual(['This page cannot be translated.'])
    expect(h.service.tabState(TAB)).toBeNull()
    expect(h.service.canTranslate(TAB)).toBe(false)
  })

  it('retargets an offer to supported languages only', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    h.service.retarget(TAB, { target: 'de' })
    expect(state(h).target).toBe('de')
    h.service.retarget(TAB, { target: 'xx', source: 'yy' })
    expect(state(h)).toMatchObject({ source: 'es', target: 'de' })
    expect(state(h).confidence).toBeGreaterThan(0.9)
    h.service.retarget(TAB, { source: 'pt' })
    expect(state(h)).toMatchObject({ source: 'pt', confidence: null, target: 'de' })
  })

  it('takes an offer down when its language is put on the never list', async () => {
    const h = harness()
    active = h.service
    h.service.onPageReady(TAB)
    await until(() => state(h).status === 'offered', 'offer')
    h.service.setLanguageRule('de', 'never')
    expect(state(h).status).toBe('offered')
    h.service.setLanguageRule('es', 'never')
    expect(state(h).status).toBe('idle')
    expect(h.service.languageRule('es')).toBe('never')
    expect(h.service.siteOf(TAB)).toBe('ejemplo.es')
    expect(h.service.canTranslate(TAB)).toBe(true)
  })

  it('asks the chrome to show the selection popover with the text or the page selection', async () => {
    const h = harness()
    active = h.service
    await h.service.showSelection(TAB, '  Hola \n mundo  ', { x: 10, y: 20 })
    expect(h.emitted).toEqual([
      {
        name: 'translate.selection',
        payload: { tabId: TAB, text: 'Hola mundo', x: 10, y: 20 }
      }
    ])
    // Nothing selected on the page and no text given: nothing to show.
    await h.service.showSelection(TAB)
    expect(h.emitted).toHaveLength(1)
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('h1') as Node)
    document.getSelection()?.addRange(range)
    await h.service.showSelection(TAB)
    expect(h.emitted[1]).toEqual({
      name: 'translate.selection',
      payload: { tabId: TAB, text: 'Bienvenidos a la página', x: null, y: null }
    })
  })

  it('drops the engine on stop and starts a fresh one afterwards', async () => {
    const h = harness()
    active = h.service
    await h.service.translateSelection(TAB, { text: 'Hola mundo' })
    expect(h.host.transports).toHaveLength(1)
    h.service.stop()
    expect(h.host.transports[0].terminated).toBe(1)
    await h.service.translateSelection(TAB, { text: 'Hola mundo' })
    expect(h.host.transports).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Reader View (CT-36)
// ---------------------------------------------------------------------------

const ARTICLE: RawArticle = {
  title: 'Un título',
  byline: 'Autora',
  content: `<div><p>Este es un párrafo con <a href="/x">un enlace</a> dentro del texto.</p>
<h2>Segundo título</h2>
<pre>código intacto</pre>
<ul><li>Primero</li><li>Segundo con <code>código</code> dentro</li></ul></div>`,
  length: 120,
  lang: 'es'
}

/**
 * Put the tab in Reader View on the article and render its document into the test's DOM (with
 * the document's own script, so `window.zenReaderShow` is the real one).
 */
function openReader(h: Harness, raw: RawArticle = ARTICLE): string {
  h.reader.open(TAB, raw)
  const id = new URL(h.view.url).searchParams.get('id') as string
  renderReader(h, id)
  return id
}

function renderReader(h: Harness, id: string): void {
  const html = h.reader.pageHtml(id) as string
  const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
  document.body.innerHTML = `<main>${main}</main>`
  delete (window as unknown as Record<string, unknown>).zenReaderShow
  new Function(script)()
}

const shownUnits = (): string[] =>
  [...document.querySelectorAll('main > article [data-zu]')].map((el) => el.innerHTML)

describe('TranslateService reader (CT-36)', () => {
  it('never offers on a reader tab and points the menu at the Text preferences', async () => {
    const h = harness()
    active = h.service
    openReader(h)
    expect(h.view.url.startsWith('zen://reader?id=')).toBe(true)
    expect(h.service.canTranslate(TAB)).toBe(false)
    h.service.onPageReady(TAB)
    expect(h.service.tabState(TAB)).toBeNull()
    await h.service.open(TAB)
    expect(h.toasts).toEqual(['Translate this article from the reader’s Text preferences.'])
    await expect(h.service.translatePage(TAB)).rejects.toThrow(/cannot be translated/)
  })

  it('translates the article in the core and swaps the units into the open document', async () => {
    const h = harness()
    active = h.service
    const id = openReader(h)
    expect(shownUnits()).toEqual([
      'Este es un párrafo con <a href="/x">un enlace</a> dentro del texto.',
      'Segundo título',
      'Primero',
      'Segundo con <code>código</code> dentro'
    ])
    await h.service.translateReader(TAB)
    const state = h.service.readerState(TAB)
    expect(state).toMatchObject({
      status: 'translated',
      source: 'es',
      target: 'en',
      progress: { done: 4, total: 4 },
      showOriginal: false,
      error: null
    })
    // The engine saw the runtime's shape of every unit (inline elements as markers), plus the title.
    const sent = h.host.transports[0].posted.filter((m) => m.op === 'translate')
    expect(sent.map((m) => (m as { texts: string[] }).texts)).toEqual([
      [
        'Este es un párrafo con <span data-zt="0">un enlace</span> dentro del texto.',
        'Segundo título',
        'Primero',
        'Segundo con <img data-zt="0"> dentro'
      ],
      ['Un título']
    ])
    expect(shownUnits()).toEqual([
      '[Este es un párrafo con <a href="/x">un enlace</a> dentro del texto.]',
      '[Segundo título]',
      '[Primero]',
      '[Segundo con <code>código</code> dentro]'
    ])
    expect(document.querySelector('main > header h1')?.textContent).toBe('[Un título]')
    expect(document.title).toBe('[Un título]')
    expect(document.documentElement.lang).toBe('en')
    expect(document.querySelector('pre')?.textContent).toBe('código intacto')
    // A reload renders the translation from the core.
    const reloaded = h.reader.pageHtml(id) as string
    expect(reloaded).toContain('<span data-zu="1">[Segundo título]</span>')
    expect(reloaded).toContain('<title>[Un título]</title>')
    expect(reloaded).toContain('lang="en"')
    expect(h.service.uiState().reader?.[TAB]?.status).toBe('translated')
    expect(h.readAloudRestarts).toEqual([TAB])
  })

  it('shows the original and the translation again on the toggle, the translation kept', async () => {
    const h = harness()
    active = h.service
    const id = openReader(h)
    await h.service.translateReader(TAB)
    const translations = h.host.transports[0].posted.filter((m) => m.op === 'translate').length
    h.service.showReaderOriginal(TAB, true)
    expect(h.service.readerState(TAB)?.showOriginal).toBe(true)
    expect(shownUnits()[1]).toBe('Segundo título')
    expect(document.querySelector('main > header h1')?.textContent).toBe('Un título')
    expect(document.documentElement.lang).toBe('es')
    expect(h.reader.pageHtml(id)).toContain('<span data-zu="1">Segundo título</span>')
    // Asked to translate again into the same language: the kept translation shows, no engine work.
    await h.service.translateReader(TAB)
    expect(h.service.readerState(TAB)?.showOriginal).toBe(false)
    expect(shownUnits()[1]).toBe('[Segundo título]')
    expect(h.host.transports[0].posted.filter((m) => m.op === 'translate')).toHaveLength(
      translations
    )
    // Read aloud on the tab followed each change of what is shown.
    expect(h.readAloudRestarts).toEqual([TAB, TAB, TAB])
  })

  it('redoes the translation for another target and drops it when the tab leaves the article', async () => {
    const h = harness()
    active = h.service
    const id = openReader(h)
    await h.service.translateReader(TAB)
    await h.service.translateReader(TAB, { target: 'de' })
    expect(h.service.readerState(TAB)).toMatchObject({ status: 'translated', target: 'de' })
    expect(h.reader.article(id)?.translation?.target).toBe('de')
    h.view.url = PAGE_URL
    h.service.onNavigated(TAB)
    expect(h.service.readerState(TAB)).toBeNull()
    expect(h.reader.article(id)?.translation).toBeNull()
    expect(h.service.uiState().reader).toEqual({})
  })

  it('refuses what it cannot do with the page translation’s messages', async () => {
    const h = harness()
    active = h.service
    await expect(h.service.translateReader(TAB)).rejects.toThrow(/cannot be translated/)
    openReader(h)
    await expect(h.service.translateReader(TAB, { target: 'es' })).rejects.toThrow(/already in es/)
    expect(h.service.readerState(TAB)?.status).toBe('error')
    await expect(h.service.translateReader(TAB, { source: 'xx' })).rejects.toThrow(
      /no translation model/
    )
  })

  it('takes the first preferred language as the target', async () => {
    const h = harness({ languages: ['de-DE', 'en'] })
    active = h.service
    openReader(h)
    await h.service.translateReader(TAB)
    expect(h.service.readerState(TAB)).toMatchObject({ source: 'es', target: 'de' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTRACT_TIMEOUT_MS, ReadAloudService, wordEnd } from '../readAloud'
import type { Browser } from '../browser'
import type { PageHostMessage, SpeechHost, SpeechHostEvent, SpeechUtteranceOptions } from '../platform'
import type { ReaderArticle } from '../reader'
import {
  sanitizeReadAloudSettings,
  type ReadAloudExtractedBlock,
  type ReadAloudExtractRequest,
  type ReadAloudHighlightMessage,
  type ReadAloudSettings,
  type ReadAloudVoice
} from '../../shared/readAloud'

// ---------------------------------------------------------------------------
// The scripted speech host
// ---------------------------------------------------------------------------

interface Spoken {
  id: string
  text: string
  options: SpeechUtteranceOptions
}

class FakeHost implements SpeechHost {
  voiceList: ReadAloudVoice[] = [
    { id: 'Samantha', name: 'Samantha', lang: 'en-US', local: true },
    { id: 'Daniel', name: 'Daniel', lang: 'en-GB', local: true },
    { id: 'Amélie', name: 'Amélie', lang: 'fr-CA', local: true }
  ]
  spoken: Spoken[] = []
  preparedList: Spoken[] = []
  stops = 0
  pauses = 0
  resumes = 0
  private listeners: Array<(id: string, event: SpeechHostEvent) => void> = []
  private voicesListeners: Array<() => void> = []
  pause?: () => void
  resume?: () => void
  prepare?: (id: string, text: string, options: SpeechUtteranceOptions) => void

  constructor(options: { pause?: boolean; prepare?: boolean } = {}) {
    if (options.pause !== false) {
      this.pause = () => {
        this.pauses++
      }
      this.resume = () => {
        this.resumes++
      }
    }
    if (options.prepare) {
      this.prepare = (id, text, opts) => {
        this.preparedList.push({ id, text, options: opts })
      }
    }
  }

  voices(): Promise<ReadAloudVoice[]> {
    return Promise.resolve(this.voiceList)
  }
  onVoicesChanged(listener: () => void): void {
    this.voicesListeners.push(listener)
  }
  changeVoices(voices: ReadAloudVoice[]): void {
    this.voiceList = voices
    for (const l of this.voicesListeners) l()
  }
  speak(id: string, text: string, options: SpeechUtteranceOptions): void {
    this.spoken.push({ id, text, options })
  }
  stop(): void {
    this.stops++
  }
  onEvent(listener: (id: string, event: SpeechHostEvent) => void): void {
    this.listeners.push(listener)
  }

  /** The utterance the host is speaking (the last `speak`). */
  get current(): Spoken {
    return this.spoken[this.spoken.length - 1]
  }
  emit(id: string, event: SpeechHostEvent): void {
    for (const l of this.listeners) l(id, event)
  }
  start(id = this.current.id): void {
    this.emit(id, { type: 'start' })
  }
  word(charIndex: number, length?: number, id = this.current.id): void {
    const event: SpeechHostEvent = { type: 'word', charIndex }
    if (length !== undefined) event.length = length
    this.emit(id, event)
  }
  end(id = this.current.id): void {
    this.emit(id, { type: 'end' })
  }
  error(message: string, id = this.current.id): void {
    this.emit(id, { type: 'error', message })
  }
}

// ---------------------------------------------------------------------------
// The browser around the service
// ---------------------------------------------------------------------------

interface FakeTab {
  id: string
  url: string
  title: string
  readerable: boolean
}

interface FakeView {
  destroyed: boolean
  posted: PageHostMessage[]
  inserted: string[]
  removed: string[]
  scripts: string[]
  scriptResult: unknown
  isDestroyed(): boolean
  postToPage(message: PageHostMessage): void
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
}

interface Harness {
  service: ReadAloudService
  host: FakeHost
  tabs: Map<string, FakeTab>
  views: Map<string, FakeView>
  articles: Map<string, ReaderArticle>
  settings: () => ReadAloudSettings
  commits: { persisted: number; volatile: number }
  translate: { source: string | null; preferred: string[] }
  readability: string | null
  addTab(id: string, url: string, title?: string): FakeView
  /** The extraction requests the page script would have seen for a tab. */
  extractRequests(tabId: string): ReadAloudExtractRequest[]
  highlights(tabId: string): ReadAloudHighlightMessage[]
  /** Answer the latest extraction request of a tab as the page script would. */
  answer(tabId: string, blocks: Array<Partial<ReadAloudExtractedBlock> & { text: string }>, extra?: { title?: string; lang?: string }): void
}

const PAGE = 'https://example.com/article'

function harness(options: { host?: FakeHost | null } = {}): Harness {
  const tabs = new Map<string, FakeTab>()
  const views = new Map<string, FakeView>()
  const articles = new Map<string, ReaderArticle>()
  const host = options.host === undefined ? new FakeHost() : options.host
  const commits = { persisted: 0, volatile: 0 }
  const translate = { source: null as string | null, preferred: ['en'] }
  const state = {
    settings: { readAloud: sanitizeReadAloudSettings(undefined) },
    commit: () => {
      commits.persisted++
    },
    commitVolatile: () => {
      commits.volatile++
    }
  }
  const h: Partial<Harness> & { readability: string | null } = { readability: null }
  const browser = {
    platform: {
      speech: host ?? undefined,
      readabilitySource: () => h.readability
    },
    tabs: {
      tab: (id: string) => tabs.get(id),
      view: (id: string) => views.get(id)
    },
    reader: {
      isReaderUrl: (url: string) => url.startsWith('zen://reader'),
      originalUrl: (url: string) => {
        try {
          return new URL(url).searchParams.get('url')
        } catch {
          return null
        }
      },
      article: (id: string) => articles.get(id)
    },
    translate: {
      tabState: () => (translate.source ? { source: translate.source } : null),
      uiState: () => ({ preferences: { preferred: translate.preferred } })
    },
    state,
    updateMedia: vi.fn()
  }
  const service = new ReadAloudService(browser as unknown as Browser)
  const requestsOf = (tabId: string): ReadAloudExtractRequest[] =>
    (views.get(tabId)?.posted ?? []).filter(
      (m): m is ReadAloudExtractRequest => m.type === 'readAloud' && m.action === 'extract'
    )
  return Object.assign(h, {
    service,
    host: host as FakeHost,
    tabs,
    views,
    articles,
    settings: () => state.settings.readAloud,
    commits,
    translate,
    addTab: (id, url, title = 'Title') => {
      const view: FakeView = {
        destroyed: false,
        posted: [],
        inserted: [],
        removed: [],
        scripts: [],
        scriptResult: null,
        isDestroyed: () => view.destroyed,
        postToPage: (m) => view.posted.push(m),
        insertCSS: async (css) => {
          view.inserted.push(css)
          return `css${view.inserted.length}`
        },
        removeInsertedCSS: async (key) => {
          view.removed.push(key)
        },
        executeJavaScript: async (code) => {
          view.scripts.push(code)
          return view.scriptResult
        }
      }
      views.set(id, view)
      tabs.set(id, { id, url, title, readerable: false })
      return view
    },
    extractRequests: requestsOf,
    highlights: (tabId) =>
      (views.get(tabId)?.posted ?? []).filter(
        (m): m is ReadAloudHighlightMessage => m.type === 'readAloud' && m.action === 'highlight'
      ),
    answer: (tabId, blocks, extra = {}) => {
      const requests = requestsOf(tabId)
      const request = requests[requests.length - 1]
      service.handleMessage(tabId, {
        requestId: request.requestId,
        title: extra.title ?? 'Page title',
        lang: extra.lang ?? 'en',
        blocks: blocks.map((b, i) => ({
          id: b.id ?? `b${i}`,
          kind: b.kind ?? 'paragraph',
          text: b.text,
          ...(b.lang ? { lang: b.lang } : {}),
          at: b.at ?? { path: [1, i], run: 0, offset: 0 }
        }))
      })
    }
  }) as Harness
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/** Start on a three-paragraph page and let the page script answer; playing the first sentence. */
async function playing(h: Harness, tabId = 't1'): Promise<void> {
  h.addTab(tabId, PAGE)
  const started = h.service.start({ tabId })
  await flush()
  h.answer(tabId, [
    { text: 'First one. First two.' },
    { text: 'Second block.', kind: 'heading' },
    { text: 'Third one. Third two. Third three.' }
  ])
  await started
}

describe('ReadAloudService', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('start', () => {
    it('shows loading, asks the page for its text, resolves the voice and speaks the first sentence', async () => {
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      expect(h.service.uiState()).toMatchObject({ tabId: 't1', status: 'loading', source: 'page', sentenceIndex: -1 })
      await flush()
      const requests = h.extractRequests('t1')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ from: 'top', keep: null })
      h.answer('t1', [{ text: 'Hello world. Second sentence.' }, { text: 'Next block.' }], { title: 'Doc', lang: 'en-GB' })
      await started
      expect(h.service.uiState()).toEqual({
        tabId: 't1',
        status: 'playing',
        source: 'page',
        title: 'Doc',
        lang: 'en-gb',
        sentenceIndex: 0,
        sentenceCount: 3,
        word: null,
        rate: 1,
        voiceId: 'Daniel',
        highlight: 'both'
      })
      expect(h.host.spoken).toHaveLength(1)
      expect(h.host.current).toMatchObject({
        text: 'Hello world.',
        options: { voiceId: 'Daniel', lang: 'en-gb', rate: 1 }
      })
      // The highlight: the sentence within its block, at the block's position, styled once.
      expect(h.highlights('t1')).toEqual([
        {
          type: 'readAloud',
          action: 'highlight',
          tabId: 't1',
          blockId: 'b0',
          at: { path: [1, 0], run: 0, offset: 0 },
          sentence: { start: 0, end: 12 },
          word: null,
          mode: 'both'
        }
      ])
      expect(h.views.get('t1')!.inserted).toHaveLength(1)
      expect(h.views.get('t1')!.inserted[0]).toContain('::highlight(zenium-read-sentence)')
    })

    it('falls back to the translate engine’s detection, then the UI language, for an untagged document', async () => {
      h.translate.source = 'fr'
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Bonjour.' }], { lang: '' })
      await started
      expect(h.service.uiState()).toMatchObject({ lang: 'fr', voiceId: 'Amélie' })
    })

    it('reads a document in a language without a voice with the UI language’s voice', async () => {
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hallo Welt.' }], { lang: 'de' })
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'playing', lang: 'de', voiceId: 'Samantha' })
      expect(h.service.uiState()!.error).toBeUndefined()
    })

    it('fails with no-voice when the host has none at all, and speaks once a voice is chosen', async () => {
      h.host.voiceList = []
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice', voiceId: null })
      expect(h.host.spoken).toHaveLength(0)
      h.host.changeVoices([{ id: 'Late', name: 'Late', lang: 'en', local: true }])
      h.service.setVoice({ voiceId: 'Late' })
      expect(h.service.uiState()).toMatchObject({ status: 'playing', voiceId: 'Late', sentenceIndex: 0 })
      expect(h.host.current.options.voiceId).toBe('Late')
    })

    it('fails with no-text when the page has nothing to read or never answers', async () => {
      h.addTab('t1', PAGE)
      let started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: '   ' }])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-text' })

      vi.useFakeTimers()
      h.addTab('t2', PAGE)
      started = h.service.start({ tabId: 't2' })
      await flush()
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'loading' })
      await vi.advanceTimersByTimeAsync(EXTRACT_TIMEOUT_MS + 1)
      await started
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'error', error: 'no-text' })
    })

    it('reports unavailable without a speech host', async () => {
      const bare = harness({ host: null })
      expect(bare.service.available).toBe(false)
      bare.addTab('t1', PAGE)
      await bare.service.start({ tabId: 't1' })
      expect(bare.service.uiState()).toMatchObject({ status: 'error', error: 'unavailable' })
    })

    it('starts from the selection, and from a named sentence', async () => {
      h.addTab('t1', PAGE)
      let started = h.service.start({ tabId: 't1', from: 'selection' })
      await flush()
      expect(h.extractRequests('t1')[0]).toMatchObject({ from: 'selection' })
      h.answer('t1', [{ text: 'lected text. And more.', at: { path: [1, 3], run: 0, offset: 14 } }])
      await started
      expect(h.service.uiState()).toMatchObject({ source: 'selection', sentenceIndex: 0, sentenceCount: 2 })
      expect(h.highlights('t1')[0].at).toEqual({ path: [1, 3], run: 0, offset: 14 })

      started = h.service.start({ tabId: 't1', from: { blockId: 'b2', sentenceIndex: 1 } })
      await flush()
      h.answer('t1', [{ text: 'A. B.' }, { text: 'C.' }, { text: 'D. E. F.' }])
      await started
      // The block's second sentence: global index 4.
      expect(h.service.uiState()).toMatchObject({ sentenceIndex: 4 })
      expect(h.host.current.text).toBe('E.')

      started = h.service.start({ tabId: 't1', from: { blockId: 'b2', sentenceIndex: 6 } })
      await flush()
      h.answer('t1', [{ text: 'A. B.' }, { text: 'C.' }, { text: 'D. E. F.' }])
      await started
      // Out of the block's range and not a global match: the block's first sentence.
      expect(h.service.uiState()).toMatchObject({ sentenceIndex: 3 })
    })

    it('runs Readability on a readerable page and hands the page script the kept texts', async () => {
      h.readability = '/* Readability */'
      const view = h.addTab('t1', PAGE)
      h.tabs.get('t1')!.readerable = true
      view.scriptResult = { content: '<p>Kept one.</p><div><p>Kept two.</p></div>', lang: 'en' }
      const started = h.service.start({ tabId: 't1' })
      await flush()
      expect(view.scripts).toHaveLength(1)
      expect(view.scripts[0]).toContain('/* Readability */')
      expect(h.extractRequests('t1')[0].keep).toEqual(['Kept one.', 'Kept two.'])
      h.answer('t1', [{ text: 'Kept one.' }])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'playing' })
    })

    it('reads the reader article from its HTML, without a page round trip and without inserting CSS', async () => {
      h.articles.set('a1', {
        id: 'a1',
        url: PAGE,
        title: 'The article',
        byline: null,
        siteName: null,
        excerpt: null,
        content: '<h2>Head</h2><p>Body one. Body two.</p><ul><li lang="fr">Bonjour</li></ul>',
        length: 40,
        lang: 'en',
        dir: null
      })
      const view = h.addTab('t1', `zen://reader?id=a1&url=${encodeURIComponent(PAGE)}`)
      await h.service.start({ tabId: 't1' })
      expect(h.extractRequests('t1')).toHaveLength(0)
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        source: 'reader',
        title: 'The article',
        lang: 'en',
        sentenceCount: 4,
        voiceId: 'Samantha'
      })
      expect(h.host.current.text).toBe('Head')
      expect(h.highlights('t1')[0]).toMatchObject({ blockId: 'b0', at: null, sentence: { start: 0, end: 4 } })
      expect(view.inserted).toHaveLength(0)
      // The French list item speaks with the French voice; the document's language stays.
      h.host.end()
      h.host.end()
      h.host.end()
      expect(h.host.current).toMatchObject({ text: 'Bonjour', options: { voiceId: 'Amélie', lang: 'fr' } })
      expect(h.service.uiState()).toMatchObject({ voiceId: 'Amélie', lang: 'en' })
    })

    it('a second start on another tab ends the first session', async () => {
      await playing(h, 't1')
      h.addTab('t2', PAGE)
      const started = h.service.start({ tabId: 't2' })
      expect(h.host.stops).toBe(1)
      const cleared = h.highlights('t1').at(-1)!
      expect(cleared.mode).toBe('off')
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'loading' })
      await flush()
      h.answer('t2', [{ text: 'Other.' }])
      await started
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'playing' })
      await flush()
      expect(h.views.get('t1')!.removed).toEqual(['css1'])
    })
  })

  describe('playback', () => {
    beforeEach(async () => {
      await playing(h)
    })

    it('follows word events within the sentence and paints them', () => {
      h.host.start()
      h.host.word(6, 4)
      expect(h.service.uiState()!.word).toEqual({ start: 6, end: 10 })
      expect(h.highlights('t1').at(-1)).toMatchObject({ sentence: { start: 0, end: 10 }, word: { start: 6, end: 10 } })
      // Without a length the word runs to the next space.
      h.host.word(0)
      expect(h.service.uiState()!.word).toEqual({ start: 0, end: 5 })
      // Out of range: clamped, or nothing.
      h.host.word(99, 3)
      expect(h.service.uiState()!.word).toBeNull()
    })

    it('moves to the next sentence on end, across blocks, and ends after the last', () => {
      expect(h.host.current.text).toBe('First one.')
      h.host.end()
      expect(h.service.uiState()).toMatchObject({ sentenceIndex: 1, word: null, status: 'playing' })
      expect(h.host.current.text).toBe('First two.')
      h.host.end()
      expect(h.host.current.text).toBe('Second block.')
      expect(h.highlights('t1').at(-1)).toMatchObject({ blockId: 'b1', at: { path: [1, 1], run: 0, offset: 0 } })
      h.host.end()
      h.host.end()
      h.host.end()
      expect(h.host.current.text).toBe('Third three.')
      h.host.end()
      expect(h.service.uiState()).toMatchObject({ status: 'ended', sentenceIndex: 5, word: null })
      expect(h.highlights('t1').at(-1)!.mode).toBe('off')
      expect(h.host.spoken).toHaveLength(6)
      // Toggle on an ended session starts over.
      h.service.toggle()
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 0 })
    })

    it('ignores events of an utterance that is no longer current', () => {
      const first = h.host.current.id
      h.service.next()
      expect(h.service.uiState()!.sentenceIndex).toBe(1)
      h.host.end(first)
      h.host.word(0, 3, first)
      expect(h.service.uiState()).toMatchObject({ sentenceIndex: 1, word: null })
      expect(h.host.spoken).toHaveLength(2)
    })

    it('pauses and resumes through the host when it can', () => {
      h.service.pause()
      expect(h.service.uiState()!.status).toBe('paused')
      expect(h.host.pauses).toBe(1)
      // A start that arrives late does not flip a paused session back.
      h.host.start()
      expect(h.service.uiState()!.status).toBe('paused')
      h.service.pause()
      expect(h.host.pauses).toBe(1)
      h.service.resume()
      expect(h.service.uiState()!.status).toBe('playing')
      expect(h.host.resumes).toBe(1)
      expect(h.host.spoken).toHaveLength(1)
      h.service.toggle()
      expect(h.service.uiState()!.status).toBe('paused')
      h.service.toggle()
      expect(h.service.uiState()!.status).toBe('playing')
    })

    it('without a host pause, stops and restarts the sentence on resume', async () => {
      const bare = harness({ host: new FakeHost({ pause: false }) })
      await playing(bare)
      bare.host.end()
      expect(bare.host.current.text).toBe('First two.')
      bare.service.pause()
      expect(bare.service.uiState()!.status).toBe('paused')
      expect(bare.host.stops).toBe(1)
      // The stopped utterance's end must not advance the session.
      bare.host.end()
      expect(bare.service.uiState()).toMatchObject({ status: 'paused', sentenceIndex: 1 })
      bare.service.resume()
      expect(bare.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 1 })
      expect(bare.host.spoken).toHaveLength(3)
      expect(bare.host.current.text).toBe('First two.')
    })

    it('previous, next and seek stay within the sentences', () => {
      h.service.previous()
      expect(h.service.uiState()!.sentenceIndex).toBe(0)
      expect(h.host.spoken).toHaveLength(2)
      h.service.seek({ sentenceIndex: 99 })
      expect(h.service.uiState()!.sentenceIndex).toBe(5)
      h.service.next()
      expect(h.service.uiState()!.status).toBe('ended')
      h.service.seek({ sentenceIndex: -4 })
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 0 })
      h.service.seek({ sentenceIndex: 2 })
      expect(h.host.current.text).toBe('Second block.')
      h.service.previous()
      expect(h.host.current.text).toBe('First two.')
    })

    it('reports the host’s error, and resume retries the sentence', () => {
      h.host.error('synthesis-failed')
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'synthesis-failed', word: null })
      // Nothing more from the failed utterance counts.
      h.host.end()
      expect(h.service.uiState()!.status).toBe('error')
      h.service.resume()
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 0 })
      expect(h.service.uiState()!.error).toBeUndefined()
    })

    it('stop ends the session: speech, highlight, stylesheet and state', async () => {
      h.service.stop()
      expect(h.service.uiState()).toBeNull()
      expect(h.host.stops).toBe(1)
      expect(h.highlights('t1').at(-1)!.mode).toBe('off')
      await flush()
      expect(h.views.get('t1')!.removed).toEqual(['css1'])
      // Commands without a session are no-ops.
      h.service.pause()
      h.service.resume()
      h.service.next()
      h.service.seek({ sentenceIndex: 1 })
      expect(h.host.spoken).toHaveLength(1)
    })

    it('applies the rate from the next sentence and saves it', () => {
      h.service.setRate({ rate: 1.5 })
      expect(h.settings().rate).toBe(1.5)
      expect(h.service.uiState()!.rate).toBe(1.5)
      expect(h.commits.persisted).toBe(1)
      expect(h.host.current.options.rate).toBe(1)
      h.host.end()
      expect(h.host.current.options.rate).toBe(1.5)
      h.service.setRate({ rate: 7 })
      expect(h.settings().rate).toBe(4)
    })

    it('setVoice writes the session language’s choice and applies it from the next sentence', () => {
      h.service.setVoice({ voiceId: 'Daniel' })
      expect(h.settings().voiceByLanguage).toEqual({ en: 'Daniel' })
      expect(h.service.uiState()!.voiceId).toBe('Daniel')
      h.host.end()
      expect(h.host.current.options.voiceId).toBe('Daniel')
      // A voice the host does not have is saved for later but not used.
      h.service.setVoice({ voiceId: 'Ghost' })
      expect(h.settings().voiceByLanguage.en).toBe('Ghost')
      expect(h.service.uiState()!.voiceId).toBe('Daniel')
      // A picker naming another language does not touch the session.
      h.service.setVoice({ voiceId: 'Amélie', lang: 'fr-CA' })
      expect(h.settings().voiceByLanguage['fr-ca']).toBe('Amélie')
      expect(h.service.uiState()!.voiceId).toBe('Daniel')
    })

    it('setHighlight repaints or clears, and word events stop painting when not wanted', () => {
      h.service.setHighlight({ mode: 'sentence' })
      expect(h.settings().highlight).toBe('sentence')
      expect(h.highlights('t1').at(-1)).toMatchObject({ mode: 'sentence', word: null })
      const before = h.highlights('t1').length
      h.host.word(0, 5)
      expect(h.service.uiState()!.word).toEqual({ start: 0, end: 5 })
      expect(h.highlights('t1')).toHaveLength(before)
      h.service.setHighlight({ mode: 'off' })
      expect(h.highlights('t1').at(-1)!.mode).toBe('off')
      h.service.setHighlight({ mode: 'both' })
      expect(h.highlights('t1').at(-1)).toMatchObject({ mode: 'both', word: { start: 0, end: 5 } })
      h.service.setHighlight({ mode: 'rainbow' as 'both' })
      expect(h.settings().highlight).toBe('both')
    })

    it('takes a settings change made elsewhere', () => {
      h.settings().rate = 2
      h.settings().highlight = 'word'
      h.service.onSettingsChanged()
      expect(h.service.uiState()).toMatchObject({ rate: 2, highlight: 'word' })
    })

    it('lists the voices with a default per language, the UI and session languages included', async () => {
      h.translate.preferred = ['de']
      expect(await h.service.voicesResult()).toEqual({
        voices: h.host.voiceList,
        byLanguage: { en: 'Samantha', 'en-gb': 'Daniel', 'en-us': 'Samantha', fr: 'Amélie', 'fr-ca': 'Amélie' }
      })
    })
  })

  describe('prepare', () => {
    it('asks the host for the next sentence when the current starts, and speaks it under the same id', async () => {
      const ready = harness({ host: new FakeHost({ prepare: true }) })
      await playing(ready)
      expect(ready.host.preparedList).toHaveLength(0)
      ready.host.start()
      expect(ready.host.preparedList).toHaveLength(1)
      expect(ready.host.preparedList[0].text).toBe('First two.')
      ready.host.end()
      expect(ready.host.current.id).toBe(ready.host.preparedList[0].id)
      // A jump elsewhere drops the prepared one.
      ready.host.start()
      ready.service.seek({ sentenceIndex: 4 })
      expect(ready.host.current.id).not.toBe(ready.host.preparedList[1].id)
    })
  })

  describe('the tab’s life', () => {
    beforeEach(async () => {
      await playing(h)
    })

    it('a navigation to another document ends the session; an in-page one does not', () => {
      h.service.onNavigated('t1', true)
      expect(h.service.uiState()!.status).toBe('playing')
      h.service.onNavigated('t2', false)
      expect(h.service.uiState()!.status).toBe('playing')
      h.tabs.get('t1')!.url = 'https://example.com/other'
      h.service.onNavigated('t1', false)
      expect(h.service.uiState()).toBeNull()
      expect(h.host.stops).toBe(1)
      expect(h.highlights('t1').at(-1)!.mode).toBe('off')
      // The new document being ready starts nothing.
      h.service.onPageReady('t1')
      expect(h.service.uiState()).toBeNull()
    })

    it('entering the reader on the same page starts over from the top of the article', async () => {
      h.articles.set('a1', {
        id: 'a1',
        url: PAGE,
        title: 'Reader title',
        byline: null,
        siteName: null,
        excerpt: null,
        content: '<p>From the top.</p>',
        length: 13,
        lang: 'en',
        dir: null
      })
      h.host.end()
      expect(h.service.uiState()!.sentenceIndex).toBe(1)
      h.tabs.get('t1')!.url = `zen://reader?id=a1&url=${encodeURIComponent(PAGE)}`
      h.service.onNavigated('t1', false)
      expect(h.service.uiState()).toBeNull()
      h.service.onPageReady('t1')
      await flush()
      expect(h.service.uiState()).toMatchObject({
        tabId: 't1',
        status: 'playing',
        source: 'reader',
        title: 'Reader title',
        sentenceIndex: 0
      })
      // And back: leaving the reader restarts the page's extraction.
      h.tabs.get('t1')!.url = PAGE
      h.service.onNavigated('t1', false)
      expect(h.service.uiState()).toBeNull()
      h.service.onPageReady('t1')
      await flush()
      expect(h.service.uiState()).toMatchObject({ status: 'loading', source: 'page' })
      expect(h.extractRequests('t1')).toHaveLength(2)
    })

    it('a session that had ended does not come back with the reader', () => {
      h.service.seek({ sentenceIndex: 5 })
      h.host.end()
      expect(h.service.uiState()!.status).toBe('ended')
      h.tabs.get('t1')!.url = `zen://reader?id=a1&url=${encodeURIComponent(PAGE)}`
      h.service.onNavigated('t1', false)
      h.service.onPageReady('t1')
      expect(h.service.uiState()).toBeNull()
    })

    it('the tab closing or unloading ends the session without touching the gone page', () => {
      const view = h.views.get('t1')!
      view.destroyed = true
      const posted = view.posted.length
      h.service.onTabGone('t1')
      expect(h.service.uiState()).toBeNull()
      expect(h.host.stops).toBe(1)
      expect(view.posted).toHaveLength(posted)
    })

    it('a pending extraction is dropped when its tab goes', async () => {
      h.addTab('t2', PAGE)
      const started = h.service.start({ tabId: 't2' })
      await flush()
      h.service.onTabGone('t2')
      await started
      expect(h.service.uiState()).toBeNull()
    })
  })
})

describe('wordEnd', () => {
  it('runs to the next whitespace from the start, skipping leading spaces', () => {
    expect(wordEnd('Hello world', 0)).toBe(5)
    expect(wordEnd('Hello world', 5)).toBe(11)
    expect(wordEnd('Hello world', 6)).toBe(11)
    expect(wordEnd('Hello', 5)).toBe(5)
  })
})

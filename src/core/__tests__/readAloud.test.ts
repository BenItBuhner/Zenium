import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTRACT_TIMEOUT_MS,
  LATE_VOICES_RETRY_MS,
  READ_ALOUD_SOURCE_ACTIONS,
  READ_ALOUD_SOURCE_ID,
  ReadAloudService,
  VOICES_GRACE_MS,
  VOICES_QUERY_GRACE_MS,
  wordEnd
} from '../readAloud'
import type { Browser } from '../browser'
import type {
  PageHostMessage,
  SpeechHost,
  SpeechHostEvent,
  SpeechUtteranceOptions
} from '../platform'
import type { ReaderArticle } from '../reader'
import type { MediaSessionSource, MediaSessionSourceHandle } from '../../shared/mediaSession'
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
  /** The cascade origin each `insertCSS` asked for (`undefined` when it left the host's default). */
  insertedOrigins: Array<string | undefined>
  removed: string[]
  scripts: string[]
  scriptResult: unknown
  isDestroyed(): boolean
  postToPage(message: PageHostMessage): void
  insertCSS(css: string, origin?: 'user' | 'author'): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
}

/** A source as the media session engine would track it: what was registered, then every patch. */
interface RegisteredSource {
  source: MediaSessionSource
  /** The source as it stands after the patches. */
  state: Omit<MediaSessionSource, 'onAction'>
  updates: Array<Parameters<MediaSessionSourceHandle['update']>[0]>
  released: boolean
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
  /** Every `registerSource` call, in order. */
  sources: RegisteredSource[]
  addTab(id: string, url: string, title?: string): FakeView
  /** The extraction requests the page script would have seen for a tab. */
  extractRequests(tabId: string): ReadAloudExtractRequest[]
  highlights(tabId: string): ReadAloudHighlightMessage[]
  /** Answer the latest extraction request of a tab as the page script would. */
  answer(
    tabId: string,
    blocks: Array<Partial<ReadAloudExtractedBlock> & { text: string }>,
    extra?: { title?: string; lang?: string }
  ): void
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
  const sources: RegisteredSource[] = []
  const browser = {
    platform: {
      speech: host ?? undefined,
      readabilitySource: () => h.readability
    },
    mediaSession: {
      registerSource: (source: MediaSessionSource): MediaSessionSourceHandle => {
        const state = {
          id: source.id,
          tabId: source.tabId,
          title: source.title,
          artist: source.artist,
          artwork: source.artwork,
          playing: source.playing,
          actions: source.actions,
          position: source.position
        }
        const registered: RegisteredSource = { source, state, updates: [], released: false }
        sources.push(registered)
        return {
          update: (patch) => {
            registered.updates.push(patch)
            registered.state = { ...registered.state, ...patch }
          },
          release: () => {
            registered.released = true
          }
        }
      }
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
      article: (id: string) => articles.get(id),
      // As written: no reader translation stands in these tests (`ReaderService.shown`).
      shown: (article: ReaderArticle) => ({
        content: article.content,
        title: article.title,
        lang: article.lang
      })
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
    sources,
    settings: () => state.settings.readAloud,
    commits,
    translate,
    addTab: (id, url, title = 'Title') => {
      const view: FakeView = {
        destroyed: false,
        posted: [],
        inserted: [],
        insertedOrigins: [],
        removed: [],
        scripts: [],
        scriptResult: null,
        isDestroyed: () => view.destroyed,
        postToPage: (m) => view.posted.push(m),
        insertCSS: async (css, origin) => {
          view.inserted.push(css)
          view.insertedOrigins.push(origin)
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
    answer: (tabId, blocks, extra: { title?: string; lang?: string } = {}) => {
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
      expect(h.service.uiState()).toMatchObject({
        tabId: 't1',
        status: 'loading',
        source: 'page',
        sentenceIndex: -1
      })
      await flush()
      const requests = h.extractRequests('t1')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ from: 'top', keep: null })
      h.answer('t1', [{ text: 'Hello world. Second sentence.' }, { text: 'Next block.' }], {
        title: 'Doc',
        lang: 'en-GB'
      })
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
      // Blink paints `::highlight()` from author sheets only; a user-origin sheet registers, never paints.
      expect(h.views.get('t1')!.insertedOrigins).toEqual(['author'])
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
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        lang: 'de',
        voiceId: 'Samantha'
      })
      expect(h.service.uiState()!.error).toBeUndefined()
    })

    it('fails with no-voice when the host has none at all (after a grace for a late list), and speaks once a voice is chosen', async () => {
      vi.useFakeTimers()
      h.host.voiceList = []
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }])
      await flush()
      // The text is in; the voice is still awaited.
      expect(h.service.uiState()).toMatchObject({ status: 'loading', sentenceCount: 1 })
      await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
      await started
      expect(h.service.uiState()).toMatchObject({
        status: 'error',
        error: 'no-voice',
        voiceId: null
      })
      expect(h.host.spoken).toHaveLength(0)
      // A voice installed without a word from the host (a `voicesChanged` would restart the
      // session on its own, below): the picker's choice speaks with it.
      h.host.voiceList = [{ id: 'Late', name: 'Late', lang: 'en', local: true }]
      h.service.setVoice({ voiceId: 'Late' })
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        voiceId: 'Late',
        sentenceIndex: 0
      })
      expect(h.host.current.options.voiceId).toBe('Late')
    })

    it('waits for a host that is still listing its voices, and speaks as soon as they come', async () => {
      vi.useFakeTimers()
      h.host.voiceList = []
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }])
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.service.uiState()).toMatchObject({ status: 'loading' })
      h.host.changeVoices([{ id: 'Samantha', name: 'Samantha', lang: 'en-US', local: true }])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'playing', voiceId: 'Samantha' })
      expect(h.host.current.text).toBe('Hello.')
    })

    it('keeps waiting through a voicesChanged whose list is still empty (an engine bound before its voice data landed), and speaks when the voices come', async () => {
      // The nightly sweep's `reader-ui` on a fresh emulator (#332): Google's engine binds ~1 s
      // after the tap and the host says `voicesChanged` with every voice still `notInstalled`;
      // the locale's voice pack lands ~2 s later. The start must not fail `no-voice` in between.
      vi.useFakeTimers()
      let asks = 0
      h.host.voices = () => {
        asks++
        return Promise.resolve(h.host.voiceList)
      }
      h.host.voiceList = []
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }])
      await vi.advanceTimersByTimeAsync(900)
      h.host.changeVoices([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.service.uiState()).toMatchObject({ status: 'loading', voiceId: null })
      expect(asks).toBe(2)
      h.host.changeVoices([
        { id: 'en-us-x-local', name: 'English (United States)', lang: 'en-US', local: true }
      ])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'playing', voiceId: 'en-us-x-local' })
      expect(h.host.current.text).toBe('Hello.')
      expect(asks).toBe(3)
    })

    it('gives up at the end of the grace when every voicesChanged left the list empty, asking once more at the deadline', async () => {
      vi.useFakeTimers()
      let asks = 0
      h.host.voices = () => {
        asks++
        return Promise.resolve([])
      }
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }])
      await vi.advanceTimersByTimeAsync(900)
      h.host.changeVoices([])
      await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS - 900 - 1)
      expect(h.service.uiState()).toMatchObject({ status: 'loading' })
      await vi.advanceTimersByTimeAsync(2)
      await started
      expect(h.service.uiState()).toMatchObject({
        status: 'error',
        error: 'no-voice',
        voiceId: null
      })
      expect(asks).toBe(3)
      expect(h.host.spoken).toHaveLength(0)
    })

    it('Play after no-voice chooses the voice again (the engine has its data by now) and speaks; still none, and it says no-voice again', async () => {
      vi.useFakeTimers()
      h.host.voiceList = []
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Hello.' }, { text: 'World.' }])
      await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice' })

      // Play with the engine still empty: the same wait, the same answer.
      h.service.resume()
      expect(h.service.uiState()).toMatchObject({ status: 'loading' })
      expect(h.service.uiState()).not.toHaveProperty('error')
      await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
      expect(h.service.uiState()).toMatchObject({
        status: 'error',
        error: 'no-voice',
        voiceId: null
      })
      expect(h.host.spoken).toHaveLength(0)

      // The voice pack landed without a word from the host (no `voicesChanged`): Play asks and speaks from the top.
      h.host.voiceList = [
        { id: 'en-us-x-local', name: 'English (United States)', lang: 'en-US', local: true }
      ]
      h.service.toggle()
      await flush()
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        voiceId: 'en-us-x-local',
        sentenceIndex: 0,
        sentenceCount: 2
      })
      expect(h.host.current).toMatchObject({
        text: 'Hello.',
        options: { voiceId: 'en-us-x-local' }
      })
    })

    describe('a speech engine that binds late (the nightly’s cold bind, #344)', () => {
      const ENGINE = [
        { id: 'en-us-x-local', name: 'English (United States)', lang: 'en-US', local: true }
      ]

      /**
       * Start on a two-sentence page with a host that lists nothing yet; the text is in, the voice
       * awaited. The pending `start` comes back wrapped (an async function would await it).
       */
      async function startWithoutVoices(): Promise<{ started: Promise<void> }> {
        h.host.voiceList = []
        h.addTab('t1', PAGE)
        const started = h.service.start({ tabId: 't1' })
        await flush()
        h.answer('t1', [{ text: 'Hello.' }, { text: 'World.' }])
        await flush()
        expect(h.service.uiState()).toMatchObject({ status: 'loading', sentenceCount: 2 })
        return { started }
      }

      it('speaks when the engine binds 4.1 s after the ask: the cold bind the 4 s grace missed', async () => {
        // `bar-star-listen-on` §B on the nightly's boot: `ReadAloud.kt` binds the engine on first
        // use, `speech engine ready … 421 voices` came 4.1 s after the ask, and the 4 s grace had
        // just failed the session `no-voice`. The grace covers a cold bind now.
        vi.useFakeTimers()
        const { started } = await startWithoutVoices()
        await vi.advanceTimersByTimeAsync(4100)
        expect(h.service.uiState()).toMatchObject({ status: 'loading', voiceId: null })
        h.host.changeVoices(ENGINE)
        await started
        expect(h.service.uiState()).toMatchObject({
          status: 'playing',
          voiceId: 'en-us-x-local',
          sentenceIndex: 0
        })
        expect(h.service.uiState()).not.toHaveProperty('error')
        expect(h.host.current.text).toBe('Hello.')
      })

      it('restarts on its own when the voices come after the grace ran out: no-voice gives way to loading, then playing from where it stood', async () => {
        vi.useFakeTimers()
        let asks = 0
        h.host.voices = () => {
          asks++
          return Promise.resolve(h.host.voiceList)
        }
        const { started } = await startWithoutVoices()
        await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
        await started
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice', voiceId: null })
        expect(h.host.spoken).toHaveLength(0)
        const asksBefore = asks

        // The engine binds 12 s after the ask (inside the failure's window): the error line gives way to busy at once…
        await vi.advanceTimersByTimeAsync(12_000 - VOICES_GRACE_MS)
        h.host.changeVoices(ENGINE)
        expect(h.service.uiState()).toMatchObject({ status: 'loading', voiceId: null })
        expect(h.service.uiState()).not.toHaveProperty('error')
        // …and to playing, with the voice that came, from the sentence it stood at (the top: it never spoke).
        await flush()
        expect(h.service.uiState()).toMatchObject({
          status: 'playing',
          voiceId: 'en-us-x-local',
          sentenceIndex: 0,
          sentenceCount: 2
        })
        expect(h.host.spoken).toHaveLength(1)
        expect(h.host.current).toMatchObject({ text: 'Hello.', options: { voiceId: 'en-us-x-local' } })
        // One fresh ask of the host for the list it announced; no waiting on a deadline.
        expect(asks).toBe(asksBefore + 1)
        // The player joins the OS controls with the first sentence spoken, as for any start.
        expect(h.sources).toHaveLength(1)
        expect(h.sources[0].state.playing).toBe(true)
        // Nothing armed stays behind.
        expect(vi.getTimerCount()).toBe(0)
      })

      it('lets the window close: a voicesChanged 31 s after the no-voice does nothing, and Play still tries', async () => {
        vi.useFakeTimers()
        const { started } = await startWithoutVoices()
        await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
        await started
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice' })

        await vi.advanceTimersByTimeAsync(LATE_VOICES_RETRY_MS + 1000)
        h.host.changeVoices(ENGINE)
        await flush()
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice', voiceId: null })
        expect(h.host.spoken).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)

        // The user's Play (#337) is the way on: the voices are there, it speaks.
        h.service.resume()
        await flush()
        expect(h.service.uiState()).toMatchObject({ status: 'playing', voiceId: 'en-us-x-local', sentenceIndex: 0 })
        expect(h.host.current.text).toBe('Hello.')
      })

      it('a Stop inside the window cancels the automatic retry: the voices coming later start nothing', async () => {
        vi.useFakeTimers()
        const { started } = await startWithoutVoices()
        await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
        await started
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice' })

        await vi.advanceTimersByTimeAsync(2000)
        h.service.stop()
        expect(h.service.uiState()).toBeNull()
        // The window went with the session: nothing is armed any more.
        expect(vi.getTimerCount()).toBe(0)

        await vi.advanceTimersByTimeAsync(3000)
        h.host.changeVoices(ENGINE)
        await flush()
        expect(h.service.uiState()).toBeNull()
        expect(h.host.spoken).toHaveLength(0)
      })

      it('a second no-voice after the automatic retry stays no-voice: an engine that announced itself with nothing installed does not keep the player cycling', async () => {
        vi.useFakeTimers()
        const { started } = await startWithoutVoices()
        await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
        await started
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice' })

        // The engine binds with every voice still `notInstalled` (an empty list): the retry runs its grace…
        await vi.advanceTimersByTimeAsync(2000)
        h.host.changeVoices([])
        expect(h.service.uiState()).toMatchObject({ status: 'loading' })
        await vi.advanceTimersByTimeAsync(VOICES_GRACE_MS + 1)
        // …and says no-voice again; nothing is armed for another round.
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice', voiceId: null })
        expect(vi.getTimerCount()).toBe(0)

        // Another empty announcement leaves it there: no busy state, no third grace.
        await vi.advanceTimersByTimeAsync(2000)
        h.host.changeVoices([])
        await flush()
        expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-voice' })
        expect(vi.getTimerCount()).toBe(0)
        expect(h.host.spoken).toHaveLength(0)

        // Play once the pack has landed: the user's retry stands (#337), and it arms a window of its own.
        h.host.voiceList = ENGINE
        h.service.resume()
        await flush()
        expect(h.service.uiState()).toMatchObject({ status: 'playing', voiceId: 'en-us-x-local', sentenceIndex: 0 })
        expect(h.host.current.text).toBe('Hello.')
      })
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
      expect(h.service.uiState()).toMatchObject({
        source: 'selection',
        sentenceIndex: 0,
        sentenceCount: 2
      })
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

    it('selection-on reads the selection and then the document after it (EDGE-11), the main content marked when readerable', async () => {
      h.addTab('t1', PAGE)
      let started = h.service.start({ tabId: 't1', from: 'selection-on' })
      await flush()
      // The page script is asked for the selection and then the document; no Readability pass
      // on a page that is not readerable.
      expect(h.extractRequests('t1')[0]).toMatchObject({
        from: 'selection',
        then: 'document',
        keep: null
      })
      // What the page script answers: the selection's blocks, the rest of the last one from the
      // selection's end, then the blocks after it – every id once, the highlight positions kept.
      h.answer('t1', [
        { text: 'lected text. And more.', at: { path: [1, 3], run: 0, offset: 14 } },
        { text: 'Rest of the block.', at: { path: [1, 3], run: 0, offset: 37 } },
        { text: 'Next block.', at: { path: [1, 4], run: 0, offset: 0 } }
      ])
      await started
      expect(h.service.uiState()).toMatchObject({
        source: 'selection',
        sentenceIndex: 0,
        sentenceCount: 4
      })
      expect(h.host.current.text).toBe('lected text.')
      h.host.end()
      h.host.end()
      expect(h.host.current.text).toBe('Rest of the block.')
      expect(h.highlights('t1').at(-1)).toMatchObject({
        blockId: 'b1',
        at: { path: [1, 3], run: 0, offset: 37 },
        sentence: { start: 0, end: 18 }
      })
      h.host.end()
      expect(h.host.current.text).toBe('Next block.')
      h.host.end()
      expect(h.service.uiState()).toMatchObject({ status: 'ended' })

      // A readerable page: Readability's block texts ride along for the continuation.
      h.readability = '/* Readability */'
      const view = h.views.get('t1')!
      h.tabs.get('t1')!.readerable = true
      view.scriptResult = { content: '<p>Kept one.</p><p>Kept two.</p>', lang: 'en' }
      started = h.service.start({ tabId: 't1', from: 'selection-on' })
      await flush()
      expect(h.extractRequests('t1')[1]).toMatchObject({
        from: 'selection',
        then: 'document',
        keep: ['Kept one.', 'Kept two.']
      })
      h.answer('t1', [{ text: 'one.' }, { text: 'Kept two.' }])
      await started
      expect(h.service.uiState()).toMatchObject({ source: 'selection', sentenceCount: 2 })

      // A plain selection start stays selection-only: no `then`, no Readability pass.
      started = h.service.start({ tabId: 't1', from: 'selection' })
      await flush()
      expect(h.extractRequests('t1')[2]).toMatchObject({ from: 'selection', keep: null })
      expect(h.extractRequests('t1')[2].then).toBeUndefined()
      expect(view.scripts).toHaveLength(1)
      h.answer('t1', [{ text: 'Just this.' }])
      await started
      expect(h.service.uiState()).toMatchObject({ sentenceCount: 1 })
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

    const readerArticle = (content: string, title = 'The article'): void => {
      h.articles.set('a1', {
        id: 'a1',
        url: PAGE,
        title,
        byline: null,
        siteName: null,
        excerpt: null,
        content,
        length: content.length,
        lang: 'en',
        dir: null
      })
    }
    const READER_URL = `zen://reader?id=a1&url=${encodeURIComponent(PAGE)}`

    it('reads the reader document’s own blocks (its article walked by the page script, with positions), without inserting CSS', async () => {
      readerArticle('<h2>Head</h2><p>Body one. Body two.</p><ul><li lang="fr">Bonjour</li></ul>')
      const view = h.addTab('t1', READER_URL)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      // The reader document is asked as is: from the top, no Readability pass, no `then`.
      expect(h.extractRequests('t1')).toHaveLength(1)
      expect(h.extractRequests('t1')[0]).toMatchObject({ from: 'top', keep: null })
      expect(h.extractRequests('t1')[0].then).toBeUndefined()
      expect(view.scripts).toHaveLength(0)
      h.answer(
        't1',
        [
          { text: 'Head', kind: 'heading', at: { path: [0], run: 0, offset: 0 } },
          { text: 'Body one. Body two.', at: { path: [1], run: 0, offset: 0 } },
          {
            text: 'Bonjour',
            kind: 'list-item',
            lang: 'fr',
            at: { path: [2, 0], run: 0, offset: 0 }
          }
        ],
        { title: 'The article', lang: 'en' }
      )
      await started
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        source: 'reader',
        title: 'The article',
        lang: 'en',
        sentenceCount: 4,
        voiceId: 'Samantha'
      })
      expect(h.host.current.text).toBe('Head')
      // The highlight names the block by its position in the reader document.
      expect(h.highlights('t1')[0]).toMatchObject({
        blockId: 'b0',
        at: { path: [0], run: 0, offset: 0 },
        sentence: { start: 0, end: 4 }
      })
      expect(view.inserted).toHaveLength(0)
      // The French list item speaks with the French voice; the document's language stays.
      h.host.end()
      h.host.end()
      h.host.end()
      expect(h.host.current).toMatchObject({
        text: 'Bonjour',
        options: { voiceId: 'Amélie', lang: 'fr' }
      })
      expect(h.service.uiState()).toMatchObject({ voiceId: 'Amélie', lang: 'en' })
    })

    it('falls back to the reader article’s HTML, walked by the same rules, when the reader document does not answer', async () => {
      readerArticle('<h2>Head</h2><p>Body one. Body two.</p><ul><li lang="fr">Bonjour</li></ul>')
      vi.useFakeTimers()
      const view = h.addTab('t1', READER_URL)
      const started = h.service.start({ tabId: 't1' })
      await vi.advanceTimersByTimeAsync(EXTRACT_TIMEOUT_MS + 1)
      await started
      expect(h.service.uiState()).toMatchObject({
        status: 'playing',
        source: 'reader',
        title: 'The article',
        sentenceCount: 4,
        voiceId: 'Samantha'
      })
      expect(h.host.current.text).toBe('Head')
      // Without positions the highlight names the block by its index; the reader document
      // resolves `b<index>` against its own walk of the same article.
      expect(h.highlights('t1')[0]).toMatchObject({
        blockId: 'b0',
        at: null,
        sentence: { start: 0, end: 4 }
      })
      expect(view.inserted).toHaveLength(0)
      h.host.end()
      h.host.end()
      h.host.end()
      expect(h.host.current).toMatchObject({ text: 'Bonjour', options: { voiceId: 'Amélie' } })
    })

    it('a reader document that answers no blocks falls back to the HTML too, and an empty article is no-text', async () => {
      readerArticle('<p>Only this.</p>')
      h.addTab('t1', READER_URL)
      let started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceCount: 1 })
      expect(h.host.current.text).toBe('Only this.')

      readerArticle('<p>   </p>')
      started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-text' })
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
      expect(h.highlights('t1').at(-1)).toMatchObject({
        sentence: { start: 0, end: 10 },
        word: { start: 6, end: 10 }
      })
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
      expect(h.highlights('t1').at(-1)).toMatchObject({
        blockId: 'b1',
        at: { path: [1, 1], run: 0, offset: 0 }
      })
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
      expect(h.service.uiState()).toMatchObject({
        status: 'error',
        error: 'synthesis-failed',
        word: null
      })
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
        byLanguage: {
          en: 'Samantha',
          'en-gb': 'Daniel',
          'en-us': 'Samantha',
          fr: 'Amélie',
          'fr-ca': 'Amélie'
        }
      })
    })

    it('never keeps an empty voice list: an empty first answer is re-asked after a grace, through refreshVoices when the host has it', async () => {
      vi.useFakeTimers()
      const all = h.host.voiceList
      let asks = 0
      let refreshes = 0
      h.host.voices = () => {
        asks++
        return Promise.resolve(asks < 2 ? [] : all)
      }
      // The session's list is dropped (the engine says its voices changed) so the query asks anew.
      h.host.changeVoices(all)
      // No `refreshVoices` yet: the re-ask goes through `voices()` again.
      let result = h.service.voicesResult()
      await vi.advanceTimersByTimeAsync(VOICES_QUERY_GRACE_MS + 1)
      expect((await result).voices).toEqual(all)
      expect(asks).toBe(2)
      // Listed now: kept, no further ask.
      expect((await h.service.voicesResult()).voices).toEqual(all)
      expect(asks).toBe(2)

      // The list changes and comes back empty from `voices()`, but the host can list again:
      // the engine's `voiceschanged` ends the grace early and `refreshVoices` answers.
      const host = h.host as FakeHost & { refreshVoices?: () => Promise<ReadAloudVoice[]> }
      host.refreshVoices = () => {
        refreshes++
        return Promise.resolve(all)
      }
      h.host.voices = () => {
        asks++
        return Promise.resolve([])
      }
      h.host.changeVoices([])
      result = h.service.voicesResult()
      await vi.advanceTimersByTimeAsync(100)
      h.host.changeVoices(all)
      expect((await result).voices).toEqual(all)
      expect(refreshes).toBe(1)
      expect(asks).toBe(3)
    })

    it('a query holds through a voicesChanged whose list is still empty, and answers the list that comes inside its grace', async () => {
      vi.useFakeTimers()
      const all = h.host.voiceList
      let listed: ReadAloudVoice[] = []
      let asks = 0
      h.host.voices = () => {
        asks++
        return Promise.resolve(listed)
      }
      h.host.changeVoices([])
      const result = h.service.voicesResult()
      await vi.advanceTimersByTimeAsync(200)
      // The engine bound: it says so, with nothing installed yet.
      h.host.changeVoices([])
      await vi.advanceTimersByTimeAsync(200)
      expect(asks).toBe(2)
      listed = all
      h.host.changeVoices(all)
      expect((await result).voices).toEqual(all)
      expect(asks).toBe(3)
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
      // The reader document is asked for its blocks (the second request on this view).
      expect(h.service.uiState()).toMatchObject({ status: 'loading', source: 'reader' })
      expect(h.extractRequests('t1')).toHaveLength(2)
      h.answer('t1', [{ text: 'From the top.' }], { title: 'Reader title' })
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
      expect(h.extractRequests('t1')).toHaveLength(3)
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

  describe('the media session (contract 2.5)', () => {
    it('registers the player with the first sentence: the text’s title over the site, playing, the five controls', async () => {
      h.addTab('t1', PAGE, 'Tab title')
      const started = h.service.start({ tabId: 't1' })
      await flush()
      expect(h.sources).toHaveLength(0)
      h.answer('t1', [{ text: 'One. Two.' }], { title: 'Doc title' })
      await started
      expect(h.sources).toHaveLength(1)
      expect(h.sources[0].state).toEqual({
        id: READ_ALOUD_SOURCE_ID,
        tabId: 't1',
        title: 'Doc title',
        artist: 'example.com',
        artwork: null,
        playing: true,
        actions: ['play', 'pause', 'stop', 'previoustrack', 'nexttrack'],
        position: null
      })
      expect(h.sources[0].state.actions).toBe(READ_ALOUD_SOURCE_ACTIONS)
    })

    it('a start that fails registers nothing', async () => {
      h.addTab('t1', PAGE)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: '   ' }])
      await started
      expect(h.service.uiState()).toMatchObject({ status: 'error', error: 'no-text' })
      expect(h.sources).toHaveLength(0)
    })

    it('updates on every status change and stays up in paused form after the end; stop releases', async () => {
      await playing(h)
      const [registered] = h.sources
      h.service.pause()
      expect(registered.updates.at(-1)).toMatchObject({ playing: false })
      h.service.resume()
      expect(registered.updates.at(-1)).toMatchObject({ playing: true })
      h.host.error('boom')
      expect(registered.state.playing).toBe(false)
      h.service.resume()
      expect(registered.state.playing).toBe(true)
      h.service.seek({ sentenceIndex: 5 })
      h.host.end()
      expect(h.service.uiState()!.status).toBe('ended')
      expect(registered.released).toBe(false)
      expect(registered.state.playing).toBe(false)
      // The next sentence speaks under the same registration.
      expect(h.sources).toHaveLength(1)
      h.service.stop()
      expect(registered.released).toBe(true)
      expect(h.sources).toHaveLength(1)
    })

    it('the tab going releases the player; a second start registers anew', async () => {
      await playing(h)
      h.views.get('t1')!.destroyed = true
      h.service.onTabGone('t1')
      expect(h.sources[0].released).toBe(true)
      await playing(h, 't2')
      expect(h.sources).toHaveLength(2)
      expect(h.sources[1].state).toMatchObject({ tabId: 't2', playing: true })
      expect(h.sources[1].released).toBe(false)
    })

    it('a start on another tab releases the first player before the second registers', async () => {
      await playing(h)
      await playing(h, 't2')
      expect(h.sources.map((s) => [s.state.tabId, s.released])).toEqual([
        ['t1', true],
        ['t2', false]
      ])
    })

    it('the reader’s player names the original page’s site', async () => {
      h.articles.set('a1', {
        id: 'a1',
        url: PAGE,
        title: 'The article',
        byline: null,
        siteName: null,
        excerpt: null,
        content: '<p>Body one.</p>',
        length: 9,
        lang: 'en',
        dir: null
      })
      h.addTab('t1', `zen://reader?id=a1&url=${encodeURIComponent(PAGE)}`)
      const started = h.service.start({ tabId: 't1' })
      await flush()
      h.answer('t1', [{ text: 'Body one.' }], { title: 'The article' })
      await started
      expect(h.sources[0].state).toMatchObject({
        title: 'The article',
        artist: 'example.com',
        playing: true
      })
    })

    it('the controls’ actions drive the session: pause, play, the tracks, toggle and stop', async () => {
      await playing(h)
      const { source } = h.sources[0]
      source.onAction('pause', {})
      expect(h.service.uiState()!.status).toBe('paused')
      expect(h.host.pauses).toBe(1)
      source.onAction('play', {})
      expect(h.service.uiState()!.status).toBe('playing')
      source.onAction('nexttrack', {})
      expect(h.service.uiState()!.sentenceIndex).toBe(1)
      source.onAction('nexttrack', {})
      expect(h.service.uiState()!.sentenceIndex).toBe(2)
      source.onAction('previoustrack', {})
      expect(h.service.uiState()!.sentenceIndex).toBe(1)
      source.onAction('toggle', {})
      expect(h.service.uiState()!.status).toBe('paused')
      source.onAction('toggle', {})
      expect(h.service.uiState()!.status).toBe('playing')
      // Seeking is not offered; an action outside the set does nothing.
      source.onAction('seekforward', { seekOffset: 10 })
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 1 })
      source.onAction('stop', {})
      expect(h.service.uiState()).toBeNull()
      expect(h.sources[0].released).toBe(true)
    })

    it('play after the end starts the text over; a pause from the focus loss is an ordinary pause', async () => {
      await playing(h)
      const { source } = h.sources[0]
      h.service.seek({ sentenceIndex: 5 })
      h.host.end()
      expect(h.service.uiState()!.status).toBe('ended')
      source.onAction('play', {})
      expect(h.service.uiState()).toMatchObject({ status: 'playing', sentenceIndex: 0 })
      source.onAction('pause', {})
      expect(h.service.uiState()!.status).toBe('paused')
      // Nothing resumes it on its own: the user does.
      h.host.emit(h.host.current.id, { type: 'start' })
      expect(h.service.uiState()!.status).toBe('paused')
    })

    it('an action for a player whose session is over is ignored', async () => {
      await playing(h)
      const stale = h.sources[0].source
      h.service.stop()
      await playing(h, 't2')
      stale.onAction('pause', {})
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'playing' })
      stale.onAction('stop', {})
      expect(h.service.uiState()).toMatchObject({ tabId: 't2', status: 'playing' })
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

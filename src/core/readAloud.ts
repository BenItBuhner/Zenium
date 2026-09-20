import type { Browser } from './browser'
import type { SpeechHost, SpeechHostEvent, TabView } from './platform'
import { sanitizeArticleHtml, type RawArticle } from './reader'
import { siteOf } from './mediaSession'
import { newId } from '../shared/ids'
import type {
  MediaSessionAction,
  MediaSessionSource,
  MediaSessionSourceAction,
  MediaSessionSourceHandle
} from '../shared/mediaSession'
import {
  READ_ALOUD_HIGHLIGHT_CSS,
  READ_ALOUD_HIGHLIGHT_MODES,
  blocksFromHtml,
  normalizeLanguageTag,
  readAloudExtractionOf,
  resolveReadAloudVoice,
  sanitizeReadAloudRate,
  segmentSentences,
  voiceForLanguage,
  voicesByLanguage,
  type ReadAloudBlock,
  type ReadAloudBlockPosition,
  type ReadAloudExtraction,
  type ReadAloudHighlightMode,
  type ReadAloudSettings,
  type ReadAloudSource,
  type ReadAloudStartFrom,
  type ReadAloudState,
  type ReadAloudText,
  type ReadAloudVoice,
  type ReadAloudVoicesResult
} from '../shared/readAloud'

/** How long the page script has to answer `readAloud.extract` before the start fails (`no-text`). */
export const EXTRACT_TIMEOUT_MS = 8000

/** The read-aloud player's id in the media session (`registerSource`; one session per id). */
export const READ_ALOUD_SOURCE_ID = 'read-aloud'

/** The controls the OS shows for the player (contract 2.5): sentence steps as tracks, no seeking. */
export const READ_ALOUD_SOURCE_ACTIONS: ReadonlyArray<MediaSessionSourceAction> = [
  'play',
  'pause',
  'stop',
  'previoustrack',
  'nexttrack'
]

/** The one session: its text, where it stands, and what it holds on the host. */
interface Session {
  /** Bumps on every `start`; async steps compare it to know they are stale. */
  readonly generation: number
  readonly tabId: string
  /** The document read (a navigation away from it ends the session). */
  readonly url: string
  text: ReadAloudText
  /** A page's blocks: where each one's text is in the document, for the highlight. */
  positions: Map<string, ReadAloudBlockPosition> | null
  state: ReadAloudState
  /** The voice the text's own language resolved to (a block's `lang` may switch per sentence). */
  voiceId: string | null
  /** The utterance the host is speaking; null while nothing is (events for others are stale). */
  utteranceId: string | null
  /** The next sentence the host was asked to `prepare`, when it can. */
  prepared: { index: number; utteranceId: string } | null
  /** The pause stopped the host (no `pause` of its own): resume restarts the sentence. */
  resumeFromStart: boolean
  /** The highlight stylesheet inserted into a web page (`removeInsertedCSS` on stop). */
  cssKey: Promise<string | null> | null
  /** The player in the media session, from the first sentence spoken until `stop` or the tab goes. */
  source: MediaSessionSourceHandle | null
}

interface PendingExtraction {
  tabId: string
  resolve(extraction: ReadAloudExtraction | null): void
}

/**
 * Read aloud (CT-12 / CT-13, Chrome's "Listen to this page" and Reading mode's read aloud):
 * one session at a time reads a tab's text sentence by sentence through the host's speech
 * engine (`Platform.speech`), keeps the playback state the players render (`UIState.readAloud`),
 * paints the current sentence and word into the page (`readAloud.highlight`), chooses the voice
 * per language, and joins the media session so the OS controls carry it. The text comes from
 * the reader article (its HTML, walked here), from the page script (`readAloud.extract`, with
 * Readability's article marking the main content when the page is readerable), or from the
 * selection. Engine only: the players, menus and pickers are the platforms' and wave 4's.
 */
export class ReadAloudService {
  private session: Session | null = null
  private generation = 0
  private utteranceSeq = 0
  private readonly pending = new Map<string, PendingExtraction>()
  private voiceList: ReadAloudVoice[] | null = null
  /** A reader ↔ page switch on the session's tab: read the new document from the top once it is ready. */
  private restartOnReady: string | null = null
  private readonly host: SpeechHost | undefined

  constructor(
    private readonly browser: Browser,
    host?: SpeechHost
  ) {
    this.host = host ?? browser.platform.speech
    this.host?.onEvent((utteranceId, event) => this.onHostEvent(utteranceId, event))
    this.host?.onVoicesChanged(() => {
      this.voiceList = null
    })
  }

  /** Whether the host can speak at all (`capabilities.readAloud`). */
  get available(): boolean {
    return this.host !== undefined
  }

  /** `UIState.readAloud`: the session's state, null without one. */
  uiState(): ReadAloudState | null {
    return this.session ? this.session.state : null
  }

  /** The session's tab, for the media list and the players. */
  get sessionTab(): string | null {
    return this.session?.tabId ?? null
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Start reading `tabId`'s document: from the top, from the selection, the reader article, or
   * one sentence. A session on another tab (or this one) ends first: one session.
   */
  async start(args: { tabId: string; from?: ReadAloudStartFrom }): Promise<void> {
    const tab = this.browser.tabs.tab(args.tabId)
    const view = this.browser.tabs.view(args.tabId)
    if (!tab || !view || view.isDestroyed()) return
    this.stop()
    if (!this.host) {
      // The UIs hide their entry points without the capability; a caller that asks anyway sees why.
      this.session = this.newSession(tab.id, tab.url, 'page', tab.title, '')
      this.fail(this.session, 'unavailable')
      return
    }
    const from = args.from ?? 'top'
    const wantsReader = from === 'reader' || this.browser.reader.isReaderUrl(tab.url)
    const source: ReadAloudSource =
      from === 'selection' ? 'selection' : wantsReader ? 'reader' : 'page'
    const session = this.newSession(tab.id, tab.url, source, tab.title, '')
    this.session = session
    this.changed()

    let text: ReadAloudText | null = null
    let positions: Map<string, ReadAloudBlockPosition> | null = null
    if (source === 'reader' && this.browser.reader.isReaderUrl(tab.url)) {
      text = this.readerText(tab.url, tab.title)
    } else {
      const extraction = await this.extractFromPage(
        tab,
        view,
        source === 'selection' ? 'selection' : 'top'
      )
      if (this.session !== session) return
      if (extraction) {
        positions = new Map(extraction.blocks.map((b) => [b.id, b.at]))
        const blocks: ReadAloudBlock[] = extraction.blocks.map((b) =>
          b.lang
            ? { id: b.id, kind: b.kind, text: b.text, lang: b.lang }
            : { id: b.id, kind: b.kind, text: b.text }
        )
        const lang = extraction.lang || this.detectedLanguage(tab.id) || this.uiLanguage()
        text = {
          source,
          title: extraction.title || tab.title,
          lang,
          blocks,
          sentences: segmentSentences(blocks, lang)
        }
      }
    }
    if (this.session !== session) return
    if (!text || text.sentences.length === 0) {
      this.fail(session, 'no-text')
      return
    }
    session.text = text
    session.positions = positions
    session.state.title = text.title
    session.state.lang = text.lang
    session.state.sentenceCount = text.sentences.length

    const voices = await this.voices()
    if (this.session !== session) return
    const resolved = resolveReadAloudVoice(
      voices,
      text.lang,
      this.settings().voiceByLanguage,
      this.uiLanguage()
    )
    session.voiceId = resolved.voiceId
    session.state.voiceId = resolved.voiceId
    if (resolved.voiceId === null) {
      this.fail(session, 'no-voice')
      return
    }
    this.speak(session, this.startIndex(text, from))
  }

  /** Pause a playing session, resume a paused one, restart an ended (or failed) one. */
  toggle(): void {
    const session = this.session
    if (!session) return
    if (session.state.status === 'playing') this.pause()
    else if (session.state.status !== 'loading') this.resume()
  }

  pause(): void {
    const session = this.session
    if (!session || !this.host || session.state.status !== 'playing') return
    if (this.host.pause && this.host.resume) {
      this.host.pause()
    } else {
      // No pause on this host: stop, and start the sentence over on resume.
      session.utteranceId = null
      session.prepared = null
      this.host.stop()
      session.resumeFromStart = true
    }
    session.state.status = 'paused'
    this.syncSource(session)
    this.changed()
  }

  resume(): void {
    const session = this.session
    if (!session || !this.host) return
    switch (session.state.status) {
      case 'paused':
        if (this.host.resume && !session.resumeFromStart && session.utteranceId) {
          this.host.resume()
          session.state.status = 'playing'
          this.syncSource(session)
          this.changed()
        } else {
          this.speak(session, Math.max(0, session.state.sentenceIndex))
        }
        return
      case 'ended':
        this.speak(session, 0)
        return
      case 'error':
        if (session.text.sentences.length > 0 && session.voiceId !== null)
          this.speak(session, Math.max(0, session.state.sentenceIndex))
        return
      default:
        return
    }
  }

  /** End the session: speech stops, the highlight clears, the OS controls let go, the state is idle. */
  stop(): void {
    const session = this.session
    if (!session) return
    this.session = null
    session.utteranceId = null
    session.prepared = null
    this.host?.stop()
    this.clearHighlight(session)
    this.releaseSource(session)
    this.changed()
  }

  next(): void {
    const session = this.session
    if (!session || !this.speakable(session)) return
    const index = session.state.sentenceIndex + 1
    if (index >= session.text.sentences.length) this.end(session)
    else this.speak(session, index)
  }

  previous(): void {
    const session = this.session
    if (!session || !this.speakable(session)) return
    this.speak(session, Math.max(0, session.state.sentenceIndex - 1))
  }

  seek(args: { sentenceIndex: number }): void {
    const session = this.session
    if (!session || !this.speakable(session)) return
    const count = session.text.sentences.length
    const index = Math.floor(Number(args.sentenceIndex))
    if (!Number.isFinite(index)) return
    this.speak(session, Math.max(0, Math.min(count - 1, index)))
  }

  /** The speed, saved and shown at once; the host takes it from the next sentence. */
  setRate(args: { rate: number }): void {
    const rate = sanitizeReadAloudRate(args.rate)
    const settings = this.settings()
    if (settings.rate !== rate) {
      this.browser.state.settings.readAloud = { ...settings, rate }
      this.browser.state.commit()
    }
    if (this.session) {
      this.session.state.rate = rate
      this.changed()
    }
  }

  /**
   * The voice for a language: the session's (`voiceByLanguage[lang]`), or `args.lang`'s without
   * one (a Settings picker). Saved; the session speaks with it from the next sentence.
   */
  setVoice(args: { voiceId: string; lang?: string }): void {
    if (typeof args.voiceId !== 'string' || !args.voiceId) return
    const session = this.session
    const lang = normalizeLanguageTag(args.lang) || (session ? session.text.lang : '')
    if (!lang) return
    const settings = this.settings()
    if (settings.voiceByLanguage[lang] !== args.voiceId) {
      this.browser.state.settings.readAloud = {
        ...settings,
        voiceByLanguage: { ...settings.voiceByLanguage, [lang]: args.voiceId }
      }
      this.browser.state.commit()
    }
    if (session && (lang === session.text.lang || !args.lang)) {
      const voices = this.voiceList
      if (voices && !voices.some((v) => v.id === args.voiceId)) return
      session.voiceId = args.voiceId
      session.state.voiceId = args.voiceId
      if (session.state.status === 'error' && session.state.error === 'no-voice')
        this.speak(session, Math.max(0, session.state.sentenceIndex))
      else this.changed()
    }
  }

  setHighlight(args: { mode: ReadAloudHighlightMode }): void {
    if (!READ_ALOUD_HIGHLIGHT_MODES.includes(args.mode)) return
    const settings = this.settings()
    if (settings.highlight !== args.mode) {
      this.browser.state.settings.readAloud = { ...settings, highlight: args.mode }
      this.browser.state.commit()
    }
    const session = this.session
    if (session && session.state.highlight !== args.mode) {
      session.state.highlight = args.mode
      this.paint(session)
      this.changed()
    }
  }

  /** The host's voices and the per-language default among them (the pickers). */
  async voicesResult(): Promise<ReadAloudVoicesResult> {
    const voices = await this.voices()
    const extra = [this.uiLanguage(), this.session?.text.lang ?? '']
    return {
      voices,
      byLanguage: voicesByLanguage(voices, this.settings().voiceByLanguage, extra)
    }
  }

  /** The settings changed under the service (a settings patch, a sync merge). */
  onSettingsChanged(): void {
    const session = this.session
    if (!session) return
    const settings = this.settings()
    let changed = false
    if (session.state.rate !== settings.rate) {
      session.state.rate = settings.rate
      changed = true
    }
    if (session.state.highlight !== settings.highlight) {
      session.state.highlight = settings.highlight
      this.paint(session)
      changed = true
    }
    if (changed) this.changed()
  }

  // ---------------------------------------------------------------------------
  // The page script's answer, and the tab's life
  // ---------------------------------------------------------------------------

  /** The page script answered `readAloud.extract` (the `readAloud` page message). */
  handleMessage(tabId: string, raw: unknown): void {
    const extraction = readAloudExtractionOf(raw)
    if (!extraction) return
    const pending = this.pending.get(extraction.requestId)
    if (!pending || pending.tabId !== tabId) return
    this.pending.delete(extraction.requestId)
    pending.resolve(extraction)
  }

  /**
   * The tab moved to another document: its session ends. The reader entering or leaving on the
   * same page starts over from the top of the new document once it is ready.
   */
  onNavigated(tabId: string, inPage = false): void {
    if (inPage) return
    this.dropPending(tabId)
    const session = this.session
    if (!session || session.tabId !== tabId) return
    const active =
      session.state.status === 'playing' ||
      session.state.status === 'paused' ||
      session.state.status === 'loading'
    const to = this.browser.tabs.tab(tabId)?.url ?? ''
    this.stop()
    if (active && this.readerSwitch(session.url, to)) this.restartOnReady = tabId
  }

  /** The new document is ready: a reader switch resumes reading from its top. */
  onPageReady(tabId: string): void {
    if (this.restartOnReady !== tabId) return
    this.restartOnReady = null
    void this.start({ tabId, from: 'top' })
  }

  /** The tab closed or its page was unloaded. */
  onTabGone(tabId: string): void {
    this.dropPending(tabId)
    if (this.restartOnReady === tabId) this.restartOnReady = null
    if (this.session?.tabId === tabId) {
      // The view is gone: nothing to clear in the page, but speech stops and the source lets go.
      const session = this.session
      this.session = null
      session.utteranceId = null
      this.host?.stop()
      this.releaseSource(session)
      this.changed()
    }
  }

  // ---------------------------------------------------------------------------
  // Speaking
  // ---------------------------------------------------------------------------

  private speak(session: Session, index: number): void {
    if (!this.host) return
    const sentence = session.text.sentences[index]
    if (!sentence) return
    const state = session.state
    state.sentenceIndex = index
    state.word = null
    state.status = 'playing'
    delete state.error
    session.resumeFromStart = false
    const utteranceId =
      session.prepared?.index === index ? session.prepared.utteranceId : this.nextUtteranceId()
    session.prepared = null
    session.utteranceId = utteranceId
    const options = this.optionsFor(session, index)
    state.voiceId = options.voiceId
    this.host.speak(utteranceId, sentence.text, options)
    this.paint(session)
    this.syncSource(session)
    this.changed()
  }

  /** The voice, language and rate a sentence speaks with: a block's own language switches the voice when one exists. */
  private optionsFor(
    session: Session,
    index: number
  ): { voiceId: string | null; lang: string; rate: number } {
    const sentence = session.text.sentences[index]
    const block = session.text.blocks.find((b) => b.id === sentence.blockId)
    const lang = block?.lang || session.text.lang
    let voiceId = session.voiceId
    if (block?.lang && block.lang !== session.text.lang && this.voiceList) {
      voiceId =
        voiceForLanguage(this.voiceList, block.lang, this.settings().voiceByLanguage) ?? voiceId
    }
    return { voiceId, lang, rate: session.state.rate }
  }

  private onHostEvent(utteranceId: string, event: SpeechHostEvent): void {
    const session = this.session
    if (!session || session.utteranceId !== utteranceId) return
    const state = session.state
    switch (event.type) {
      case 'start': {
        if (state.status === 'paused') return
        if (state.status !== 'playing') {
          state.status = 'playing'
          this.changed()
        }
        this.prepareNext(session)
        return
      }
      case 'word': {
        if (state.status !== 'playing') return
        const text = session.text.sentences[state.sentenceIndex]?.text ?? ''
        const start = Math.max(0, Math.min(text.length, Math.floor(event.charIndex ?? 0)))
        const end =
          event.length !== undefined && event.length > 0
            ? Math.min(text.length, start + Math.floor(event.length))
            : wordEnd(text, start)
        state.word = end > start ? { start, end } : null
        if (state.highlight === 'word' || state.highlight === 'both') this.paint(session)
        this.changed()
        return
      }
      case 'end': {
        if (state.status !== 'playing') return
        const index = state.sentenceIndex + 1
        if (index < session.text.sentences.length) this.speak(session, index)
        else this.end(session)
        return
      }
      case 'error': {
        session.utteranceId = null
        session.prepared = null
        state.status = 'error'
        state.error = event.message || 'synthesis-failed'
        state.word = null
        this.syncSource(session)
        this.changed()
        return
      }
    }
  }

  /** The host can get the next sentence ready while this one speaks (`prepare`). */
  private prepareNext(session: Session): void {
    const host = this.host
    if (!host?.prepare) return
    const index = session.state.sentenceIndex + 1
    const sentence = session.text.sentences[index]
    if (!sentence) return
    const utteranceId = this.nextUtteranceId()
    session.prepared = { index, utteranceId }
    host.prepare(utteranceId, sentence.text, this.optionsFor(session, index))
  }

  /**
   * The last sentence is done: the state says so, the highlight clears, and the OS controls stay
   * up in paused form (play starts the text over), until stop dismisses them.
   */
  private end(session: Session): void {
    session.utteranceId = null
    session.prepared = null
    session.state.status = 'ended'
    session.state.word = null
    this.clearHighlight(session)
    this.syncSource(session)
    this.changed()
  }

  private fail(session: Session, error: string): void {
    session.utteranceId = null
    session.state.status = 'error'
    session.state.error = error
    session.state.word = null
    this.syncSource(session)
    this.changed()
  }

  private speakable(session: Session): boolean {
    return session.text.sentences.length > 0 && session.voiceId !== null
  }

  private nextUtteranceId(): string {
    return `ra${++this.utteranceSeq}`
  }

  /** Where `start` begins: the top, or the sentence named (a block's nth, or the global index). */
  private startIndex(text: ReadAloudText, from: ReadAloudStartFrom): number {
    if (typeof from !== 'object') return 0
    const inBlock = text.sentences.filter((s) => s.blockId === from.blockId)
    const n = Math.floor(Number(from.sentenceIndex))
    if (inBlock.length > 0) {
      if (n >= 0 && n < inBlock.length) return inBlock[n].index
      const global = text.sentences[n]
      if (global && global.blockId === from.blockId) return global.index
      return inBlock[0].index
    }
    return n >= 0 && n < text.sentences.length ? n : 0
  }

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------

  /** The reader article behind a `zen://reader` URL, walked into blocks (no page round trip). */
  private readerText(url: string, tabTitle: string): ReadAloudText | null {
    let id: string | null = null
    try {
      id = new URL(url).searchParams.get('id')
    } catch {
      id = null
    }
    const article = id ? this.browser.reader.article(id) : undefined
    if (!article) return null
    const lang = normalizeLanguageTag(article.lang) || this.uiLanguage()
    const blocks = blocksFromHtml(article.content, lang)
    return {
      source: 'reader',
      title: article.title || tabTitle,
      lang,
      blocks,
      sentences: segmentSentences(blocks, lang)
    }
  }

  /**
   * Ask the page script for the text: from the top (Readability's article marks the main
   * content when the page is readerable and the library is at hand) or from the selection.
   */
  private async extractFromPage(
    tab: { id: string; url: string; readerable: boolean },
    view: TabView,
    from: 'top' | 'selection'
  ): Promise<ReadAloudExtraction | null> {
    if (!view.postToPage) return null
    const generation = this.generation
    let keep: string[] | null = null
    if (from === 'top' && tab.readerable) {
      keep = await this.readabilityBlocks(view)
      if (this.generation !== generation) return null
    }
    const requestId = newId('ra')
    const extraction = new Promise<ReadAloudExtraction | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(null)
      }, EXTRACT_TIMEOUT_MS)
      this.pending.set(requestId, {
        tabId: tab.id,
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        }
      })
    })
    view.postToPage({ type: 'readAloud', action: 'extract', requestId, from, keep })
    return extraction
  }

  /** The texts of the blocks Readability keeps of the page (its main content), or null when it cannot say. */
  private async readabilityBlocks(view: TabView): Promise<string[] | null> {
    const src = this.browser.platform.readabilitySource('Readability.js')
    if (!src) return null
    try {
      const raw = (await view.executeJavaScript(
        `(() => { ${src}
          try {
            const doc = document.cloneNode(true)
            const article = new Readability(doc, { keepClasses: false }).parse()
            if (!article) return null
            return { content: article.content, lang: article.lang }
          } catch (e) { return null }
        })()`
      )) as Pick<RawArticle, 'content' | 'lang'> | null
      if (!raw || typeof raw.content !== 'string' || !raw.content) return null
      const blocks = blocksFromHtml(sanitizeArticleHtml(raw.content), raw.lang ?? '')
      return blocks.length > 0 ? blocks.map((b) => b.text) : null
    } catch {
      return null
    }
  }

  private dropPending(tabId: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.tabId !== tabId) continue
      this.pending.delete(id)
      pending.resolve(null)
    }
  }

  /** Whether `to` is `from`'s reader view, or the page behind `from`'s reader view. */
  private readerSwitch(from: string, to: string): boolean {
    const { reader } = this.browser
    if (reader.isReaderUrl(to)) return reader.originalUrl(to) === from
    if (reader.isReaderUrl(from)) return reader.originalUrl(from) === to
    return false
  }

  // ---------------------------------------------------------------------------
  // Voices and languages
  // ---------------------------------------------------------------------------

  private async voices(): Promise<ReadAloudVoice[]> {
    if (this.voiceList) return this.voiceList
    if (!this.host) return []
    let voices: ReadAloudVoice[] = []
    try {
      voices = await this.host.voices()
    } catch {
      voices = []
    }
    this.voiceList = voices
    return voices
  }

  /** The page's language as the translate engine detected it ('' when it has not). */
  private detectedLanguage(tabId: string): string {
    const translate = this.browser.translate as
      { tabState?(tabId: string): { source: string | null } | null } | undefined
    return normalizeLanguageTag(translate?.tabState?.(tabId)?.source ?? '')
  }

  /** The UI language: the first language the user reads (the translate preferences), `en` without. */
  private uiLanguage(): string {
    const translate = this.browser.translate as
      { uiState?(): { preferences: { preferred: string[] } } } | undefined
    return normalizeLanguageTag(translate?.uiState?.().preferences.preferred[0] ?? '') || 'en'
  }

  private settings(): ReadAloudSettings {
    return this.browser.state.settings.readAloud
  }

  // ---------------------------------------------------------------------------
  // The highlight
  // ---------------------------------------------------------------------------

  /** Paint the current sentence and word into the page (`mode: 'off'` clears). */
  private paint(session: Session): void {
    const view = this.view(session.tabId)
    if (!view?.postToPage) return
    const sentence = session.text.sentences[session.state.sentenceIndex]
    if (!sentence) return
    const mode = session.state.highlight
    if (mode !== 'off') this.ensureCss(session, view)
    view.postToPage({
      type: 'readAloud',
      action: 'highlight',
      tabId: session.tabId,
      blockId: sentence.blockId,
      at: session.positions?.get(sentence.blockId) ?? null,
      sentence: { start: sentence.start, end: sentence.end },
      word: mode === 'word' || mode === 'both' ? session.state.word : null,
      mode
    })
  }

  private clearHighlight(session: Session): void {
    const view = this.view(session.tabId)
    if (view?.postToPage) {
      const sentence = session.text.sentences[Math.max(0, session.state.sentenceIndex)]
      view.postToPage({
        type: 'readAloud',
        action: 'highlight',
        tabId: session.tabId,
        blockId: sentence?.blockId ?? '',
        at: null,
        sentence: { start: 0, end: 0 },
        word: null,
        mode: 'off'
      })
    }
    const key = session.cssKey
    session.cssKey = null
    if (key && view) {
      void key.then((k) => (k ? view.removeInsertedCSS(k) : undefined)).catch(() => undefined)
    }
  }

  /** Web pages get the highlight's style inserted once per session; the reader page styles it itself. */
  private ensureCss(session: Session, view: TabView): void {
    if (session.cssKey || session.url.startsWith('zen:')) return
    session.cssKey = view.insertCSS(READ_ALOUD_HIGHLIGHT_CSS).catch(() => null)
  }

  private view(tabId: string): TabView | undefined {
    const view = this.browser.tabs.view(tabId)
    return view && !view.isDestroyed() ? view : undefined
  }

  // ---------------------------------------------------------------------------
  // The media session (contract 2.5)
  // ---------------------------------------------------------------------------

  /**
   * The player in the OS controls and the in-app media list: registered with the first sentence
   * spoken (a start that fails leaves nothing to control), updated on every status change after –
   * paused, playing again, ended, an error – so the notification stays up in paused form with
   * play taking it on (or over, after the end), as a page's does. `releaseSource` on stop and when
   * the tab goes. A private tab's source shows no title or site: the engine blanks it.
   */
  private syncSource(session: Session): void {
    const described = this.describeSource(session)
    if (session.source) {
      session.source.update(described)
      return
    }
    if (!described.playing) return
    const source: MediaSessionSource = {
      id: READ_ALOUD_SOURCE_ID,
      tabId: session.tabId,
      ...described,
      onAction: (action) => this.onSourceAction(session, action)
    }
    session.source = this.browser.mediaSession.registerSource(source)
  }

  private releaseSource(session: Session): void {
    const handle = session.source
    session.source = null
    handle?.release()
  }

  /** What the controls show: the text's title over the site being read (the reader's original page). */
  private describeSource(session: Session): Omit<MediaSessionSource, 'id' | 'tabId' | 'onAction'> {
    const url = this.browser.reader.isReaderUrl(session.url)
      ? (this.browser.reader.originalUrl(session.url) ?? session.url)
      : session.url
    return {
      title: session.state.title,
      artist: siteOf(url),
      artwork: null,
      playing: session.state.status === 'playing',
      actions: READ_ALOUD_SOURCE_ACTIONS,
      position: null
    }
  }

  /**
   * An action from the OS controls, the in-app player or the host's focus loss: `play` resumes
   * (retries after an error, starts over after the end), `pause` pauses – the focus loss's pause
   * included, an ordinary pause with no auto-resume – the tracks step the sentences, `stop` ends.
   */
  private onSourceAction(session: Session, action: MediaSessionAction | 'toggle'): void {
    if (this.session !== session) return
    switch (action) {
      case 'play':
        this.resume()
        return
      case 'pause':
        this.pause()
        return
      case 'toggle':
        this.toggle()
        return
      case 'stop':
        this.stop()
        return
      case 'nexttrack':
        this.next()
        return
      case 'previoustrack':
        this.previous()
        return
      default:
        return
    }
  }

  // ---------------------------------------------------------------------------

  private newSession(
    tabId: string,
    url: string,
    source: ReadAloudSource,
    title: string,
    lang: string
  ): Session {
    const settings = this.settings()
    return {
      generation: ++this.generation,
      tabId,
      url,
      text: { source, title, lang, blocks: [], sentences: [] },
      positions: null,
      state: {
        tabId,
        status: 'loading',
        source,
        title,
        lang,
        sentenceIndex: -1,
        sentenceCount: 0,
        word: null,
        rate: settings.rate,
        voiceId: null,
        highlight: settings.highlight
      },
      voiceId: null,
      utteranceId: null,
      prepared: null,
      resumeFromStart: false,
      cssKey: null,
      source: null
    }
  }

  private changed(): void {
    this.browser.state.commitVolatile()
  }
}

/** Where the word starting at `start` ends: the next whitespace, or the text's end. */
export function wordEnd(text: string, start: number): number {
  const rest = text.slice(start)
  const match = /^\s*\S+/.exec(rest)
  return match ? start + match[0].length : text.length
}

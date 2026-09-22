import type { Tab } from '../shared/types'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { readerPage, type ReaderShown } from './readerPage'
import { readerPreferencesPatch, type ReaderPreferences } from '../shared/reader'
import { renderArticleHtml, splitArticleHtml, type ArticleSplit } from './translate/articleHtml'

export const READER_URL_PREFIX = 'zen://reader'

export type ReadabilityFile = 'Readability.js' | 'Readability-readerable.js'

export interface ReaderArticle {
  id: string
  url: string
  title: string
  byline: string | null
  siteName: string | null
  excerpt: string | null
  /** Sanitised article HTML. */
  content: string
  /** Character count (for the reading-time estimate). */
  length: number
  lang: string | null
  dir: 'ltr' | 'rtl' | null
  /** `content` in translatable units (CT-36), made the first time the document is rendered. */
  split?: ArticleSplit | null
  /** The article's translation while one stands (`TranslateService.translateReader`). */
  translation?: ReaderArticleTranslation | null
}

/**
 * The reader article translated in the core (CT-36): per unit of the split the translated run
 * (null while the engine has not answered for it), the title, and whether the document shows the
 * translation or – the Show original toggle – the article as written, the translation kept.
 */
export interface ReaderArticleTranslation {
  /** Registry codes (`es`, `zh-Hans`). */
  source: string
  target: string
  title: string | null
  units: (string | null)[]
  showOriginal: boolean
}

/** The article id a `zen://reader` URL names, null for any other URL. */
export function readerArticleId(url: string): string | null {
  if (!url.startsWith(READER_URL_PREFIX)) return null
  try {
    return new URL(url).searchParams.get('id')
  } catch {
    return null
  }
}

/** What Readability's `parse()` returns, before the service cleans and stores it. */
export interface RawArticle {
  title?: string
  byline?: string | null
  siteName?: string | null
  excerpt?: string | null
  content?: string
  length?: number
  lang?: string | null
  dir?: string | null
}

/**
 * Firefox's Reader View for Zen: Mozilla's Readability runs inside the page, the extracted
 * article is rendered by the `zen://reader` page with the usual typography controls.
 */
export class ReaderService {
  private readonly articles = new Map<string, ReaderArticle>()
  private readonly sources = new Map<ReadabilityFile, string>()

  constructor(private readonly browser: Browser) {}

  /**
   * Mozilla's Readability is injected into pages as source text; the host supplies it (Electron
   * reads the externalised package at runtime, Android bundles it). Null when unavailable.
   */
  private source(file: ReadabilityFile): string | null {
    let src = this.sources.get(file)
    if (src === undefined) {
      const loaded = this.browser.platform.readabilitySource(file)
      if (loaded === null) return null
      src = loaded
      this.sources.set(file, src)
    }
    return src
  }

  /** HTML of the `zen://reader` page for an article id (null once the article is gone). */
  pageHtml(id: string): string | null {
    const article = this.articles.get(id)
    return article ? readerPage(article, this.preferences(), this.shown(article)) : null
  }

  /** The article's units (CT-36): split once, kept with it. */
  split(article: ReaderArticle): ArticleSplit {
    return (article.split ??= splitArticleHtml(article.content))
  }

  /** The unit's HTML as the document shows it: the translation where one stands and shows, else as written. */
  shownUnit(article: ReaderArticle, id: number): string {
    const translation = article.translation
    const translated = translation && !translation.showOriginal ? translation.units[id] : null
    return translated ?? this.split(article).units[id]?.html ?? ''
  }

  /**
   * What the document shows of the article (CT-36): the content with every unit as it stands
   * (translated where the translation shows), the title, the language – the translation's
   * target while it shows, else the article's own. What the page renders from, and what read
   * aloud speaks when the document does not answer (`ReadAloudService.readerText`).
   */
  shown(article: ReaderArticle): ReaderShown {
    const translation = article.translation ?? null
    const translated = translation !== null && !translation.showOriginal
    return {
      content: renderArticleHtml(this.split(article), (id) => this.shownUnit(article, id)),
      title: (translated ? translation.title : null) ?? article.title,
      lang: translated ? translation.target : article.lang
    }
  }

  /** The article a tab's reader document shows, undefined for any other tab. */
  articleOf(tabId: string): ReaderArticle | undefined {
    const tab = this.browser.tabs.tab(tabId)
    const id = tab ? readerArticleId(tab.url) : null
    return id ? this.articles.get(id) : undefined
  }

  /**
   * Show the article's translation (or, `null`, the article as written again) in the tab's open
   * reader document (CT-36): the units named (every one when omitted), the title and the language
   * as they stand now, swapped in place through `window.zenReaderShow`. A fresh load renders the
   * same from `pageHtml`.
   */
  pushShown(tabId: string, article: ReaderArticle, unitIds?: readonly number[]): void {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    const split = this.split(article)
    const ids = unitIds ?? split.units.map((unit) => unit.id)
    const units = ids.map((id) => [id, this.shownUnit(article, id)] as const)
    const shown = this.shown(article)
    const call = `window.zenReaderShow && window.zenReaderShow(${JSON.stringify(units)}, ${JSON.stringify(shown.title)}, ${JSON.stringify(shown.lang ?? '')})`
    void view.executeJavaScript(call).catch(() => undefined)
  }

  /** The text preferences every reader page is rendered with (Settings, persisted). */
  preferences(): ReaderPreferences {
    return this.browser.state.settings.reader
  }

  /**
   * Change the text preferences (CT-20, EDGE-13): from the chrome's Text preferences sheet /
   * popover (the one home, v2 §10.1; the reader document draws no toolbar of its own), a
   * settings patch, or a `zen:` document's own message (relayed by the page script, kept for a
   * document that grows a control). Saved with the profile and pushed to every open reader
   * page, so a second reader tab follows the first.
   */
  setPreferences(patch: Partial<ReaderPreferences>): void {
    const clean = readerPreferencesPatch(patch)
    if (!clean) return
    const current = this.preferences()
    const next = { ...current, ...clean }
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.browser.state.settings.reader = next
    this.pushPreferences()
    this.browser.state.commit()
  }

  /** The setting changed under the service (a settings patch, a sync merge). */
  onPreferencesChanged(): void {
    this.pushPreferences()
  }

  /** Every open reader page takes the saved preferences (`window.zenReaderApply`). */
  private pushPreferences(): void {
    const prefs = JSON.stringify(this.preferences())
    for (const tab of Object.values(this.browser.state.model.tabs)) {
      if (!this.isReaderUrl(tab.url) || tab.discarded) continue
      const view = this.browser.tabs.view(tab.id)
      if (!view) continue
      void view
        .executeJavaScript(`window.zenReaderApply && window.zenReaderApply(${prefs})`)
        .catch(() => undefined)
    }
  }

  isReaderUrl(url: string): boolean {
    return url.startsWith(READER_URL_PREFIX)
  }

  canRead(tab: Tab | undefined): boolean {
    return Boolean(tab && (tab.readerable || this.isReaderUrl(tab.url)) && !tab.discarded)
  }

  article(id: string): ReaderArticle | undefined {
    return this.articles.get(id)
  }

  /** The original page URL behind a reader URL. */
  originalUrl(readerUrl: string): string | null {
    try {
      return new URL(readerUrl).searchParams.get('url')
    } catch {
      return null
    }
  }

  /** Called on `dom-ready`: ask the page whether it looks like an article. */
  async detect(tabId: string): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    const src = this.source('Readability-readerable.js')
    if (!tab || !view || !src || !/^https?:/.test(tab.url)) {
      if (tab && tab.readerable) {
        tab.readerable = false
        this.browser.state.commitVolatile()
      }
      return
    }
    try {
      const result = await view.executeJavaScript(
        `(() => { ${src}\n try { return isProbablyReaderable(document) } catch { return false } })()`
      )
      const current = this.browser.tabs.tab(tabId)
      if (current && current.readerable !== Boolean(result)) {
        current.readerable = Boolean(result)
        this.browser.state.commitVolatile()
      }
    } catch {
      /* page went away */
    }
  }

  /** Enter Reader View for a page, or leave it when already reading. */
  toggle(tabId: string, win: ZenWindow): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    if (this.isReaderUrl(tab.url)) {
      const original = this.originalUrl(tab.url)
      if (original) this.browser.tabs.navigate(tabId, original)
      return
    }
    void this.enter(tabId, win)
  }

  private async enter(tabId: string, win: ZenWindow): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    const src = this.source('Readability.js')
    if (!tab || !view || !/^https?:/.test(tab.url)) return
    if (!src) {
      this.browser.toast('Reader View is not available on this device.', 'info', win)
      return
    }
    let raw: RawArticle | null = null
    try {
      raw = (await view.executeJavaScript(
        `(() => { ${src}
          try {
            const doc = document.cloneNode(true)
            const article = new Readability(doc, { keepClasses: false }).parse()
            if (!article) return null
            return { title: article.title, byline: article.byline, siteName: article.siteName, excerpt: article.excerpt, content: article.content, length: article.length, lang: article.lang, dir: article.dir }
          } catch (e) { return null }
        })()`
      )) as RawArticle | null
    } catch {
      raw = null
    }
    if (!raw || !raw.content) {
      this.browser.toast('This page cannot be shown in Reader View.', 'info', win)
      return
    }
    this.open(tabId, raw)
  }

  /**
   * Show an article already extracted from the tab's page in Reader View: the page script's
   * result here, or a host's own extraction (the preview host stands one in). The tab goes to
   * `zen://reader?id=…&url=…`, which renders it with the saved text preferences.
   */
  open(tabId: string, raw: RawArticle): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !raw.content) return
    const id = newId('article')
    const article: ReaderArticle = {
      id,
      url: tab.url,
      title: raw.title?.trim() || tab.title,
      byline: raw.byline?.trim() || null,
      siteName: raw.siteName?.trim() || null,
      excerpt: raw.excerpt?.trim() || null,
      content: sanitizeArticleHtml(raw.content),
      length: raw.length ?? raw.content.length,
      lang: raw.lang ?? null,
      dir: raw.dir === 'rtl' ? 'rtl' : raw.dir === 'ltr' ? 'ltr' : null,
      split: null,
      translation: null
    }
    this.articles.set(id, article)
    // Keep memory bounded: articles are only needed while their tab shows them.
    if (this.articles.size > 40) this.articles.delete(this.articles.keys().next().value as string)
    const params = new URLSearchParams({ id, url: tab.url })
    this.browser.tabs.navigate(tabId, `${READER_URL_PREFIX}?${params.toString()}`)
  }
}

/** Defensive clean-up on top of Readability's own: no scripts, handlers, frames or forms. */
export function sanitizeArticleHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(
      /<(iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ''
    )
    .replace(
      /<(iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[^>]*\/?>/gi,
      ''
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(href|src|srcset|action|formaction|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,
      ''
    )
    .replace(/\s(href|src)\s*=\s*("\s*data:text\/html[^"]*"|'\s*data:text\/html[^']*')/gi, '')
}

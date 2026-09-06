import readabilitySource from '@mozilla/readability/Readability.js?raw'
import readerableSource from '@mozilla/readability/Readability-readerable.js?raw'
import type { Tab } from '../../shared/types'
import { newId } from '../../shared/ids'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

export const READER_URL_PREFIX = 'zen://reader'

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
}

interface RawArticle {
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

  constructor(private readonly browser: Browser) {}

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
    const wc = this.browser.tabs.webContents(tabId)
    if (!tab || !wc || !/^https?:/.test(tab.url)) {
      if (tab && tab.readerable) {
        tab.readerable = false
        this.browser.state.commitVolatile()
      }
      return
    }
    try {
      const result = await wc.executeJavaScript(
        `(() => { ${readerableSource}\n try { return isProbablyReaderable(document) } catch { return false } })()`,
        true
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
    const wc = this.browser.tabs.webContents(tabId)
    if (!tab || !wc || !/^https?:/.test(tab.url)) return
    let raw: RawArticle | null = null
    try {
      raw = (await wc.executeJavaScript(
        `(() => { ${readabilitySource}
          try {
            const doc = document.cloneNode(true)
            const article = new Readability(doc, { keepClasses: false }).parse()
            if (!article) return null
            return { title: article.title, byline: article.byline, siteName: article.siteName, excerpt: article.excerpt, content: article.content, length: article.length, lang: article.lang, dir: article.dir }
          } catch (e) { return null }
        })()`,
        true
      )) as RawArticle | null
    } catch {
      raw = null
    }
    if (!raw || !raw.content) {
      this.browser.toast('This page cannot be shown in Reader View.', 'info', win)
      return
    }
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
      dir: raw.dir === 'rtl' ? 'rtl' : raw.dir === 'ltr' ? 'ltr' : null
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

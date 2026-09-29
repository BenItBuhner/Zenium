/**
 * Zenium as a share target: what another app handed over through `ACTION_SEND` or
 * `ACTION_WEB_SEARCH`, and where it goes. Pure routing, so the host only has to describe the
 * intent; the browser core resolves the search engine. Below it, the installed web apps'
 * own share targets (MW-63): which of them a share can go to, and the launch that hands it
 * over.
 */
import type { ImagePost } from './imageUpload'
import type { MenuHeader } from './types'
import type { WebAppShareTarget } from './webApp'

export interface SharedIntent {
  /** `send` for `ACTION_SEND`, `search` for `ACTION_WEB_SEARCH`. */
  kind: 'send' | 'search'
  /** `EXTRA_TEXT`, or the query of a web search. */
  text?: string | null
  /** `EXTRA_SUBJECT` (mail apps and some readers send the title here). */
  subject?: string | null
  /** The MIME type the sender declared (`text/plain`, `image/jpeg`, …). */
  mimeType?: string | null
  /** The shared image as a `data:` URL, when the sender attached one the host could read. */
  imageDataUrl?: string | null
}

export type SharedRoute =
  /** Open the URL in a tab. */
  | { kind: 'url'; url: string }
  /** Search for the text with the user's engine. */
  | { kind: 'search'; query: string }
  /** Show the shared image in a tab. */
  | { kind: 'image'; dataUrl: string }
  /** Nothing usable was shared. */
  | { kind: 'none' }

/** A URL anywhere in shared text: with a scheme, or a `www.` host (what Twitter and mail apps send). */
const URL_IN_TEXT_RE =
  /(?:https?:\/\/[^\s<>"']+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#][^\s<>"']*)?)/i

/** Trailing punctuation a sentence leaves stuck to a pasted URL (brackets are handled below). */
const TRAILING_PUNCTUATION_RE = /[.,;:!?\]}>'"]+$/

const count = (s: string, ch: string): number => s.split(ch).length - 1

/** The first URL in `text`, normalised to an `http(s)` address, or null. */
export function extractUrl(text: string): string | null {
  const match = URL_IN_TEXT_RE.exec(text)
  if (!match) return null
  let url = match[0]
  // Peel the sentence's punctuation off the end. A closing bracket only belongs to the URL when
  // it opened inside it (Wikipedia's "(band)"); an unbalanced one closes the sentence's "(…)".
  for (;;) {
    const stripped = url.replace(TRAILING_PUNCTUATION_RE, '')
    if (stripped.endsWith(')') && count(stripped, '(') < count(stripped, ')')) {
      url = stripped.slice(0, -1)
      continue
    }
    url = stripped
    break
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  try {
    return new URL(url).href
  } catch {
    return null
  }
}

/**
 * Where a shared intent goes: an image opens as a page of its own, text that carries a URL opens
 * that URL (the first one – a share from Twitter or a mail app is "title + link"), and any other
 * text – or a web search – is a query for the user's engine. The subject stands in for empty text.
 */
export function routeSharedIntent(intent: SharedIntent): SharedRoute {
  const text = (intent.text ?? '').trim()
  const subject = (intent.subject ?? '').trim()
  if (intent.kind === 'search') return text ? { kind: 'search', query: text } : { kind: 'none' }
  if (intent.mimeType?.toLowerCase().startsWith('image/')) {
    if (intent.imageDataUrl) return { kind: 'image', dataUrl: intent.imageDataUrl }
    // An image the host could not read: the text that came with it may still be a link.
    if (!text && !subject) return { kind: 'none' }
  }
  const url = extractUrl(text) ?? extractUrl(subject)
  if (url) return { kind: 'url', url }
  const query = text || subject
  return query ? { kind: 'search', query } : { kind: 'none' }
}

// ---------------------------------------------------------------------------
// Installed apps as share targets (MW-63)
// ---------------------------------------------------------------------------

/** The kinds of share an installed app can be offered: a link, or text. */
export type ShareKind = 'url' | 'text'

/** The share as a target's fields take it; a field the share has nothing for is null. */
export interface SharedFields {
  title: string | null
  text: string | null
  url: string | null
}

/**
 * How an app is launched with a share: a GET of its action with the fields as the query, or a
 * POST of the action with the fields as a form body (`ImagePost`, the body a tab's first load
 * can carry through `TabView.postURL`).
 */
export type ShareTargetLaunch =
  { method: 'GET'; url: string } | { method: 'POST'; url: string; post: ImagePost }

/** An installed app the share chooser offers: the row's identity (its 20 icon and name). */
export interface ShareChooserApp {
  id: string
  name: string
  icon: string | null
}

/**
 * The chooser the core raises when at least one installed app declares a target for what was
 * shared (`share.chooser`): the shared thing for the header, the kind (which names the house
 * route – a new tab for a link, a search for text) and the apps, answered by
 * `share.chooserPick` or `share.chooserCancel`.
 */
export interface ShareChooser {
  requestId: string
  kind: ShareKind
  /**
   * A shared link's header, the link menu's own (§9.31): the address under its title – the
   * share's subject, else the address's host – with the site's favicon; null for text.
   */
  link: MenuHeader | null
  /** Shared text's header: its first line, which the sheet clips to one (§9.31); null for a link. */
  text: string | null
  apps: ShareChooserApp[]
}

/** The header's title line is one line: the text's first, capped (the sheet clips the rest, §9.31). */
const MAX_CHOOSER_TITLE = 256

/**
 * Whether a target takes a share of `kind`: a link needs a field for the URL, text a field for
 * the text or its title. A file field alone takes neither (no file share is served yet).
 */
export function shareTargetAccepts(target: WebAppShareTarget, kind: ShareKind): boolean {
  const { params } = target
  return kind === 'url' ? params.url !== null : params.text !== null || params.title !== null
}

/**
 * What the share holds for a target's fields: the subject as the title, the text as shared,
 * and for a link the URL the text (or the subject) carried – Android's share intent has no
 * URL extra of its own, so the link is the one `routeSharedIntent` found. Text whose only
 * content is the subject is not repeated as its own title.
 */
export function sharedFields(intent: SharedIntent, route: SharedRoute): SharedFields | null {
  const text = (intent.text ?? '').trim()
  const subject = (intent.subject ?? '').trim()
  if (route.kind === 'url') return { title: subject || null, text: text || null, url: route.url }
  if (route.kind === 'search')
    return {
      title: subject && subject !== route.query ? subject : null,
      text: route.query,
      url: null
    }
  return null
}

/**
 * The launch for a target: each field the target names and the share has a value for, under
 * the target's own name for it. GET writes them into the action's query (`set`, so a field
 * the action's own query already carries is replaced rather than doubled, as Chromium's
 * `AppendOrReplaceQueryParameter` does); POST carries them as the form body, urlencoded or
 * multipart as the target's `enctype` says.
 */
export function shareTargetLaunch(
  target: WebAppShareTarget,
  fields: SharedFields
): ShareTargetLaunch {
  const pairs: Array<{ name: string; value: string }> = []
  const { params } = target
  if (params.title && fields.title) pairs.push({ name: params.title, value: fields.title })
  if (params.text && fields.text) pairs.push({ name: params.text, value: fields.text })
  if (params.url && fields.url) pairs.push({ name: params.url, value: fields.url })
  if (target.method === 'GET') {
    const u = new URL(target.action)
    for (const { name, value } of pairs) u.searchParams.set(name, value)
    return { method: 'GET', url: u.href }
  }
  return {
    method: 'POST',
    url: target.action,
    post: {
      encoding: target.enctype === 'multipart/form-data' ? 'multipart' : 'urlencoded',
      fields: pairs
    }
  }
}

/** The chooser header's title: the first line of the shared text, trimmed and capped. */
export function chooserTitleForText(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? text
  return first.trim().slice(0, MAX_CHOOSER_TITLE)
}

/**
 * The chooser header for a link: the subject as its title (a link without one, or whose
 * subject is the link itself, takes the address's host, as the link menu's header does, §9.31).
 */
export function chooserTitleForUrl(url: string, subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  if (s && extractUrl(s) !== url) return s.slice(0, MAX_CHOOSER_TITLE)
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

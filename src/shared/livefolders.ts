import type { LiveFolderConfig, LiveFolderMapping, LiveFolderProvider } from './types'

/** One entry produced by a live folder provider (Zen's `FolderItem`). */
export interface LiveItem {
  id: string
  title: string
  url: string
}

export const LIVE_FOLDER_INTERVALS = [15, 30, 60, 120, 240, 480]
export const LIVE_FOLDER_DEFAULT_INTERVAL = 30
export const LIVE_FOLDER_MAX_ITEMS = 100
/** Zen caps REST / feed responses at 1 MB. */
export const LIVE_FOLDER_MAX_BYTES = 1024 * 1024

export const LIVE_FOLDER_PROVIDERS: Array<{
  id: LiveFolderProvider
  label: string
  icon: string
  hint: string
}> = [
  {
    id: 'github-pulls',
    label: 'GitHub Pull Requests',
    icon: '🔀',
    hint: 'Open pull requests you authored'
  },
  {
    id: 'github-issues',
    label: 'GitHub Issues',
    icon: '🐛',
    hint: 'Open issues you authored or are assigned to'
  },
  { id: 'rss', label: 'RSS / Atom feed', icon: '📰', hint: 'Latest entries of a feed' },
  { id: 'rest', label: 'REST API', icon: '🔌', hint: 'Items from a JSON endpoint (with a mapping)' }
]

export function defaultLiveFolderConfig(
  folderId: string,
  provider: LiveFolderProvider
): LiveFolderConfig {
  return {
    folderId,
    provider,
    source: '',
    includeDrafts: true,
    token: '',
    mapping: provider === 'rest' ? { items: '', id: 'id', title: 'title', url: 'url' } : null,
    intervalMinutes: LIVE_FOLDER_DEFAULT_INTERVAL,
    maxItems: LIVE_FOLDER_MAX_ITEMS,
    lastFetched: null,
    lastError: null,
    dismissed: [],
    items: {}
  }
}

/** Human-readable label for the folder icon / hint. */
export function providerLabel(provider: LiveFolderProvider): string {
  return LIVE_FOLDER_PROVIDERS.find((p) => p.id === provider)?.label ?? provider
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * The GitHub search query for a live folder. `source` is a username, or – when it already
 * contains qualifiers like `repo:` – a raw search query.
 */
export function githubSearchQuery(
  config: Pick<LiveFolderConfig, 'provider' | 'source' | 'includeDrafts'>
): string {
  const source = config.source.trim().replace(/^@/, '')
  const isRaw = /[:\s]/.test(source)
  const parts: string[] = []
  if (isRaw) parts.push(source)
  else if (config.provider === 'github-pulls') parts.push(`author:${source}`)
  else parts.push(`involves:${source}`)
  if (!/\bis:(open|closed)\b/.test(source)) parts.push('is:open')
  if (!/\bis:(pr|issue)\b/.test(source))
    parts.push(config.provider === 'github-pulls' ? 'is:pr' : 'is:issue')
  if (config.provider === 'github-pulls' && !config.includeDrafts && !/\bdraft:/.test(source))
    parts.push('draft:false')
  if (!/\barchived:/.test(source)) parts.push('archived:false')
  return parts.join(' ')
}

export function githubSearchUrl(
  config: Pick<LiveFolderConfig, 'provider' | 'source' | 'includeDrafts' | 'maxItems'>
): string {
  const q = encodeURIComponent(githubSearchQuery(config))
  const perPage = Math.max(1, Math.min(100, config.maxItems))
  return `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=${perPage}`
}

interface GithubIssue {
  id?: number
  number?: number
  title?: string
  html_url?: string
  repository_url?: string
  draft?: boolean
}

export function parseGithubSearch(body: unknown, includeDrafts: boolean): LiveItem[] {
  const items = (body as { items?: GithubIssue[] } | null)?.items
  if (!Array.isArray(items)) return []
  const out: LiveItem[] = []
  for (const it of items) {
    if (!it || typeof it.html_url !== 'string' || typeof it.title !== 'string') continue
    if (!includeDrafts && it.draft) continue
    const repo = typeof it.repository_url === 'string' ? it.repository_url.split('/repos/')[1] : ''
    const title = repo && it.number ? `${it.title} · ${repo}#${it.number}` : it.title
    out.push({ id: String(it.id ?? it.html_url), title, url: it.html_url })
  }
  return out
}

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  return m ? decodeEntities(m[1]) : null
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)]
  let fallback: string | null = null
  for (const [, attrs] of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (!href) continue
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (!rel || rel === 'alternate') return decodeEntities(href)
    fallback ??= decodeEntities(href)
  }
  return fallback
}

/** Minimal RSS 2.0 / Atom parser: title, link and a stable id per entry. */
export function parseFeed(xml: string): LiveItem[] {
  const out: LiveItem[] = []
  const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  for (const [, kind, block] of entries) {
    const title = tagText(block, 'title') ?? ''
    let url: string | null
    if (kind.toLowerCase() === 'entry') url = atomLink(block)
    else url = tagText(block, 'link') ?? atomLink(block)
    if (!url) {
      const guid = tagText(block, 'guid')
      if (guid && /^https?:\/\//.test(guid)) url = guid
    }
    if (!url || !/^https?:\/\//i.test(url)) continue
    const id = tagText(block, 'guid') ?? tagText(block, 'id') ?? url
    out.push({ id, title: title || url, url })
  }
  return out
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)]
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[key]
    else return undefined
  }
  return cur
}

export function parseRestItems(
  body: unknown,
  mapping: LiveFolderMapping,
  baseUrl: string
): LiveItem[] {
  const list = getPath(body, mapping.items)
  if (!Array.isArray(list)) return []
  const out: LiveItem[] = []
  for (const entry of list) {
    const title = getPath(entry, mapping.title)
    const rawUrl = getPath(entry, mapping.url)
    const rawId = getPath(entry, mapping.id)
    if (typeof rawUrl !== 'string') continue
    let url: string
    try {
      url = new URL(rawUrl, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//.test(url)) continue
    out.push({
      id: rawId === undefined || rawId === null ? url : String(rawId),
      title: typeof title === 'string' && title.trim() ? title.trim() : url,
      url
    })
  }
  return out
}

/** Zen only accepts its strict schema from localhost endpoints (no arbitrary mapping). */
export function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

export const LOCAL_REST_MAPPING: LiveFolderMapping = {
  items: 'items',
  id: 'id',
  title: 'title',
  url: 'url'
}

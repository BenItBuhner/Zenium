/**
 * "Did you mean github.com?" for an address typed with a slip (`githb.com`, `gogle.com`): the
 * closest host the user has been to, or one of a short list of sites nearly everyone uses, within
 * one edit (two for a long host). No model, no network: plain edit distance, so it is instant
 * and private. Offered as a row under what was typed, never in its place.
 */

/** Sites common enough that a near miss on one is almost surely a typo. */
export const POPULAR_HOSTS: readonly string[] = [
  'google.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'reddit.com',
  'wikipedia.org',
  'amazon.com',
  'github.com',
  'gmail.com',
  'linkedin.com',
  'netflix.com',
  'yahoo.com',
  'bing.com',
  'duckduckgo.com',
  'microsoft.com',
  'apple.com',
  'stackoverflow.com',
  'twitch.tv',
  'discord.com',
  'spotify.com',
  'whatsapp.com',
  'openai.com',
  'claude.ai',
  'anthropic.com',
  'notion.so',
  'figma.com',
  'vercel.com',
  'cloudflare.com',
  'nytimes.com',
  'bbc.com',
  'cnn.com',
  'ebay.com',
  'paypal.com',
  'dropbox.com',
  'zoom.us',
  'slack.com',
  'pinterest.com',
  'tiktok.com'
]

/** Damerau–Levenshtein (optimal string alignment) distance, giving up past `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    rows.push([i])
    let best = i
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0][j] = j
        continue
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, rows[i - 2][j - 2] + 1)
      rows[i][j] = d
      best = Math.min(best, d)
    }
    if (i > 0 && best > max) return max + 1
  }
  return rows[a.length][b.length]
}

/** The host in what was typed, when it reads as one address: `githb.com`, `www.gogle.com/x`. */
export function typedHost(input: string): string | null {
  const t = input.trim().toLowerCase()
  if (!t || /\s/.test(t)) return null
  const m = /^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#].*)?$/.exec(t)
  if (!m) return null
  const host = m[1].replace(/^www\./, '')
  // An address literal or a bare number is never a slip on a name.
  if (/^[\d.]+$/.test(host)) return null
  return host
}

/**
 * The host the user most likely meant, or null when what was typed is already a known host or
 * nothing is close. `known` is in order of preference (most visited first); the popular list
 * comes after it.
 */
export function suggestHostFix(input: string, known: readonly string[]): string | null {
  const host = typedHost(input)
  if (!host || host.length < 5) return null
  const candidates = [...new Set([...known.map((h) => h.replace(/^www\./, '')), ...POPULAR_HOSTS])]
  if (candidates.includes(host)) return null
  const max = host.length > 10 ? 2 : 1
  let best: { host: string; d: number } | null = null
  for (const c of candidates) {
    const d = editDistance(host, c, max)
    if (d <= max && (!best || d < best.d)) best = { host: c, d }
    if (best?.d === 1 && max === 1) break
  }
  return best?.host ?? null
}

/**
 * Whether typed text reads as a question or a task for the agent rather than a search to run
 * at once: a question mark, or a sentence of several words that opens like a question or an ask.
 */
export function looksLikeAsk(input: string): boolean {
  const t = input.trim()
  if (t.length < 8 || typedHost(t)) return false
  if (/\?\s*$/.test(t)) return true
  const words = t.split(/\s+/)
  if (words.length < 4) return false
  return /^(what|why|how|when|where|who|which|is|are|can|could|should|does|do|find|compare|summari[sz]e|explain|help|plan|book|research|tell|show|write)\b/i.test(
    t
  )
}

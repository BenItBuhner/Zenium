import type { Tab } from '../../shared/types'
import type { ToolResult } from './protocol'

/**
 * How long the foreground lease outlives its holder's last foreground action: another agent in
 * foreground mode runs in the background until the holder has been quiet this long.
 */
export const FOREGROUND_LEASE_MS = 20_000

/**
 * A connected session quiet this long is a GHOST to the other agents: its groups may be adopted
 * as an orphan's. A client that drops without a DELETE – a killed shim, an editor's HTTP session
 * lost on restart – keeps its record "connected" until the idle park half an hour on, and until
 * then its groups were refused to everyone ("belongs to an agent which is still connected"),
 * the user's permission or not. Two minutes is longer than any tool call takes, so a working
 * agent is never mistaken for a ghost; `force: true` covers the rest.
 */
export const GHOST_IDLE_MS = 2 * 60 * 1000

/** A quiet spell, as listings and notices say it: "40 s", "3 min", "2 h". */
export function describeIdle(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min`
  return `${Math.round(min / 60)} h`
}

export function textError(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** The title agents see for a tab: the user's custom title when set, else the page's. */
export function titleOf(t: Tab): string {
  return (t.customTitle ?? t.title) || '(untitled)'
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 48 hex characters from the platform's CSPRNG (Node and browsers both expose `crypto`). */
export function randomToken(): string {
  const bytes = new Uint8Array(24)
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Without a parser: does this read as a statement list rather than one expression? Used where a
 * host must run scripts written in either shape (Electron's executeJavaScript accepts both) and
 * where the core itself may not compile code (the Android chrome's CSP).
 */
export function looksLikeStatements(source: string): boolean {
  const s = source.trim()
  if (/^(const|let|var|if|for|while|do|switch|try|return|throw)\b/.test(s)) return true
  // A function (arrow or classic) is one expression however many statements its body has; the
  // wrapper calls it.
  if (/^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s) || /^(async\s+)?function\b/.test(s))
    return false
  if (/^\s*(return|const|let|var|if|for|while|try|throw)\b/m.test(s)) return true
  // `a(); b()` – a semicolon followed by more code (one trailing `;` is still an expression).
  return /;\s*\S/.test(s)
}

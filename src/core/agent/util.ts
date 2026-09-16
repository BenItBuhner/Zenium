import type { ToolResult } from './protocol'

export function textError(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
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

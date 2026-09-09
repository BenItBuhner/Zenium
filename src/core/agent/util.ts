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

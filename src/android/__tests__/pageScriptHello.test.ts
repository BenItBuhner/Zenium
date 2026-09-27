// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The page script's hello (`src/android/pageScript.ts`), caught at install on the
 * `__zenPageBridge` stand-in: it carries the document's navigation start
 * (`performance.timeOrigin`), which `TabWebView.onPageMessage` reads as the frame-owner
 * protocol's document boundary (`ImageOwner.documentStarted`) for the main frame and as a
 * sub-frame's stamp (`ImageOwner.registerFrame`). Its shape is pinned: the field is the whole of
 * the boot-path exemption (~30 bytes of `page.js`).
 */
interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const posted: string[] = []
const bridge: Bridge = { postMessage: (message) => void posted.push(message), onmessage: null }

beforeAll(async () => {
  ;(window as unknown as { __zenPageBridge: Bridge }).__zenPageBridge = bridge
  // The script is an IIFE over `window.__zenPageBridge`: it installs, and says hello, on import.
  await import('../pageScript')
})

describe('the page script’s hello (the frame-owner protocol’s document boundary)', () => {
  it('is said once at install, with the document’s navigation start and the session token', () => {
    const hellos = posted
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((m) => m.type === 'hello')
    expect(hellos).toHaveLength(1)
    const hello = hellos[0]!
    expect(hello.documentStart).toBeTypeOf('number')
    expect(Number.isFinite(hello.documentStart)).toBe(true)
    expect(hello.documentStart).toBe(performance.timeOrigin)
    // Kotlin's routePageMessage checks the token; `optDouble("documentStart")` reads the stamp.
    expect(hello.token).toBe('__ZEN_TOKEN__')
    // The shape, whole: nothing else rides on the hello (protocol `v: 1` stands, no version field).
    expect(Object.keys(hello).sort()).toEqual(['documentStart', 'token', 'type'])
  })
})

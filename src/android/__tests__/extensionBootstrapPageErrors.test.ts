// @vitest-environment happy-dom
import type { BootErrorStat, ExtensionBoot } from '@core/extensions/runtime/boot'
import { extensionUrl } from '@core/extensions/runtime/plan'
import { describe, expect, it } from 'vitest'

/*
 * The debug stats of an extension page (`__zenExtStats` in page mode: the worker's page, a
 * popup, an options page) keep the document's first uncaught errors as the content world's
 * stats do, with the stack: a console line gives an error thrown inside the document-start
 * script as `<document URL>:2` – the bootstrap's own line, the config on line 1 – which names
 * neither the code nor the caller, and the compat sweep reads the record for the column that
 * does (Save Page WE's worker, compat round 27).
 */

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const TOKEN = 'unit-test-token'
const EXT = 'd'.repeat(32)

const worker: ExtensionBoot = {
  id: EXT,
  name: 'Worker',
  version: '1.0',
  manifestVersion: 3,
  permissions: ['storage'],
  optionalPermissions: [],
  hostPermissions: [],
  manifest: {
    manifest_version: 3,
    name: 'Worker',
    version: '1.0',
    background: { service_worker: 'background.js' }
  },
  messages: null,
  groups: [],
  isolation: 'with'
}

describe('the page bootstrap keeps the document’s uncaught errors in its debug stats', () => {
  it('records message, source, line, column and stack of an error event, twelve at most', async () => {
    const posted: string[] = []
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: unknown
      __zenExtStats?: { page?: string; errors?: BootErrorStat[] }
      happyDOM?: { setURL(url: string): void }
    }
    g.happyDOM?.setURL(extensionUrl(EXT, 'background.js'))
    g.__zenExtBridge = {
      postMessage: (message) => {
        posted.push(message)
      },
      onmessage: null
    }
    g.__zenExtBoot = {
      config: {
        kind: 'page',
        token: TOKEN,
        uiLanguage: 'en',
        context: 'background',
        extension: worker
      },
      sources: {},
      css: {},
      debug: true
    }
    // The worker page redefines `self` and `globalThis` as a worker's global (`workerSelf`); in
    // happy-dom the page's window is this test's own global, so the test's runner gets its
    // `globalThis` back once the bootstrap has run – the capture listens on the real window.
    const realGlobal = globalThis
    await import('../extensionBootstrap')
    Object.defineProperty(window, 'globalThis', {
      value: realGlobal,
      configurable: true,
      writable: true
    })
    expect(posted.some((m) => (JSON.parse(m) as { t: string }).t === 'hello')).toBe(true)
    const stats = g.__zenExtStats
    expect(stats?.page).toBe('background')
    expect(stats?.errors).toEqual([])

    const thrown = new TypeError("Cannot read properties of undefined (reading '1')")
    const errorEvent = (lineno: number, colno: number): Event => {
      const event = new Event('error', { cancelable: true }) as Event & Record<string, unknown>
      Object.assign(event, {
        message: thrown.message,
        filename: location.href,
        lineno,
        colno,
        error: thrown
      })
      return event
    }
    window.dispatchEvent(errorEvent(2, 4711))
    expect(stats?.errors).toHaveLength(1)
    const record = stats?.errors?.[0]
    expect(record).toMatchObject({
      message: thrown.message,
      source: location.href,
      line: 2,
      column: 4711,
      frame: null,
      inline: null
    })
    expect(record?.stack).toContain("reading '1'")
    expect(typeof record?.at).toBe('number')

    // The capture is bounded: twelve records, the rest dropped.
    for (let i = 0; i < 20; i += 1) window.dispatchEvent(errorEvent(2, 100 + i))
    expect(stats?.errors).toHaveLength(12)
    expect(stats?.errors?.[11]?.column).toBe(110)
  })
})

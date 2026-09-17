import { describe, expect, it } from 'vitest'
import { installExtensionApi, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

/**
 * Lives in its own file: a non-configurable global cannot be undone, so this scenario must not
 * share a module context with the other shim tests.
 */
describe('installExtensionApi with a non-configurable browser global', () => {
  it('patches both objects with the same implementations', () => {
    const g = globalThis as Any
    const runtime = {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getManifest: () => ({ manifest_version: 3, name: 'P', version: '1' }),
      getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      sendMessage: () => undefined,
      onMessage: { addListener: () => undefined }
    }
    const chrome: Any = { runtime, storage: {} }
    const browser: Any = { runtime, storage: {} }
    Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
    Object.defineProperty(g, 'browser', { value: browser, configurable: false, writable: false })
    const host: ShimHost = {
      kind: 'worker',
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      notify: () => undefined,
      onEvent: () => undefined
    }
    const diag = installExtensionApi(host, API_SPEC)
    expect(diag.installed).toBe(true)
    expect(diag.browserAliased).toBe(false)
    expect(diag.roots).toBe(2)
    expect(g.browser).not.toBe(g.chrome)
    expect(typeof g.browser.tabs.create).toBe('function')
    expect(typeof g.chrome.tabs.create).toBe('function')
    expect(g.browser.tabs.onUpdated).toBe(g.chrome.tabs.onUpdated)
    expect(g.browser.windows.WINDOW_ID_CURRENT).toBe(-2)
    expect(g.browser.storage.sync).toBe(g.chrome.storage.sync)
    expect(g.browser.extension.getURL('a')).toBe(g.chrome.extension.getURL('a'))
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ERROR_FLOW_IN_PROGRESS,
  ERROR_GET_AUTH_TOKEN,
  ERROR_INTERACTION_REQUIRED,
  ERROR_INVALID_DETAILS,
  ERROR_INVALID_URL,
  ERROR_PAGE_LOAD_FAILED,
  ERROR_TIMEOUT,
  ERROR_USER_CANCELLED,
  NON_INTERACTIVE_TIMEOUT_MAX,
  isRedirectBack,
  normalizeWebAuthFlowDetails,
  redirectUrl
} from '../api/identity'
import { installExtensionApi, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'
import {
  IdentityApi,
  type AuthWindowEvents,
  type AuthWindowHost
} from '../../../main/platform/extensionApi/identity'
import type { ApiContext, LoadedExtension } from '../../../main/platform/extensionApi/types'

const EXT = 'a'.repeat(32)
const REDIRECT = `https://${EXT}.chromiumapp.org/`

describe('identity redirect URLs', () => {
  it('builds the chromiumapp.org URL with an optional path', () => {
    expect(redirectUrl(EXT, undefined)).toBe(REDIRECT)
    expect(redirectUrl(EXT, 'cb')).toBe(`${REDIRECT}cb`)
    expect(redirectUrl(EXT, '/cb/x')).toBe(`${REDIRECT}cb/x`)
    expect(redirectUrl(EXT, { path: 'provider' })).toBe(`${REDIRECT}provider`)
    expect(() => redirectUrl(EXT, 3)).toThrow(ERROR_INVALID_DETAILS)
  })

  it('recognizes the way back by origin, not by path', () => {
    expect(isRedirectBack(EXT, `${REDIRECT}?code=1#state`)).toBe(true)
    expect(isRedirectBack(EXT, `${REDIRECT}other/path`)).toBe(true)
    expect(isRedirectBack(EXT, `http://${EXT}.chromiumapp.org/`)).toBe(false)
    expect(isRedirectBack(EXT, `https://${'b'.repeat(32)}.chromiumapp.org/`)).toBe(false)
    expect(isRedirectBack(EXT, 'not a url')).toBe(false)
  })
})

describe('launchWebAuthFlow details', () => {
  it('reads the details with Chrome defaults', () => {
    expect(normalizeWebAuthFlowDetails({ url: 'https://auth.test/x' })).toEqual({
      url: 'https://auth.test/x',
      interactive: false,
      abortOnLoadForNonInteractive: true,
      timeoutMsForNonInteractive: 60_000
    })
    expect(
      normalizeWebAuthFlowDetails({
        url: 'https://auth.test/',
        interactive: true,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: 5_000
      })
    ).toEqual({
      url: 'https://auth.test/',
      interactive: true,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 5_000
    })
  })

  it('caps the timeout and rejects bad input', () => {
    expect(
      normalizeWebAuthFlowDetails({ url: 'https://a.test/', timeoutMsForNonInteractive: 999_999 })
        .timeoutMsForNonInteractive
    ).toBe(NON_INTERACTIVE_TIMEOUT_MAX)
    expect(() => normalizeWebAuthFlowDetails({})).toThrow(ERROR_INVALID_DETAILS)
    expect(() => normalizeWebAuthFlowDetails({ url: 'nope' })).toThrow(ERROR_INVALID_URL)
    expect(() => normalizeWebAuthFlowDetails({ url: 'ftp://x/' })).toThrow(ERROR_INVALID_URL)
    expect(() => normalizeWebAuthFlowDetails({ url: 'https://a.test/', interactive: 1 })).toThrow(
      ERROR_INVALID_DETAILS
    )
    expect(() =>
      normalizeWebAuthFlowDetails({ url: 'https://a.test/', timeoutMsForNonInteractive: -1 })
    ).toThrow(ERROR_INVALID_DETAILS)
  })
})

interface FakeWindow {
  url: string
  events: AuthWindowEvents
  shown: number
  closed: boolean
}

function harness(): { api: IdentityApi; windows: FakeWindow[]; ctx: ApiContext } {
  const windows: FakeWindow[] = []
  const host: AuthWindowHost = {
    open(_ext, url, _owner, events) {
      const fake: FakeWindow = { url, events, shown: 0, closed: false }
      windows.push(fake)
      return {
        show: () => {
          fake.shown += 1
        },
        close: () => {
          if (fake.closed) return
          fake.closed = true
          // A real window fires `closed` when told to close, too.
          events.closed()
        }
      }
    }
  }
  const api = new IdentityApi(host)
  const extension = {
    id: EXT,
    manifest: { name: 'Ext' },
    sessions: [{}]
  } as unknown as LoadedExtension
  const ctx = { extensionId: EXT, extension, window: undefined } as unknown as ApiContext
  return { api, windows, ctx }
}

describe('identity.launchWebAuthFlow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the redirect URL, fragment included, and closes the window', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/authorize?client=1',
      interactive: true
    }) as Promise<string>
    expect(h.windows).toHaveLength(1)
    expect(h.windows[0].url).toBe('https://auth.test/authorize?client=1')
    expect(h.api.running(EXT)).toBe(true)
    h.windows[0].events.navigating('https://auth.test/login')
    h.windows[0].events.loaded()
    expect(h.windows[0].shown).toBe(1)
    h.windows[0].events.navigating(`${REDIRECT}#access_token=abc&state=s`)
    await expect(pending).resolves.toBe(`${REDIRECT}#access_token=abc&state=s`)
    expect(h.windows[0].closed).toBe(true)
    expect(h.api.running(EXT)).toBe(false)
  })

  it('the user closing the window cancels the flow', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/',
      interactive: true
    }) as Promise<string>
    h.windows[0].closed = true
    h.windows[0].events.closed()
    await expect(pending).rejects.toThrow(ERROR_USER_CANCELLED)
  })

  it('a failed page load fails the flow', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/',
      interactive: true
    }) as Promise<string>
    h.windows[0].events.failed()
    await expect(pending).rejects.toThrow(ERROR_PAGE_LOAD_FAILED)
  })

  it('a silent flow never shows the window and fails once a page needs the user', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/'
    }) as Promise<string>
    h.windows[0].events.loaded()
    expect(h.windows[0].shown).toBe(0)
    await expect(pending).rejects.toThrow(ERROR_INTERACTION_REQUIRED)
    expect(h.windows[0].closed).toBe(true)
  })

  it('a silent flow that may load pages waits for the redirect or the timeout', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/',
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 10_000
    }) as Promise<string>
    h.windows[0].events.loaded()
    expect(h.api.running(EXT)).toBe(true)
    h.windows[0].events.navigating(`${REDIRECT}?code=silent`)
    await expect(pending).resolves.toBe(`${REDIRECT}?code=silent`)

    const late = expect(
      h.api.handlers.launchWebAuthFlow(h.ctx, {
        url: 'https://auth.test/',
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: 10_000
      }) as Promise<string>
    ).rejects.toThrow(ERROR_TIMEOUT)
    await vi.advanceTimersByTimeAsync(10_000)
    await late
    expect(h.windows[1].closed).toBe(true)
  })

  it('one flow at a time per extension; unloading ends it', async () => {
    const h = harness()
    const pending = h.api.handlers.launchWebAuthFlow(h.ctx, {
      url: 'https://auth.test/',
      interactive: true
    }) as Promise<string>
    expect(() =>
      h.api.handlers.launchWebAuthFlow(h.ctx, { url: 'https://auth.test/', interactive: true })
    ).toThrow(ERROR_FLOW_IN_PROGRESS)
    h.api.unload(EXT)
    await expect(pending).rejects.toThrow(ERROR_USER_CANCELLED)
    expect(h.windows[0].closed).toBe(true)
  })

  it('answers the rest of the namespace without an account', () => {
    const h = harness()
    expect(h.api.handlers.getRedirectURL(h.ctx, 'x')).toBe(`${REDIRECT}x`)
    expect(h.api.handlers.getProfileUserInfo(h.ctx)).toEqual({ email: '', id: '' })
    expect(h.api.handlers.getAccounts(h.ctx)).toEqual([])
    expect(() => h.api.handlers.getAuthToken(h.ctx, {})).toThrow(ERROR_GET_AUTH_TOKEN)
  })
})

describe('the shim answers getRedirectURL synchronously', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
  type Any = any
  const g = globalThis as Any
  const calls: Array<{ namespace: string; method: string }> = []

  beforeEach(() => {
    calls.length = 0
    const manifest = {
      manifest_version: 3,
      name: 'Probe',
      version: '1.0',
      permissions: ['identity']
    }
    const chrome: Any = {
      runtime: {
        id: EXT,
        getManifest: () => manifest,
        getURL: (path: string) => `chrome-extension://${EXT}/${path}`
      }
    }
    Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
    const host: ShimHost = {
      kind: 'worker',
      invoke(namespace, method) {
        calls.push({ namespace, method })
        return Promise.resolve({ ok: true, value: undefined })
      },
      notify: () => undefined,
      onEvent: () => undefined
    }
    installExtensionApi(host, API_SPEC)
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
  })

  it('returns the string itself, with an optional path, without a host round trip', () => {
    expect(g.chrome.identity.getRedirectURL()).toBe(REDIRECT)
    expect(g.chrome.identity.getRedirectURL('cb')).toBe(`${REDIRECT}cb`)
    expect(g.chrome.identity.getRedirectURL('/deep/path')).toBe(`${REDIRECT}deep/path`)
    expect(() => g.chrome.identity.getRedirectURL(42)).toThrow(TypeError)
    expect(calls).toEqual([])
    // The async members still go to the host.
    void g.chrome.identity.getProfileUserInfo()
    expect(calls).toEqual([{ namespace: 'identity', method: 'getProfileUserInfo' }])
  })
})

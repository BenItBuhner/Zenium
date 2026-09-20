import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'
import { CONTENT_SETTING_TYPE_NAMES } from '../api/contentSettings'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    kind: 'worker',
    calls: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify: vi.fn(),
    onEvent: vi.fn()
  }
  return host
}

function install(permissions: string[] = ['contentSettings']): { chrome: Any; host: FakeHost } {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const chrome: Any = {
    runtime: {
      id: ID,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent()
    },
    storage: { local: {}, session: {}, onChanged: nativeEvent() }
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host }
}

describe('chrome.contentSettings in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('is one ContentSetting per type for extensions holding the permission, with Chrome\u2019s enums', () => {
    const { chrome } = install()
    expect(Object.keys(chrome.contentSettings).sort()).toEqual(
      [
        ...CONTENT_SETTING_TYPE_NAMES,
        'Scope',
        'AutoVerifyContentSetting',
        'ClipboardContentSetting',
        'CookiesContentSetting',
        'ImagesContentSetting',
        'JavascriptContentSetting',
        'LocationContentSetting',
        'PluginsContentSetting',
        'PopupsContentSetting',
        'NotificationsContentSetting',
        'FullscreenContentSetting',
        'MouselockContentSetting',
        'MicrophoneContentSetting',
        'CameraContentSetting',
        'PpapiBrokerContentSetting',
        'MultipleAutomaticDownloadsContentSetting'
      ].sort()
    )
    for (const type of CONTENT_SETTING_TYPE_NAMES) {
      const setting = chrome.contentSettings[type]
      expect(typeof setting.get, type).toBe('function')
      expect(typeof setting.set, type).toBe('function')
      expect(typeof setting.clear, type).toBe('function')
      expect(typeof setting.getResourceIdentifiers, type).toBe('function')
      expect(setting.onChange, type).toBeUndefined()
    }
    expect(chrome.contentSettings.Scope.INCOGNITO_SESSION_ONLY).toBe('incognito_session_only')
    expect(chrome.contentSettings.CookiesContentSetting.SESSION_ONLY).toBe('session_only')
    expect(chrome.contentSettings.NotificationsContentSetting).toEqual({
      ALLOW: 'allow',
      BLOCK: 'block',
      ASK: 'ask'
    })
    expect(g.browser.contentSettings.cookies).toBe(chrome.contentSettings.cookies)
    delete g.chrome
    delete g.browser
    expect(install(['storage']).chrome.contentSettings).toBeUndefined()
  })

  it('routes get / set / clear / getResourceIdentifiers to the host with the type named first, the way Avast calls them', async () => {
    const { chrome, host } = install()
    host.respond = (_ns, method) =>
      method === 'get' ? { ok: true, value: { setting: 'ask' } } : { ok: true, value: undefined }
    await expect(
      chrome.contentSettings.notifications.get({ primaryUrl: 'https://news.example/' })
    ).resolves.toEqual({ setting: 'ask' })
    const done = vi.fn()
    chrome.contentSettings.notifications.set(
      { primaryPattern: 'https://news.example/*', setting: 'block' },
      done
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toHaveBeenCalledTimes(1)
    await expect(chrome.contentSettings.cookies.clear({ scope: 'regular' })).resolves.toBe(
      undefined
    )
    await expect(chrome.contentSettings.plugins.getResourceIdentifiers()).resolves.toBe(undefined)
    expect(host.calls).toEqual([
      {
        namespace: 'contentSettings',
        method: 'get',
        args: ['notifications', { primaryUrl: 'https://news.example/' }]
      },
      {
        namespace: 'contentSettings',
        method: 'set',
        args: ['notifications', { primaryPattern: 'https://news.example/*', setting: 'block' }]
      },
      { namespace: 'contentSettings', method: 'clear', args: ['cookies', { scope: 'regular' }] },
      { namespace: 'contentSettings', method: 'getResourceIdentifiers', args: ['plugins'] }
    ])
  })

  it('reports the host\u2019s refusal through the promise and runtime.lastError', async () => {
    const { chrome, host } = install()
    host.respond = () => ({ ok: false, error: 'Specific paths are not allowed.' })
    await expect(
      chrome.contentSettings.javascript.set({
        primaryPattern: 'https://a.example/p/*',
        setting: 'block'
      })
    ).rejects.toThrow('Specific paths are not allowed.')
    let seen: string | undefined
    chrome.contentSettings.javascript.set(
      { primaryPattern: 'https://a.example/p/*', setting: 'block' },
      () => {
        seen = chrome.runtime.lastError?.message
      }
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toBe('Specific paths are not allowed.')
  })
})

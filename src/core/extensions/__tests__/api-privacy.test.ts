import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ERROR_INCOGNITO_ACCESS,
  ERROR_INVALID_DETAILS,
  ERROR_INVALID_SETTING,
  PRIVACY_SETTINGS,
  normalizeGetDetails,
  parseSetting,
  settingDetails,
  settingNotControllable
} from '../api/privacy'
import { API_SPEC } from '../api/spec'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { PrivacyApi } from '../../../main/platform/extensionApi/privacy'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const SOURCES = { searchSuggestions: true, offerToSavePasswords: false }

describe('chrome.privacy, the pure part', () => {
  it('knows every setting Chrome groups under network, services and websites', () => {
    expect(parseSetting('network.webRTCIPHandlingPolicy')).toEqual({
      section: 'network',
      name: 'webRTCIPHandlingPolicy'
    })
    for (const [section, names] of Object.entries(PRIVACY_SETTINGS)) {
      for (const name of names) expect(parseSetting(`${section}.${name}`).name).toBe(name)
    }
    expect(() => parseSetting('network.nope')).toThrow(ERROR_INVALID_SETTING)
    expect(() => parseSetting('elsewhere.searchSuggestEnabled')).toThrow(ERROR_INVALID_SETTING)
    expect(() => parseSetting('searchSuggestEnabled')).toThrow(ERROR_INVALID_SETTING)
    expect(() => parseSetting(42)).toThrow(ERROR_INVALID_SETTING)
  })

  it('checks the shape of get details and reads the incognito flag', () => {
    expect(normalizeGetDetails(undefined)).toEqual({ incognito: false })
    expect(normalizeGetDetails({})).toEqual({ incognito: false })
    expect(normalizeGetDetails({ incognito: true })).toEqual({ incognito: true })
    expect(() => normalizeGetDetails('x')).toThrow(ERROR_INVALID_DETAILS)
    expect(() => normalizeGetDetails({ incognito: 'yes' })).toThrow(ERROR_INVALID_DETAILS)
  })

  it("reads Zenium's switches, Chromium's defaults and off for what has no counterpart", () => {
    expect(settingDetails('searchSuggestEnabled', SOURCES)).toEqual({
      value: true,
      levelOfControl: 'not_controllable'
    })
    expect(settingDetails('passwordSavingEnabled', SOURCES).value).toBe(false)
    expect(settingDetails('webRTCIPHandlingPolicy', SOURCES).value).toBe('default')
    expect(settingDetails('thirdPartyCookiesAllowed', SOURCES).value).toBe(true)
    expect(settingDetails('referrersEnabled', SOURCES).value).toBe(true)
    expect(settingDetails('safeBrowsingEnabled', SOURCES).value).toBe(false)
    expect(settingDetails('topicsEnabled', SOURCES).value).toBe(false)
    expect(settingDetails('doNotTrackEnabled', SOURCES).value).toBe(false)
  })
})

function harness(grants: Record<string, string[]>): {
  api: PrivacyApi
  ctx: (id: string) => ApiContext
  settings: { searchSuggestions: boolean; passwords: { offerToSave: boolean } }
} {
  const settings = { searchSuggestions: false, passwords: { offerToSave: true } }
  const loaded = new Map<string, LoadedExtension>()
  for (const id of Object.keys(grants)) {
    loaded.set(id, { id, sessions: [] } as unknown as LoadedExtension)
  }
  const host = {
    browser: { state: { settings } },
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] })
  }
  const api = new PrivacyApi(host as unknown as ApiHost)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  return { api, ctx, settings }
}

describe('PrivacyApi', () => {
  it('requires the privacy permission', () => {
    const h = harness({ ext: ['tabs'] })
    expect(() => h.api.handlers.get(h.ctx('ext'), 'services.searchSuggestEnabled', {})).toThrow(
      /'privacy' permission/
    )
  })

  it("answers get with the browser's current values, live", () => {
    const h = harness({ ext: ['privacy'] })
    const ctx = h.ctx('ext')
    expect(h.api.handlers.get(ctx, 'services.searchSuggestEnabled', {})).toEqual({
      value: false,
      levelOfControl: 'not_controllable'
    })
    h.settings.searchSuggestions = true
    expect(h.api.handlers.get(ctx, 'services.searchSuggestEnabled', undefined)).toMatchObject({
      value: true
    })
    expect(h.api.handlers.get(ctx, 'services.passwordSavingEnabled', { incognito: false })).toEqual(
      { value: true, levelOfControl: 'not_controllable' }
    )
    // No extension has incognito access: Chrome's message for the incognito value.
    expect(() =>
      h.api.handlers.get(ctx, 'services.passwordSavingEnabled', { incognito: true })
    ).toThrow(ERROR_INCOGNITO_ACCESS)
    expect(() => h.api.handlers.get(ctx, 'network.nope', {})).toThrow(ERROR_INVALID_SETTING)
    expect(() => h.api.handlers.get(ctx, 'network.networkPredictionEnabled', 'x')).toThrow(
      ERROR_INVALID_DETAILS
    )
  })

  it('refuses set and clear, naming the setting', () => {
    const h = harness({ ext: ['privacy'] })
    const ctx = h.ctx('ext')
    expect(() => h.api.handlers.set(ctx, 'websites.doNotTrackEnabled', { value: true })).toThrow(
      settingNotControllable('privacy.websites.doNotTrackEnabled')
    )
    expect(() => h.api.handlers.clear(ctx, 'websites.doNotTrackEnabled', {})).toThrow(
      settingNotControllable('privacy.websites.doNotTrackEnabled')
    )
    expect(() =>
      h.api.handlers.set(ctx, 'network.webRTCIPHandlingPolicy', {
        value: 'disable_non_proxied_udp',
        scope: 'incognito_persistent'
      })
    ).toThrow(ERROR_INCOGNITO_ACCESS)
    expect(() =>
      h.api.handlers.clear(ctx, 'websites.doNotTrackEnabled', { scope: 'incognito_session_only' })
    ).toThrow(ERROR_INCOGNITO_ACCESS)
    expect(() => h.api.handlers.set(ctx, 'bogus', { value: true })).toThrow(ERROR_INVALID_SETTING)
  })
})

describe('the shim builds ChromeSetting objects', () => {
  const g = globalThis as Any
  const calls: Array<{ namespace: string; method: string; args: unknown[] }> = []
  let respond: (method: string) => InvokeResult = () => ({ ok: true, value: undefined })

  beforeEach(() => {
    calls.length = 0
    const manifest = { manifest_version: 3, name: 'Probe', version: '1.0' }
    const chrome: Any = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getManifest: () => manifest,
        getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`
      }
    }
    Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
    const host: ShimHost = {
      kind: 'worker',
      invoke(namespace, method, args) {
        calls.push({ namespace, method, args })
        return Promise.resolve(respond(method))
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

  it('routes get / set / clear with the dotted setting name first, nothing on the namespace itself', async () => {
    respond = (method) =>
      method === 'get'
        ? { ok: true, value: { value: 'default', levelOfControl: 'not_controllable' } }
        : { ok: false, error: settingNotControllable('privacy.network.webRTCIPHandlingPolicy') }
    const setting = g.chrome.privacy.network.webRTCIPHandlingPolicy
    await expect(setting.get({})).resolves.toEqual({
      value: 'default',
      levelOfControl: 'not_controllable'
    })
    await expect(setting.set({ value: 'disable_non_proxied_udp' })).rejects.toThrow(
      /does not let extensions change/
    )
    expect(calls).toEqual([
      { namespace: 'privacy', method: 'get', args: ['network.webRTCIPHandlingPolicy', {}] },
      {
        namespace: 'privacy',
        method: 'set',
        args: ['network.webRTCIPHandlingPolicy', { value: 'disable_non_proxied_udp' }]
      }
    ])
    expect(g.chrome.privacy.get).toBeUndefined()
    expect(g.chrome.privacy.set).toBeUndefined()
    expect(g.chrome.privacy.IPHandlingPolicy.DISABLE_NON_PROXIED_UDP).toBe(
      'disable_non_proxied_udp'
    )
    expect(typeof g.chrome.privacy.services.passwordSavingEnabled.onChange.addListener).toBe(
      'function'
    )
    expect(typeof g.chrome.privacy.websites.doNotTrackEnabled.clear).toBe('function')
    expect(g.browser.privacy.network.webRTCIPHandlingPolicy).toBe(setting)
  })

  it('reports a get failure through runtime.lastError with a callback', async () => {
    respond = () => ({ ok: false, error: ERROR_INVALID_SETTING })
    let seen: unknown = 'unset'
    g.chrome.privacy.services.searchSuggestEnabled.get({}, () => {
      seen = g.chrome.runtime.lastError?.message
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toBe(ERROR_INVALID_SETTING)
    expect(g.chrome.runtime.lastError).toBeUndefined()
  })
})

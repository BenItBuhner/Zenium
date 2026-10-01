import {
  EMBEDDED_PATTERN_ERROR,
  INVALID_URL_ERROR,
  NO_INCOGNITO_WINDOW_ERROR,
  SPECIFIC_PATH_ERROR,
  UNSUPPORTED_SETTING_ERROR,
  type ContentSettingRule
} from '@core/extensions/api/contentSettings'
import { INCOGNITO_ERROR, INCOGNITO_SCOPE_ERROR } from '@core/extensions/api/privacy'
import type { PermissionOverride, PermissionRequestDetails } from '@core/permissions'
import type { ContentDefault } from '@shared/contentSettings'
import { describe, expect, it } from 'vitest'
import type { AttachedExtension } from '../extensionApi'
import {
  AndroidContentSettings,
  CONTENT_SETTINGS_PERMISSION_ERROR,
  type ContentSettingsHost
} from '../extensionContentSettings'

/*
 * `chrome.contentSettings` on the phone against a fake host: the rules kept per extension,
 * type and scope, Chrome's precedence (the more specific pattern within an extension, the
 * newer install between them), what `get` answers with and without a rule, the override the
 * permission store consults (the private tab's question answered from the incognito rules of
 * the extensions allowed there), the private-tab gates, the store across a detach and an
 * uninstall, the boot-time rebuild and the permission gate.
 */

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

function ext(
  id: string,
  installedAt: number,
  permissions: string[] = ['contentSettings'],
  allowPrivate = false
): AttachedExtension {
  return {
    record: { id, installedAt, name: `Ext ${id[0].toUpperCase()}`, allowPrivate },
    manifest: { name: `Ext ${id[0].toUpperCase()}`, permissions },
    messages: null
  } as unknown as AttachedExtension
}

class FakeHost implements ContentSettingsHost {
  readonly attachedById = new Map<string, AttachedExtension>()
  readonly persisted = new Map<string, Record<string, ContentSettingRule[]>>()
  readonly warnings: string[] = []
  /** What the store would decide by itself (the user's answers and the defaults), by permission. */
  readonly browserDecisions = new Map<string, ContentDefault>()
  /** Every `overridesChanged` the layer announced. */
  readonly announced: string[][] = []
  /** The resolve questions the layer asked the store for `get`'s fallback. */
  readonly asked: Array<{ permission: string; url: string; details?: PermissionRequestDetails }> =
    []
  override: PermissionOverride | null = null
  privateOpen = false
  readonly permissions = {
    setOverride: (provider: PermissionOverride | null): void => {
      this.override = provider
    },
    overridesChanged: (permissions: readonly string[]): void => {
      this.announced.push([...permissions])
    },
    resolve: (
      permission: string,
      url: string,
      details?: PermissionRequestDetails
    ): ContentDefault => {
      this.asked.push({ permission, url, details })
      return this.browserDecisions.get(permission) ?? 'allow'
    }
  }

  attached(id: string): AttachedExtension | undefined {
    return this.attachedById.get(id)
  }
  holdsPermission(ext: AttachedExtension): boolean {
    return (ext.manifest as unknown as { permissions: string[] }).permissions.includes(
      'contentSettings'
    )
  }
  allowedInPrivate(id: string): boolean {
    return this.attachedById.get(id)?.record.allowPrivate === true
  }
  privateTabOpen(): boolean {
    return this.privateOpen
  }
  persistedRules(id: string): unknown {
    return this.persisted.get(id) ?? {}
  }
  persistRules(id: string, rules: Record<string, ContentSettingRule[]>): void {
    if (Object.keys(rules).length === 0) this.persisted.delete(id)
    else this.persisted.set(id, rules)
  }
  warn(message: string): void {
    this.warnings.push(message)
  }

  /** The store's question as `PermissionService.resolve` puts it to the override. */
  decide(
    permission: string,
    url: string,
    details?: PermissionRequestDetails
  ): ContentDefault | null {
    if (!this.override) throw new Error('no override installed')
    return this.override(permission, url, details)
  }
}

function setUp(...exts: AttachedExtension[]): { host: FakeHost; api: AndroidContentSettings } {
  const host = new FakeHost()
  const api = new AndroidContentSettings(host)
  for (const e of exts) {
    host.attachedById.set(e.record.id, e)
    api.load(e)
  }
  return { host, api }
}

const NEWS = 'https://news.example/story'
const OTHER = 'https://other.example/'

describe('AndroidContentSettings: get without rules', () => {
  it("answers with what the browser decides for the site, in Chrome's words, and installs the override at construction", () => {
    const { host, api } = setUp(ext(A, 1))
    expect(host.override).not.toBeNull()
    expect(api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: NEWS }])).toEqual({
      setting: 'allow'
    })
    host.browserDecisions.set('javascript', 'deny')
    expect(api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: NEWS }])).toEqual({
      setting: 'block'
    })
    host.browserDecisions.set('geolocation', 'ask')
    expect(api.call(ext(A, 1), 'get', ['location', { primaryUrl: NEWS }])).toEqual({
      setting: 'ask'
    })
    // The embedding page goes to the store as the request's embedder.
    api.call(ext(A, 1), 'get', ['cookies', { primaryUrl: NEWS, secondaryUrl: OTHER }])
    expect(host.asked[host.asked.length - 1]).toEqual({
      permission: 'on-device-site-data',
      url: NEWS,
      details: { embedderUrl: OTHER }
    })
    // Without a rule the override says nothing: the store goes on to the user's answers.
    expect(host.decide('javascript', NEWS)).toBeNull()
  })

  it('the retired types have one answer, set does nothing to them, and autoVerify answers its fallback', () => {
    const { host, api } = setUp(ext(A, 1))
    for (const [type, value] of [
      ['plugins', 'block'],
      ['unsandboxedPlugins', 'block'],
      ['fullscreen', 'allow'],
      ['mouselock', 'allow']
    ]) {
      expect(api.call(ext(A, 1), 'get', [type, { primaryUrl: NEWS }])).toEqual({ setting: value })
    }
    api.call(ext(A, 1), 'set', ['plugins', { primaryPattern: '<all_urls>', setting: 'allow' }])
    expect(api.rulesOf(A, 'plugins')).toEqual([])
    expect(host.announced).toEqual([])
    expect(api.call(ext(A, 1), 'get', ['autoVerify', { primaryUrl: NEWS }])).toEqual({
      setting: 'allow'
    })
    expect(api.call(ext(A, 1), 'getResourceIdentifiers', ['plugins'])).toBeUndefined()
  })

  it('refuses what Chrome refuses: the permission, an unknown type, a bad URL, a path, an embedded pattern, a foreign value', () => {
    const { api } = setUp(ext(A, 1), ext(B, 2, ['storage']))
    expect(() =>
      api.call(ext(B, 2, ['storage']), 'get', ['javascript', { primaryUrl: NEWS }])
    ).toThrow(CONTENT_SETTINGS_PERMISSION_ERROR)
    expect(() => api.call(ext(A, 1), 'get', ['flash', { primaryUrl: NEWS }])).toThrow(
      'Unknown content setting flash.'
    )
    expect(() => api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: 'news' }])).toThrow(
      INVALID_URL_ERROR('news')
    )
    expect(() =>
      api.call(ext(A, 1), 'set', [
        'javascript',
        { primaryPattern: 'https://news.example/story', setting: 'block' }
      ])
    ).toThrow(SPECIFIC_PATH_ERROR)
    expect(() =>
      api.call(ext(A, 1), 'set', [
        'javascript',
        {
          primaryPattern: '<all_urls>',
          secondaryPattern: 'https://news.example/*',
          setting: 'block'
        }
      ])
    ).toThrow(EMBEDDED_PATTERN_ERROR)
    expect(() =>
      api.call(ext(A, 1), 'set', ['javascript', { primaryPattern: '<all_urls>', setting: 'ask' }])
    ).toThrow(UNSUPPORTED_SETTING_ERROR('ask'))
    expect(() => api.call(ext(A, 1), 'open', ['javascript', {}])).toThrow(
      'chrome.contentSettings.javascript.open is not implemented on Zenium for Android'
    )
  })
})

describe('AndroidContentSettings: rules', () => {
  it("a rule answers get, decides the store's question ahead of the user's answers and is announced by its permission", () => {
    const { host, api } = setUp(ext(A, 1))
    host.browserDecisions.set('javascript', 'allow')
    api.call(ext(A, 1), 'set', [
      'javascript',
      { primaryPattern: 'https://news.example/*', setting: 'block' }
    ])
    expect(host.announced).toEqual([['javascript']])
    expect(api.rulesOf(A, 'javascript')).toEqual([
      {
        primaryPattern: 'https://news.example/*',
        secondaryPattern: '<all_urls>',
        setting: 'block',
        scope: 'regular'
      }
    ])
    expect(api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: NEWS }])).toEqual({
      setting: 'block'
    })
    expect(api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: OTHER }])).toEqual({
      setting: 'allow'
    })
    // The override: the store's word for the site is the rule's, the other site's is nobody's.
    expect(host.decide('javascript', NEWS)).toBe('deny')
    expect(host.decide('javascript', 'https://news.example/other?x=1')).toBe('deny')
    expect(host.decide('javascript', OTHER)).toBeNull()
    expect(host.decide('images', NEWS)).toBeNull()
    // A frame's question carries its embedder as the secondary URL; a wildcard secondary takes any.
    expect(host.decide('javascript', NEWS, { embedderUrl: OTHER })).toBe('deny')
    // A fixed type's permission is never the override's business.
    expect(host.decide('fullscreen', NEWS)).toBeNull()
  })

  it('a rule set again for the same patterns replaces the earlier one; clear drops a scope and says so once', () => {
    const { host, api } = setUp(ext(A, 1))
    api.call(ext(A, 1), 'set', ['images', { primaryPattern: '<all_urls>', setting: 'block' }])
    api.call(ext(A, 1), 'set', ['images', { primaryPattern: '<all_urls>', setting: 'allow' }])
    expect(api.rulesOf(A, 'images')).toHaveLength(1)
    expect(api.rulesOf(A, 'images')[0].setting).toBe('allow')
    expect(host.decide('images', NEWS)).toBe('allow')
    api.call(ext(A, 1), 'clear', ['images', {}])
    expect(api.rulesOf(A, 'images')).toEqual([])
    expect(host.decide('images', NEWS)).toBeNull()
    expect(host.announced).toEqual([['images'], ['images'], ['images']])
    // Nothing to clear: nothing announced.
    api.call(ext(A, 1), 'clear', ['images', {}])
    expect(host.announced).toHaveLength(3)
  })

  it('the more specific pattern wins within an extension; the newer install wins between them', () => {
    const { host, api } = setUp(ext(A, 1), ext(B, 2))
    api.call(ext(A, 1), 'set', ['javascript', { primaryPattern: '<all_urls>', setting: 'block' }])
    api.call(ext(A, 1), 'set', [
      'javascript',
      { primaryPattern: 'https://news.example/*', setting: 'allow' }
    ])
    expect(host.decide('javascript', NEWS)).toBe('allow')
    expect(host.decide('javascript', OTHER)).toBe('deny')
    // B installed later: its rule for the news site stands over A's.
    api.call(ext(B, 2), 'set', [
      'javascript',
      { primaryPattern: '*://news.example/*', setting: 'block' }
    ])
    expect(host.decide('javascript', NEWS)).toBe('deny')
    expect(api.call(ext(A, 1), 'get', ['javascript', { primaryUrl: NEWS }])).toEqual({
      setting: 'block'
    })
    // B disabled: A's answer again.
    api.unload(B)
    expect(host.decide('javascript', NEWS)).toBe('allow')
    expect(host.announced[host.announced.length - 1]).toEqual(['javascript'])
  })

  it('a cookies rule may name the embedding site; the override reads the frame\u2019s embedder', () => {
    const { host, api } = setUp(ext(A, 1))
    api.call(ext(A, 1), 'set', [
      'cookies',
      {
        primaryPattern: 'https://tracker.example/*',
        secondaryPattern: 'https://news.example/*',
        setting: 'block'
      }
    ])
    expect(host.announced).toEqual([['on-device-site-data']])
    expect(
      api.call(ext(A, 1), 'get', [
        'cookies',
        { primaryUrl: 'https://tracker.example/pixel', secondaryUrl: NEWS }
      ])
    ).toEqual({ setting: 'block' })
    expect(
      api.call(ext(A, 1), 'get', [
        'cookies',
        { primaryUrl: 'https://tracker.example/pixel', secondaryUrl: OTHER }
      ])
    ).toEqual({ setting: 'allow' })
    expect(
      host.decide('on-device-site-data', 'https://tracker.example/pixel', { embedderUrl: NEWS })
    ).toBe('deny')
    expect(
      host.decide('on-device-site-data', 'https://tracker.example/pixel', { embedderUrl: OTHER })
    ).toBeNull()
    // `session_only` lets the site store: the store's `allow`.
    api.call(ext(A, 1), 'set', [
      'cookies',
      { primaryPattern: '<all_urls>', setting: 'session_only' }
    ])
    expect(host.decide('on-device-site-data', OTHER)).toBe('allow')
  })
})

describe('AndroidContentSettings: private tabs', () => {
  it('incognito rules and reads need the extension allowed there and a private tab open; a private tab\u2019s question reads them first', () => {
    const { host, api } = setUp(ext(A, 1), ext(B, 2, ['contentSettings'], true))
    const notAllowed = ext(A, 1)
    const allowed = ext(B, 2, ['contentSettings'], true)
    expect(() =>
      api.call(notAllowed, 'get', ['javascript', { primaryUrl: NEWS, incognito: true }])
    ).toThrow(INCOGNITO_ERROR)
    expect(() =>
      api.call(notAllowed, 'set', [
        'javascript',
        { primaryPattern: '<all_urls>', setting: 'block', scope: 'incognito_session_only' }
      ])
    ).toThrow(INCOGNITO_ERROR)
    expect(() =>
      api.call(notAllowed, 'clear', ['javascript', { scope: 'incognito_session_only' }])
    ).toThrow(INCOGNITO_ERROR)
    expect(() =>
      api.call(allowed, 'get', ['javascript', { primaryUrl: NEWS, incognito: true }])
    ).toThrow(NO_INCOGNITO_WINDOW_ERROR)
    expect(() =>
      api.call(allowed, 'set', [
        'javascript',
        { primaryPattern: '<all_urls>', setting: 'block', scope: 'incognito_session_only' }
      ])
    ).toThrow(INCOGNITO_SCOPE_ERROR)

    host.privateOpen = true
    api.call(allowed, 'set', [
      'javascript',
      { primaryPattern: '<all_urls>', setting: 'block', scope: 'incognito_session_only' }
    ])
    api.call(notAllowed, 'set', ['javascript', { primaryPattern: '<all_urls>', setting: 'allow' }])
    // A regular tab: the incognito rule does not speak; A's regular rule does.
    expect(host.decide('javascript', NEWS)).toBe('allow')
    expect(api.call(allowed, 'get', ['javascript', { primaryUrl: NEWS }])).toEqual({
      setting: 'allow'
    })
    // A private tab (the core asks with its container): B's incognito rule first; A is not allowed there.
    expect(host.decide('javascript', NEWS, { privateContainerId: 'private' })).toBe('deny')
    expect(api.call(allowed, 'get', ['javascript', { primaryUrl: NEWS, incognito: true }])).toEqual(
      {
        setting: 'block'
      }
    )
    // The incognito rule is the session's: never persisted.
    expect(host.persisted.get(B)).toBeUndefined()
    // B loses its private access: the private tab reads nobody's rule.
    host.attachedById.set(B, ext(B, 2, ['contentSettings'], false))
    api.privateAccessChanged()
    expect(host.decide('javascript', NEWS, { privateContainerId: 'private' })).toBeNull()
  })
})

describe('AndroidContentSettings: persistence', () => {
  it('keeps regular rules across a detach and a restart, rebuilds from the store at boot, drops them with the extension', () => {
    const { host, api } = setUp(ext(A, 1))
    api.call(ext(A, 1), 'set', [
      'javascript',
      { primaryPattern: 'https://news.example/*', setting: 'block' }
    ])
    expect(host.persisted.get(A)).toEqual({
      javascript: [
        {
          primaryPattern: 'https://news.example/*',
          secondaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'regular'
        }
      ]
    })
    // Detached: the rule stops deciding, the store keeps it.
    api.unload(A)
    expect(host.decide('javascript', NEWS)).toBeNull()
    expect(host.persisted.get(A)).toBeDefined()
    // Attached again: it decides again, before any page of the extension runs.
    api.load(ext(A, 1))
    expect(host.decide('javascript', NEWS)).toBe('deny')

    // A new session: the boot-time rebuild from the store before the extension attaches.
    const again = new FakeHost()
    again.persisted.set(A, host.persisted.get(A) as Record<string, ContentSettingRule[]>)
    const booted = new AndroidContentSettings(again)
    booted.prime([{ id: A, installedAt: 1, allowPrivate: false }])
    expect(again.announced).toEqual([['javascript']])
    expect(again.decide('javascript', NEWS)).toBe('deny')
    // The attach re-reads with the manifest's word: the same rule, announced again.
    again.attachedById.set(A, ext(A, 1))
    booted.load(ext(A, 1))
    expect(again.decide('javascript', NEWS)).toBe('deny')
    expect(booted.rulesOf(A, 'javascript')).toHaveLength(1)

    // Uninstalled: the rules go with it.
    api.forget(A)
    expect(host.decide('javascript', NEWS)).toBeNull()
    expect(host.persisted.get(A)).toBeUndefined()
  })

  it('an extension without the permission loads nothing, even with stored rules; what is not a rule is dropped', () => {
    const host = new FakeHost()
    host.persisted.set(A, {
      javascript: [
        {
          primaryPattern: '<all_urls>',
          secondaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'regular'
        },
        { primaryPattern: 7, setting: 'block' } as unknown as ContentSettingRule
      ],
      flash: [
        {
          primaryPattern: '<all_urls>',
          secondaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'regular'
        }
      ]
    })
    const api = new AndroidContentSettings(host)
    const stored = ext(A, 1, ['storage'])
    host.attachedById.set(A, stored)
    api.load(stored)
    expect(host.decide('javascript', NEWS)).toBeNull()
    expect(host.announced).toEqual([])
    // With the permission: the one valid rule of the one known type.
    const holder = ext(A, 1)
    host.attachedById.set(A, holder)
    api.load(holder)
    expect(api.rulesOf(A, 'javascript')).toHaveLength(1)
    expect(api.rulesOf(A, 'flash')).toEqual([])
    expect(host.decide('javascript', NEWS)).toBe('deny')
  })
})

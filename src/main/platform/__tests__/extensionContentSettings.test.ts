import { describe, expect, it } from 'vitest'
import {
  EMBEDDED_PATTERN_ERROR,
  NO_INCOGNITO_WINDOW_ERROR,
  type ContentSettingRule
} from '../../../core/extensions/api/contentSettings'
import { INCOGNITO_ERROR } from '../../../core/extensions/api/privacy'
import { PermissionService, type PermissionChange } from '../../../core/permissions'
import type { PermissionPromptHost, StoreIO } from '../../../core/platform'
import { ContentSettingsApi } from '../extensionApi/contentSettings'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NO_PERMISSION = 'cccccccccccccccccccccccccccccccc'

const SITE = 'https://news.example/story'
const OTHER = 'https://shop.example/cart'

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => undefined,
    writeSync: () => undefined
  }
}

/** A prompt host that answers Block: a request reaching it means no rule decided it. */
function prompts(): PermissionPromptHost & { asked: number } {
  const host = {
    asked: 0,
    show: async () => {
      host.asked += 1
      return 'block' as const
    },
    cancel: () => undefined
  }
  return host
}

type Persisted = Map<string, Record<string, ContentSettingRule[]>>

interface World {
  api: ContentSettingsApi
  permissions: PermissionService
  prompts: PermissionPromptHost & { asked: number }
  changes: PermissionChange[]
  loaded: Set<string>
  privateAllowed: Set<string>
  privateWindows: number
  persisted: Persisted
  ctx(extensionId: string): ApiContext
}

function world(persisted: Persisted = new Map()): World {
  const asked = prompts()
  const permissions = new PermissionService(fakeIo(), asked)
  const changes: PermissionChange[] = []
  permissions.subscribe((change) => changes.push(change))
  const state: World = {
    api: undefined as unknown as ContentSettingsApi,
    permissions,
    prompts: asked,
    changes,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    privateAllowed: new Set(),
    privateWindows: 0,
    persisted,
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['contentSettings'],
      origins: []
    }),
    loaded: (extensionId: string) =>
      state.loaded.has(extensionId) ? { id: extensionId } : undefined,
    allLoaded: () => [...state.loaded].map((id) => ({ id })),
    partitionsOf: (extensionId: string) =>
      state.privateAllowed.has(extensionId) ? ['default', 'private'] : ['default'],
    store: {
      contentSettingRules: (extensionId: string) => persisted.get(extensionId) ?? {},
      setContentSettingRules: (
        extensionId: string,
        rules: Record<string, ContentSettingRule[]>
      ) => {
        if (Object.keys(rules).length === 0) persisted.delete(extensionId)
        else persisted.set(extensionId, rules)
      }
    },
    browser: {
      permissions,
      extensions: {
        list: () => [
          { id: OLD, installedAt: 1000 },
          { id: NEW, installedAt: 2000 },
          { id: NO_PERMISSION, installedAt: 3000 }
        ]
      },
      allWindows: () => Array.from({ length: state.privateWindows }, () => ({ isPrivate: true }))
    }
  } as unknown as ApiHost
  state.api = new ContentSettingsApi(host)
  for (const id of state.loaded) state.api.load(id)
  return state
}

const get = (w: World, id: string, type: string, details: unknown): { setting: string } =>
  w.api.handlers.get(w.ctx(id), type, details) as { setting: string }
const set = (w: World, id: string, type: string, details: unknown): unknown =>
  w.api.handlers.set(w.ctx(id), type, details)
const clear = (w: World, id: string, type: string, details: unknown = {}): unknown =>
  w.api.handlers.clear(w.ctx(id), type, details)
const setting = (w: World, id: string, type: string, url: string): string =>
  get(w, id, type, { primaryUrl: url }).setting

describe('ContentSettingsApi: get without rules', () => {
  it('answers with what the browser decides for the site, in Chrome\u2019s words', () => {
    const w = world()
    expect(setting(w, OLD, 'notifications', SITE)).toBe('ask')
    expect(setting(w, OLD, 'location', SITE)).toBe('ask')
    expect(setting(w, OLD, 'popups', SITE)).toBe('block')
    expect(setting(w, OLD, 'javascript', SITE)).toBe('allow')
    expect(setting(w, OLD, 'cookies', SITE)).toBe('allow')
    w.permissions.remember('notifications', SITE, 'deny')
    expect(setting(w, OLD, 'notifications', SITE)).toBe('block')
    w.permissions.remember('notifications', SITE, 'allow')
    expect(setting(w, OLD, 'notifications', SITE)).toBe('allow')
  })

  it('the retired types have one answer, and set does nothing to them', () => {
    const w = world()
    expect(setting(w, OLD, 'plugins', SITE)).toBe('block')
    expect(setting(w, OLD, 'fullscreen', SITE)).toBe('allow')
    expect(setting(w, OLD, 'mouselock', SITE)).toBe('allow')
    set(w, OLD, 'plugins', { primaryPattern: '<all_urls>', setting: 'allow' })
    expect(setting(w, OLD, 'plugins', SITE)).toBe('block')
    expect(w.api.rulesOf(OLD, 'plugins')).toEqual([])
    expect(w.api.handlers.getResourceIdentifiers(w.ctx(OLD), 'plugins')).toBeUndefined()
  })

  it('refuses what Chrome refuses', () => {
    const w = world()
    expect(() => get(w, OLD, 'notifications', {})).toThrow('The URL "undefined" is invalid.')
    expect(() => get(w, OLD, 'flash', { primaryUrl: SITE })).toThrow('Unknown content setting')
    expect(() =>
      set(w, OLD, 'notifications', { primaryPattern: 'https://a.example/x/*', setting: 'block' })
    ).toThrow('Specific paths are not allowed.')
    expect(() =>
      set(w, OLD, 'notifications', {
        primaryPattern: '<all_urls>',
        secondaryPattern: 'https://a.example/*',
        setting: 'block'
      })
    ).toThrow(EMBEDDED_PATTERN_ERROR)
    expect(() =>
      set(w, OLD, 'javascript', { primaryPattern: '<all_urls>', setting: 'ask' })
    ).toThrow("'ask' is not supported for this setting.")
  })
})

describe('ContentSettingsApi: rules', () => {
  it('a rule answers get and decides the site\u2019s requests ahead of the user\u2019s answers', async () => {
    const w = world()
    w.permissions.remember('notifications', SITE, 'allow')
    set(w, OLD, 'notifications', { primaryPattern: 'https://news.example/*', setting: 'block' })
    expect(setting(w, OLD, 'notifications', SITE)).toBe('block')
    expect(setting(w, OLD, 'notifications', OTHER)).toBe('ask')
    expect(w.permissions.resolve('notifications', SITE)).toBe('deny')
    expect(w.permissions.stored('notifications', SITE)).toBe('deny')
    expect(await w.permissions.decide('notifications', SITE)).toBe(false)
    expect(w.prompts.asked).toBe(0)
    expect(w.changes).toContainEqual({ permission: 'notifications', origin: null })
    // Location is asked about in Zenium; an extension's allow answers without a prompt.
    set(w, OLD, 'location', { primaryPattern: '<all_urls>', setting: 'allow' })
    expect(await w.permissions.decide('geolocation', OTHER)).toBe(true)
    expect(w.prompts.asked).toBe(0)
    // Pop-ups: a rule to allow them reaches the pop-up blocker's stored answer.
    set(w, OLD, 'popups', { primaryPattern: 'https://news.example/*', setting: 'allow' })
    expect(w.permissions.stored('popups', SITE)).toBe('allow')
    expect(w.permissions.stored('popups', OTHER)).toBeNull()
  })

  it('a rule set again for the same patterns replaces the earlier one; clear drops a scope', () => {
    const w = world()
    set(w, OLD, 'javascript', { primaryPattern: '<all_urls>', setting: 'block' })
    set(w, OLD, 'javascript', { primaryPattern: '<all_urls>', setting: 'allow' })
    expect(w.api.rulesOf(OLD, 'javascript')).toHaveLength(1)
    expect(setting(w, OLD, 'javascript', SITE)).toBe('allow')
    set(w, OLD, 'javascript', { primaryPattern: 'https://news.example/*', setting: 'block' })
    expect(setting(w, OLD, 'javascript', SITE)).toBe('block')
    expect(setting(w, OLD, 'javascript', OTHER)).toBe('allow')
    clear(w, OLD, 'javascript')
    expect(w.api.rulesOf(OLD, 'javascript')).toEqual([])
    expect(setting(w, OLD, 'javascript', SITE)).toBe('allow')
    expect(w.persisted.get(OLD)).toBeUndefined()
  })

  it('the more specific pattern wins within an extension; the newer install wins between them', () => {
    const w = world()
    set(w, OLD, 'images', { primaryPattern: '<all_urls>', setting: 'block' })
    set(w, OLD, 'images', { primaryPattern: '*://*.example/*', setting: 'allow' })
    expect(setting(w, OLD, 'images', SITE)).toBe('allow')
    expect(setting(w, OLD, 'images', 'https://x.org/')).toBe('block')
    set(w, NEW, 'images', { primaryPattern: '<all_urls>', setting: 'block' })
    expect(setting(w, OLD, 'images', SITE)).toBe('block')
    expect(w.permissions.resolve('images', SITE)).toBe('deny')
    w.api.unload(NEW)
    expect(setting(w, OLD, 'images', SITE)).toBe('allow')
    w.api.load(NEW)
    expect(setting(w, OLD, 'images', SITE)).toBe('block')
  })

  it('a cookies rule may name the embedding site; get takes the secondary URL', () => {
    const w = world()
    set(w, OLD, 'cookies', {
      primaryPattern: 'https://tracker.example/*',
      secondaryPattern: 'https://news.example/*',
      setting: 'block'
    })
    expect(
      get(w, OLD, 'cookies', { primaryUrl: 'https://tracker.example/p', secondaryUrl: SITE })
        .setting
    ).toBe('block')
    expect(
      get(w, OLD, 'cookies', { primaryUrl: 'https://tracker.example/p', secondaryUrl: OTHER })
        .setting
    ).toBe('allow')
    expect(
      w.permissions.resolve('on-device-site-data', 'https://tracker.example/p', {
        embedderUrl: SITE
      })
    ).toBe('deny')
    expect(w.permissions.resolve('on-device-site-data', 'https://tracker.example/p')).toBe('allow')
  })
})

describe('ContentSettingsApi: private windows', () => {
  it('incognito rules and reads need the extension allowed there and a private window open', () => {
    const w = world()
    expect(() =>
      set(w, OLD, 'notifications', {
        primaryPattern: '<all_urls>',
        setting: 'block',
        scope: 'incognito_session_only'
      })
    ).toThrow(INCOGNITO_ERROR)
    expect(() => get(w, OLD, 'notifications', { primaryUrl: SITE, incognito: true })).toThrow(
      INCOGNITO_ERROR
    )
    w.privateAllowed.add(OLD)
    expect(() => get(w, OLD, 'notifications', { primaryUrl: SITE, incognito: true })).toThrow(
      NO_INCOGNITO_WINDOW_ERROR
    )
    w.privateWindows = 1
    set(w, OLD, 'notifications', {
      primaryPattern: '<all_urls>',
      setting: 'block',
      scope: 'incognito_session_only'
    })
    expect(get(w, OLD, 'notifications', { primaryUrl: SITE, incognito: true }).setting).toBe(
      'block'
    )
    // Regular windows do not see the private-window rule; a regular rule is inherited there.
    expect(setting(w, OLD, 'notifications', SITE)).toBe('ask')
    set(w, OLD, 'notifications', { primaryPattern: 'https://news.example/*', setting: 'allow' })
    expect(get(w, OLD, 'notifications', { primaryUrl: OTHER, incognito: true }).setting).toBe(
      'block'
    )
    clear(w, OLD, 'notifications', { scope: 'incognito_session_only' })
    expect(get(w, OLD, 'notifications', { primaryUrl: SITE, incognito: true }).setting).toBe(
      'allow'
    )
    expect(w.persisted.get(OLD)?.notifications).toHaveLength(1)
  })
})

describe('ContentSettingsApi: persistence', () => {
  it('keeps regular rules across a restart, drops them with the extension', () => {
    const persisted: Persisted = new Map()
    const first = world(persisted)
    set(first, OLD, 'notifications', { primaryPattern: 'https://news.example/*', setting: 'block' })
    first.privateAllowed.add(OLD)
    first.privateWindows = 1
    set(first, OLD, 'notifications', {
      primaryPattern: '<all_urls>',
      setting: 'allow',
      scope: 'incognito_session_only'
    })
    expect(persisted.get(OLD)?.notifications).toEqual([
      {
        primaryPattern: 'https://news.example/*',
        secondaryPattern: '<all_urls>',
        setting: 'block',
        scope: 'regular'
      }
    ])
    const second = world(persisted)
    expect(setting(second, OLD, 'notifications', SITE)).toBe('block')
    expect(second.permissions.resolve('notifications', SITE)).toBe('deny')
    second.api.forget(OLD)
    expect(persisted.has(OLD)).toBe(false)
    expect(setting(second, NEW, 'notifications', SITE)).toBe('ask')
  })

  it('an extension without the permission loads nothing, even with stored rules', () => {
    const persisted: Persisted = new Map([
      [
        NO_PERMISSION,
        {
          javascript: [
            {
              primaryPattern: '<all_urls>',
              secondaryPattern: '<all_urls>',
              setting: 'block',
              scope: 'regular' as const
            }
          ]
        }
      ]
    ])
    const w = world(persisted)
    expect(setting(w, OLD, 'javascript', SITE)).toBe('allow')
  })
})

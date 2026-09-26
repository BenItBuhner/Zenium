import { describe, expect, it } from 'vitest'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_PERMISSION_ERROR,
  type ScopedValues
} from '../../../core/extensions/api/privacy'
import type { ExtensionControl } from '../../../shared/types'
import type { ListenerOptions, WebRequestDetails } from '../blocking'
import type { WebRequestEvent, WebRequestListener } from '../webRequest'
import { ExtensionControls } from '../extensionApi/controls'
import {
  PRIVACY_CONTROL_KEYS,
  PRIVACY_REGISTRANT,
  PrivacyApi,
  type PrivacyPage
} from '../extensionApi/privacy'
import type { ApiContext, ApiHost } from '../extensionApi/types'
import type { WebRequestListenerHost } from '../extensionApi/webRequest'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NO_PERMISSION = 'cccccccccccccccccccccccccccccccc'

interface Hooked {
  event: WebRequestEvent
  listener: WebRequestListener
  options: ListenerOptions
  removed: boolean
}

class FakePipeline implements WebRequestListenerHost {
  hooked: Hooked[] = []

  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void {
    const entry: Hooked = { event, listener, options, removed: false }
    this.hooked.push(entry)
    return () => {
      entry.removed = true
    }
  }

  removeListenersOf(registrant: string): void {
    for (const entry of this.hooked)
      if (entry.options.registrant === registrant) entry.removed = true
  }

  live(): Hooked[] {
    return this.hooked.filter((h) => !h.removed)
  }

  fire(event: WebRequestEvent, details: Partial<WebRequestDetails>): unknown[] {
    return this.live()
      .filter((h) => h.event === event)
      .map((h) =>
        h.listener({
          event,
          requestId: '1',
          url: 'https://cdn.example/a.js',
          method: 'GET',
          resourceType: 'script',
          frameId: 0,
          parentFrameId: -1,
          tabId: 'tab-1',
          partition: 'default',
          initiator: 'https://page.example',
          documentUrl: 'https://page.example/',
          timestamp: 100,
          ...details
        })
      )
  }
}

class FakePage implements PrivacyPage {
  policies: string[] = []
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  setWebRTCIPHandlingPolicy(policy: string): void {
    this.policies.push(policy)
  }
}

interface Dispatched {
  extensionId: string
  event: string
  details: unknown
}

/** The user's own settings the API answers for and follows (`browserValue`). */
interface UserSettings {
  privacy: { safeBrowsingEnabled: boolean; dnt: boolean; thirdPartyCookies: string }
  passwords: { offerToSave: boolean }
  searchSuggestions: boolean
  autofill: { addresses: boolean; cards: boolean }
}

interface World {
  api: PrivacyApi
  pipeline: FakePipeline
  dispatched: Dispatched[]
  /** Every map published to the Settings page (`UIState.extensionControls`), in order. */
  controls: Array<Record<string, ExtensionControl>>
  loaded: Set<string>
  privateAllowed: Set<string>
  privateWindows: number
  settings: UserSettings
  /** The user changed a setting: the state committed (`State.subscribe`). */
  commit(): void
  persisted: Map<string, Record<string, ScopedValues>>
  ctx(extensionId: string): ApiContext
}

function world(options: { attach?: boolean } = {}): World {
  const dispatched: Dispatched[] = []
  const persisted = new Map<string, Record<string, ScopedValues>>()
  const controls: Array<Record<string, ExtensionControl>> = []
  const listeners: Array<() => void> = []
  const state: World = {
    api: undefined as unknown as PrivacyApi,
    pipeline: new FakePipeline(),
    dispatched,
    controls,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    privateAllowed: new Set(),
    privateWindows: 0,
    settings: {
      privacy: { safeBrowsingEnabled: true, dnt: false, thirdPartyCookies: 'block-private' },
      passwords: { offerToSave: true },
      searchSuggestions: true,
      autofill: { addresses: true, cards: true }
    },
    commit: () => {
      for (const listener of listeners) listener()
    },
    persisted,
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
  const host = {
    controls: new ExtensionControls({
      setExtensionControls: (map) => {
        controls.push(map)
      }
    }),
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['privacy'],
      origins: []
    }),
    loaded: (extensionId: string) =>
      state.loaded.has(extensionId) ? { id: extensionId } : undefined,
    allLoaded: () => [...state.loaded].map((id) => ({ id })),
    partitionsOf: (extensionId: string) =>
      state.privateAllowed.has(extensionId) ? ['default', 'private'] : ['default'],
    dispatch: (extensionId: string, namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ extensionId, event: `${namespace}.${event}`, details: args[0] })
    },
    store: {
      privacyValues: (extensionId: string) => persisted.get(extensionId) ?? {},
      setPrivacyValues: (extensionId: string, values: Record<string, ScopedValues>) => {
        if (Object.keys(values).length === 0) persisted.delete(extensionId)
        else persisted.set(extensionId, values)
      }
    },
    browser: {
      extensions: {
        list: () => [
          { id: OLD, name: 'Older Guard', installedAt: 1000 },
          { id: NEW, name: 'Newer Guard', installedAt: 2000 },
          { id: NO_PERMISSION, name: 'Bystander', installedAt: 3000 }
        ]
      },
      allWindows: () => Array.from({ length: state.privateWindows }, () => ({ isPrivate: true })),
      state: {
        get settings(): UserSettings {
          return state.settings
        },
        subscribe: (listener: () => void) => {
          listeners.push(listener)
          return () => {
            listeners.splice(listeners.indexOf(listener), 1)
          }
        }
      }
    }
  } as unknown as ApiHost
  state.api = new PrivacyApi(host)
  if (options.attach !== false) state.api.attach(state.pipeline)
  for (const id of state.loaded) state.api.load(id)
  return state
}

function get(
  w: World,
  extensionId: string,
  object: string,
  setting: string,
  details = {}
): unknown {
  return w.api.handlers.get(w.ctx(extensionId), object, setting, details)
}

function set(
  w: World,
  extensionId: string,
  object: string,
  setting: string,
  details: unknown
): void {
  w.api.handlers.set(w.ctx(extensionId), object, setting, details)
}

function clear(w: World, extensionId: string, object: string, setting: string, details = {}): void {
  w.api.handlers.clear(w.ctx(extensionId), object, setting, details)
}

describe('PrivacyApi handlers', () => {
  it('needs the privacy permission and a known setting', () => {
    const w = world()
    expect(() => get(w, NO_PERMISSION, 'network', 'webRTCIPHandlingPolicy')).toThrow(
      PRIVACY_PERMISSION_ERROR
    )
    expect(() => get(w, OLD, 'network', 'nope')).toThrow('Unknown privacy setting network.nope.')
    expect(() => set(w, OLD, 'websites', 'doNotTrackEnabled', { value: 'yes' })).toThrow(
      "Invalid value for 'doNotTrackEnabled': expected a boolean."
    )
    expect(() => set(w, OLD, 'websites', 'doNotTrackEnabled', {})).toThrow(
      "Missing required property 'value'."
    )
  })

  it('answers get with the browser value until an extension sets one, then round-trips it', () => {
    const w = world()
    expect(get(w, OLD, 'network', 'webRTCIPHandlingPolicy')).toEqual({
      value: 'default',
      levelOfControl: 'controllable_by_this_extension'
    })
    set(w, OLD, 'network', 'webRTCIPHandlingPolicy', { value: 'default_public_interface_only' })
    expect(get(w, OLD, 'network', 'webRTCIPHandlingPolicy')).toEqual({
      value: 'default_public_interface_only',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(get(w, NEW, 'network', 'webRTCIPHandlingPolicy')).toEqual({
      value: 'default_public_interface_only',
      levelOfControl: 'controlled_by_other_extensions'
    })
    clear(w, OLD, 'network', 'webRTCIPHandlingPolicy', { scope: 'regular' })
    expect(get(w, NEW, 'network', 'webRTCIPHandlingPolicy')).toEqual({
      value: 'default',
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('lets the most recently installed extension win, and re-ranks when the order changes', () => {
    const w = world()
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: false })
    set(w, NEW, 'websites', 'hyperlinkAuditingEnabled', { value: true })
    expect(get(w, OLD, 'websites', 'hyperlinkAuditingEnabled')).toEqual({
      value: true,
      levelOfControl: 'controlled_by_other_extensions'
    })
    // NEW is disabled: OLD's value applies again; NEW's own value waits for its return.
    w.loaded.delete(NEW)
    w.api.unload(NEW)
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', false)).toBe(false)
    w.loaded.add(NEW)
    w.api.load(NEW)
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', false)).toBe(true)
  })

  it("answers the user's own settings as the browser value of the settings Zenium has", () => {
    const w = world()
    expect(get(w, OLD, 'services', 'passwordSavingEnabled')).toMatchObject({ value: true })
    w.settings.passwords.offerToSave = false
    expect(get(w, OLD, 'services', 'passwordSavingEnabled')).toMatchObject({ value: false })
    expect(get(w, OLD, 'services', 'safeBrowsingEnabled')).toMatchObject({ value: true })
    expect(get(w, OLD, 'services', 'searchSuggestEnabled')).toMatchObject({ value: true })
    expect(get(w, OLD, 'services', 'autofillAddressEnabled')).toMatchObject({ value: true })
    expect(get(w, OLD, 'services', 'autofillCreditCardEnabled')).toMatchObject({ value: true })
    expect(get(w, OLD, 'websites', 'doNotTrackEnabled')).toMatchObject({ value: false })
    w.settings.privacy.safeBrowsingEnabled = false
    w.settings.searchSuggestions = false
    w.settings.autofill.cards = false
    w.settings.privacy.dnt = true
    expect(get(w, OLD, 'services', 'safeBrowsingEnabled')).toMatchObject({ value: false })
    expect(get(w, OLD, 'services', 'searchSuggestEnabled')).toMatchObject({ value: false })
    expect(get(w, OLD, 'services', 'autofillAddressEnabled')).toMatchObject({ value: true })
    expect(get(w, OLD, 'services', 'autofillCreditCardEnabled')).toMatchObject({ value: false })
    expect(get(w, OLD, 'websites', 'doNotTrackEnabled')).toMatchObject({ value: true })
    // Third-party cookies read as allowed unless blocked everywhere (Chrome's CookieControlsMode
    // transform reads its incognito-only mode as allowed too).
    expect(get(w, OLD, 'websites', 'thirdPartyCookiesAllowed')).toMatchObject({ value: true })
    w.settings.privacy.thirdPartyCookies = 'allow'
    expect(get(w, OLD, 'websites', 'thirdPartyCookiesAllowed')).toMatchObject({ value: true })
    w.settings.privacy.thirdPartyCookies = 'block'
    expect(get(w, OLD, 'websites', 'thirdPartyCookiesAllowed')).toMatchObject({ value: false })
    // A setting Zenium has nothing behind keeps the spec's default.
    expect(get(w, OLD, 'network', 'networkPredictionEnabled')).toMatchObject({ value: true })
  })

  it("reports the user's own change of a setting through onChange, but not under an extension's value", () => {
    const w = world()
    w.settings.privacy.safeBrowsingEnabled = false
    w.commit()
    expect(w.dispatched).toEqual([
      {
        extensionId: OLD,
        event: 'privacy.services.safeBrowsingEnabled.onChange',
        details: { value: false, levelOfControl: 'controllable_by_this_extension' }
      },
      {
        extensionId: NEW,
        event: 'privacy.services.safeBrowsingEnabled.onChange',
        details: { value: false, levelOfControl: 'controllable_by_this_extension' }
      }
    ])
    w.dispatched.length = 0
    // A commit that moved none of the settings the API reads is nothing.
    w.commit()
    expect(w.dispatched).toEqual([])
    // Under an extension's value the user's own change moves nothing: the extension's stands.
    set(w, NEW, 'services', 'safeBrowsingEnabled', { value: true })
    w.dispatched.length = 0
    w.settings.privacy.safeBrowsingEnabled = true
    w.commit()
    expect(w.dispatched).toEqual([])
    expect(w.api.effectiveValue('services', 'safeBrowsingEnabled', false)).toBe(true)
    // The extension lets go: the user's value (the same) applies, and the level of control
    // changed, which Chrome reports as a change too.
    clear(w, NEW, 'services', 'safeBrowsingEnabled')
    expect(w.dispatched.map((d) => d.details)).toEqual([
      { value: true, levelOfControl: 'controllable_by_this_extension' },
      { value: true, levelOfControl: 'controllable_by_this_extension' }
    ])
  })

  it('persists values (but the session-only scope) and reads them back on load', () => {
    const w = world()
    w.privateAllowed.add(OLD)
    w.privateWindows = 1
    set(w, OLD, 'websites', 'referrersEnabled', { value: false })
    set(w, OLD, 'websites', 'referrersEnabled', { value: true, scope: 'incognito_session_only' })
    set(w, OLD, 'network', 'networkPredictionEnabled', { value: false, scope: 'regular_only' })
    expect(w.persisted.get(OLD)).toEqual({
      'websites.referrersEnabled': { regular: false },
      'network.networkPredictionEnabled': { regular_only: false }
    })
    // A fresh host over the same store: the values apply from the first load.
    const again = world({ attach: false })
    again.persisted.set(OLD, w.persisted.get(OLD)!)
    again.api.load(OLD)
    expect(get(again, NEW, 'websites', 'referrersEnabled')).toEqual({
      value: false,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(again.api.effectiveValue('network', 'networkPredictionEnabled', true)).toBe(true)
    // Uninstalled: nothing of it is left in the store.
    again.api.forget(OLD)
    expect(again.persisted.has(OLD)).toBe(false)
    expect(again.api.effectiveValue('websites', 'referrersEnabled', false)).toBe(true)
  })
})

describe('PrivacyApi and private windows', () => {
  it('refuses private-window reads and scopes to extensions the user has not allowed there', () => {
    const w = world()
    expect(() => get(w, OLD, 'websites', 'doNotTrackEnabled', { incognito: true })).toThrow(
      INCOGNITO_ERROR
    )
    expect(() =>
      set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true, scope: 'incognito_persistent' })
    ).toThrow(INCOGNITO_ERROR)
    expect(() =>
      clear(w, OLD, 'websites', 'doNotTrackEnabled', { scope: 'incognito_session_only' })
    ).toThrow(INCOGNITO_ERROR)
    w.privateAllowed.add(OLD)
    expect(() =>
      set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true, scope: 'incognito_session_only' })
    ).toThrow(INCOGNITO_SCOPE_ERROR)
    w.privateWindows = 1
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true, scope: 'incognito_session_only' })
    expect(get(w, OLD, 'websites', 'doNotTrackEnabled', { incognito: true })).toEqual({
      value: true,
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: true
    })
    expect(get(w, OLD, 'websites', 'doNotTrackEnabled')).toMatchObject({ value: false })
  })

  it("keeps an extension's regular value out of private windows until it is allowed there", () => {
    const w = world()
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: false })
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', false)).toBe(false)
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', true)).toBe(true)
    w.privateAllowed.add(OLD)
    w.api.privateAccessChanged()
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', true)).toBe(false)
    w.privateAllowed.delete(OLD)
    w.api.privateAccessChanged()
    expect(w.api.effectiveValue('websites', 'hyperlinkAuditingEnabled', true)).toBe(true)
  })
})

describe('PrivacyApi onChange', () => {
  it('tells every permitted extension about a changed value, with its own level of control', () => {
    const w = world()
    set(w, NEW, 'network', 'networkPredictionEnabled', { value: false })
    expect(w.dispatched).toEqual([
      {
        extensionId: OLD,
        event: 'privacy.network.networkPredictionEnabled.onChange',
        details: { value: false, levelOfControl: 'controlled_by_other_extensions' }
      },
      {
        extensionId: NEW,
        event: 'privacy.network.networkPredictionEnabled.onChange',
        details: { value: false, levelOfControl: 'controlled_by_this_extension' }
      }
    ])
    w.dispatched.length = 0
    // Setting the same value again changes nothing; a private-window change reaches only the
    // extensions allowed there, flagged as private-window specific.
    set(w, NEW, 'network', 'networkPredictionEnabled', { value: false })
    expect(w.dispatched).toEqual([])
    w.privateAllowed.add(NEW)
    w.api.privateAccessChanged()
    w.dispatched.length = 0
    set(w, NEW, 'network', 'networkPredictionEnabled', {
      value: true,
      scope: 'incognito_persistent'
    })
    expect(w.dispatched).toEqual([
      {
        extensionId: NEW,
        event: 'privacy.network.networkPredictionEnabled.onChange',
        details: {
          value: true,
          levelOfControl: 'controlled_by_this_extension',
          incognitoSpecific: true
        }
      }
    ])
  })
})

describe('PrivacyApi and the Settings page', () => {
  it("publishes the settings it holds over Zenium's rows, whole, with the extension's value, and drops them as they are let go", () => {
    const w = world()
    expect(w.controls).toEqual([])
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true })
    expect(w.controls.at(-1)).toEqual({
      'privacy.dnt': { extensionId: OLD, name: 'Older Guard', value: true }
    })
    // The newer extension's value over the same setting moves the key to it, value and all.
    set(w, NEW, 'websites', 'doNotTrackEnabled', { value: false })
    expect(w.controls.at(-1)).toEqual({
      'privacy.dnt': { extensionId: NEW, name: 'Newer Guard', value: false }
    })
    // The same extension moving its own value is a change the row sees.
    const before = w.controls.length
    set(w, NEW, 'websites', 'doNotTrackEnabled', { value: true })
    expect(w.controls).toHaveLength(before + 1)
    expect(w.controls.at(-1)!['privacy.dnt']).toMatchObject({ extensionId: NEW, value: true })
    // Disabled: its keys go, the older extension's value surfaces on the same publish.
    w.loaded.delete(NEW)
    w.api.unload(NEW)
    expect(w.controls.at(-1)).toEqual({
      'privacy.dnt': { extensionId: OLD, name: 'Older Guard', value: true }
    })
    // Uninstalled: nothing is left.
    w.loaded.delete(OLD)
    w.api.forget(OLD)
    expect(w.controls.at(-1)).toEqual({})
  })

  it("stored-only: no mark until the service applies it – Safe Browsing, third-party cookies, search suggestions, offering to save passwords, the two autofill switches publish no key while their services keep the user's value; Do Not Track, in effect, is the table", () => {
    const w = world()
    set(w, OLD, 'services', 'safeBrowsingEnabled', { value: false })
    set(w, OLD, 'services', 'searchSuggestEnabled', { value: false })
    set(w, OLD, 'services', 'passwordSavingEnabled', { value: false })
    set(w, OLD, 'services', 'autofillAddressEnabled', { value: false })
    set(w, OLD, 'services', 'autofillCreditCardEnabled', { value: false })
    set(w, OLD, 'websites', 'thirdPartyCookiesAllowed', { value: false })
    // Remembered and reported to the extension as its own value...
    expect(w.api.effectiveValue('services', 'safeBrowsingEnabled', false)).toBe(false)
    expect(w.api.effectiveValue('services', 'passwordSavingEnabled', false)).toBe(false)
    expect(w.api.effectiveValue('websites', 'thirdPartyCookiesAllowed', false)).toBe(false)
    // ...and published to no row: a row says "controlled" only for a value in effect (F3).
    expect(w.controls).toEqual([])
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true })
    expect(w.controls.at(-1)).toEqual({
      'privacy.dnt': { extensionId: OLD, name: 'Older Guard', value: true }
    })
    expect(PRIVACY_CONTROL_KEYS).toEqual({ 'websites.doNotTrackEnabled': 'privacy.dnt' })
  })

  it('publishes nothing for a setting no row shows, nor for a private-window-only value', () => {
    const w = world()
    set(w, OLD, 'network', 'networkPredictionEnabled', { value: false })
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: false })
    set(w, OLD, 'network', 'webRTCIPHandlingPolicy', { value: 'disable_non_proxied_udp' })
    expect(w.controls).toEqual([])
    // The Settings rows are the regular profile's: a value for private windows alone marks none.
    w.privateAllowed.add(OLD)
    w.api.privateAccessChanged()
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true, scope: 'incognito_persistent' })
    expect(w.api.effectiveValue('websites', 'doNotTrackEnabled', true)).toBe(true)
    expect(w.controls).toEqual([])
  })

  it("keeps an extension's value over the user's own, and marks the row even at the user's value", () => {
    const w = world()
    // Chrome marks the row whenever an extension holds the pref, whatever the value.
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: false })
    expect(w.controls.at(-1)).toEqual({
      'privacy.dnt': { extensionId: OLD, name: 'Older Guard', value: false }
    })
    w.settings.privacy.dnt = true
    w.commit()
    expect(w.api.effectiveValue('websites', 'doNotTrackEnabled', false)).toBe(false)
    expect(w.controls.at(-1)!['privacy.dnt']).toMatchObject({ value: false })
  })
})

describe('PrivacyApi enforcement', () => {
  it('applies the WebRTC policy to the pages of the kind of window it is for', () => {
    const w = world()
    const page = new FakePage()
    const privatePage = new FakePage()
    w.api.pageCreated(page, false)
    w.api.pageCreated(privatePage, true)
    expect(page.policies).toEqual(['default'])
    set(w, OLD, 'network', 'webRTCIPHandlingPolicy', { value: 'disable_non_proxied_udp' })
    expect(page.policies).toEqual(['default', 'disable_non_proxied_udp'])
    expect(privatePage.policies).toEqual(['default'])
    // A page that comes up later starts with the current policy; a destroyed one is dropped.
    const later = new FakePage()
    w.api.pageCreated(later, false)
    expect(later.policies).toEqual(['disable_non_proxied_udp'])
    page.destroyed = true
    clear(w, OLD, 'network', 'webRTCIPHandlingPolicy')
    expect(page.policies).toEqual(['default', 'disable_non_proxied_udp'])
    expect(later.policies).toEqual(['disable_non_proxied_udp', 'default'])
  })

  it('hooks the request pipeline only while a request setting is controlled', () => {
    const w = world()
    expect(w.pipeline.live()).toEqual([])
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: false })
    expect(
      w.pipeline.live().map((h) => [h.event, h.options.registrant, h.options.blocking])
    ).toEqual([
      ['onBeforeRequest', PRIVACY_REGISTRANT, true],
      ['onBeforeSendHeaders', PRIVACY_REGISTRANT, true]
    ])
    // Setting a request setting to the browser's own value needs no hook.
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: true })
    expect(w.pipeline.live()).toEqual([])
    // A pipeline attached after the values were set gets the hooks at once.
    const late = world({ attach: false })
    set(late, OLD, 'websites', 'doNotTrackEnabled', { value: true })
    expect(late.pipeline.live()).toEqual([])
    late.api.attach(late.pipeline)
    expect(late.pipeline.live()).toHaveLength(2)
  })

  it('cancels pings when hyperlink auditing is off, in the windows the value applies to', () => {
    const w = world()
    set(w, OLD, 'websites', 'hyperlinkAuditingEnabled', { value: false })
    expect(w.pipeline.fire('onBeforeRequest', { resourceType: 'ping' })).toEqual([{ cancel: true }])
    expect(w.pipeline.fire('onBeforeRequest', { resourceType: 'script' })).toEqual([undefined])
    // The private window's pings are untouched: OLD is not allowed there.
    expect(
      w.pipeline.fire('onBeforeRequest', { resourceType: 'ping', partition: 'private' })
    ).toEqual([undefined])
    w.privateAllowed.add(OLD)
    w.api.privateAccessChanged()
    expect(
      w.pipeline.fire('onBeforeRequest', { resourceType: 'ping', partition: 'private' })
    ).toEqual([{ cancel: true }])
  })

  it('drops the Referer header when referrers are off and adds DNT when Do Not Track is on', () => {
    const w = world()
    set(w, OLD, 'websites', 'referrersEnabled', { value: false })
    const headers = { Accept: '*/*', Referer: 'https://page.example/' }
    expect(w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: headers })).toEqual([
      { requestHeaders: { Accept: '*/*' } }
    ])
    expect(headers.Referer).toBe('https://page.example/')
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: true })
    expect(w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { Accept: '*/*' } })).toEqual([
      { requestHeaders: { Accept: '*/*', DNT: '1' } }
    ])
    expect(
      w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { dnt: '0', Referer: 'x' } })
    ).toEqual([{ requestHeaders: { DNT: '1' } }])
    // Nothing to do: the request goes on unchanged.
    clear(w, OLD, 'websites', 'referrersEnabled')
    expect(w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { DNT: '1' } })).toEqual([
      undefined
    ])
    expect(
      w.pipeline.fire('onBeforeSendHeaders', {
        requestHeaders: { Referer: 'x' },
        partition: 'private'
      })
    ).toEqual([undefined])
  })

  it("strips the DNT header the user's own setting sends while an extension holds Do Not Track off", () => {
    const w = world()
    w.settings.privacy.dnt = true
    w.commit()
    // The user's own value needs no hook: the browser's signals layer sends the header.
    expect(w.pipeline.live()).toEqual([])
    set(w, OLD, 'websites', 'doNotTrackEnabled', { value: false })
    expect(w.pipeline.live()).toHaveLength(2)
    expect(
      w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { Accept: '*/*', dnt: '1' } })
    ).toEqual([{ requestHeaders: { Accept: '*/*' } }])
    expect(w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { Accept: '*/*' } })).toEqual([
      undefined
    ])
    // The user turning the signal off leaves the extension's value in place, and the hook idle.
    w.settings.privacy.dnt = false
    w.commit()
    expect(w.pipeline.live()).toEqual([])
    expect(w.api.effectiveValue('websites', 'doNotTrackEnabled', false)).toBe(false)
  })
})

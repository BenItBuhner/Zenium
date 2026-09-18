import { describe, expect, it } from 'vitest'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_PERMISSION_ERROR,
  type ScopedValues
} from '../../../core/extensions/api/privacy'
import type { ListenerOptions, WebRequestDetails } from '../blocking'
import type { WebRequestEvent, WebRequestListener } from '../webRequest'
import { PRIVACY_REGISTRANT, PrivacyApi, type PrivacyPage } from '../extensionApi/privacy'
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

interface World {
  api: PrivacyApi
  pipeline: FakePipeline
  dispatched: Dispatched[]
  loaded: Set<string>
  privateAllowed: Set<string>
  privateWindows: number
  offerToSave: boolean
  persisted: Map<string, Record<string, ScopedValues>>
  ctx(extensionId: string): ApiContext
}

function world(options: { attach?: boolean } = {}): World {
  const dispatched: Dispatched[] = []
  const persisted = new Map<string, Record<string, ScopedValues>>()
  const state: World = {
    api: undefined as unknown as PrivacyApi,
    pipeline: new FakePipeline(),
    dispatched,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    privateAllowed: new Set(),
    privateWindows: 0,
    offerToSave: true,
    persisted,
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
  const host = {
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
          { id: OLD, installedAt: 1000 },
          { id: NEW, installedAt: 2000 },
          { id: NO_PERMISSION, installedAt: 3000 }
        ]
      },
      allWindows: () => Array.from({ length: state.privateWindows }, () => ({ isPrivate: true })),
      state: {
        settings: {
          passwords: {
            get offerToSave(): boolean {
              return state.offerToSave
            }
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

  it('reads the vault setting as the browser value of passwordSavingEnabled', () => {
    const w = world()
    expect(get(w, OLD, 'services', 'passwordSavingEnabled')).toMatchObject({ value: true })
    w.offerToSave = false
    expect(get(w, OLD, 'services', 'passwordSavingEnabled')).toMatchObject({ value: false })
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
})

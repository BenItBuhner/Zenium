import { describe, expect, it } from 'vitest'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  type ScopedValues
} from '../../../core/extensions/api/privacy'
import { PROXY_PERMISSION_ERROR, type SessionProxyConfig } from '../../../core/extensions/api/proxy'
import { ProxyApi, type ProxySession } from '../extensionApi/proxy'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NO_PERMISSION = 'cccccccccccccccccccccccccccccccc'

class FakeSession implements ProxySession {
  applied: SessionProxyConfig[] = []
  refuse: string | null = null

  setProxy(config: SessionProxyConfig): Promise<void> {
    this.applied.push(config)
    return this.refuse ? Promise.reject(new Error(this.refuse)) : Promise.resolve()
  }

  get last(): SessionProxyConfig | undefined {
    return this.applied[this.applied.length - 1]
  }
}

interface Dispatched {
  extensionId: string
  event: string
  details: unknown
}

interface World {
  api: ProxyApi
  regular: FakeSession
  container: FakeSession
  privateSession: FakeSession | null
  dispatched: Dispatched[]
  loaded: Set<string>
  privateAllowed: Set<string>
  privateWindows: number
  persisted: Map<string, ScopedValues>
  /** The private window opened: its session comes up now. */
  openPrivate(): FakeSession
  ctx(extensionId: string): ApiContext
}

function world(persisted = new Map<string, ScopedValues>()): World {
  const dispatched: Dispatched[] = []
  const hooks: Array<(session: ProxySession, incognito: boolean) => void> = []
  const state: World = {
    api: undefined as unknown as ProxyApi,
    regular: new FakeSession(),
    container: new FakeSession(),
    privateSession: null,
    dispatched,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    privateAllowed: new Set(),
    privateWindows: 0,
    persisted,
    openPrivate: () => {
      const session = new FakeSession()
      state.privateSession = session
      state.privateWindows = 1
      for (const hook of hooks) hook(session, true)
      return session
    },
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['proxy'],
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
      proxyValues: (extensionId: string) => persisted.get(extensionId) ?? {},
      setProxyValues: (extensionId: string, values: ScopedValues) => {
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
      allWindows: () => Array.from({ length: state.privateWindows }, () => ({ isPrivate: true }))
    }
  } as unknown as ApiHost
  state.api = new ProxyApi(host, {
    configure: (hook) => {
      hooks.push(hook)
      hook(state.regular, false)
      hook(state.container, false)
      if (state.privateSession) hook(state.privateSession, true)
    }
  })
  for (const id of state.loaded) state.api.load(id)
  return state
}

const get = (w: World, id: string, details: unknown = {}): unknown =>
  w.api.handlers.get(w.ctx(id), 'settings', details)
const set = (w: World, id: string, details: unknown): unknown =>
  w.api.handlers.set(w.ctx(id), 'settings', details)
const clear = (w: World, id: string, details: unknown = {}): unknown =>
  w.api.handlers.clear(w.ctx(id), 'settings', details)

const PAC = {
  mode: 'pac_script',
  pacScript: { data: 'function FindProxyForURL() { return "DIRECT" }' }
}
const FIXED = { mode: 'fixed_servers', rules: { singleProxy: { host: 'p.example', port: 3128 } } }

describe('ProxyApi: the setting', () => {
  it('starts at the system\u2019s settings, controllable, touching no session', () => {
    const w = world()
    expect(get(w, OLD)).toEqual({
      value: { mode: 'system' },
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(w.regular.applied).toEqual([])
    expect(w.container.applied).toEqual([])
  })

  it('needs the proxy permission and knows only the settings member', () => {
    const w = world()
    expect(() => get(w, NO_PERMISSION)).toThrow(PROXY_PERMISSION_ERROR)
    expect(() => set(w, NO_PERMISSION, { value: PAC })).toThrow(PROXY_PERMISSION_ERROR)
    expect(() => w.api.handlers.get(w.ctx(OLD), 'other', {})).toThrow(
      'Unknown proxy setting other.'
    )
  })

  it('set applies the canonical config to every normal session, reports it back and persists it', () => {
    const w = world()
    set(w, OLD, { value: FIXED, scope: 'regular' })
    const expected = {
      mode: 'fixed_servers',
      proxyRules: 'p.example:3128',
      proxyBypassRules: ''
    }
    expect(w.regular.last).toEqual(expected)
    expect(w.container.last).toEqual(expected)
    expect(get(w, OLD)).toEqual({
      value: {
        mode: 'fixed_servers',
        rules: { singleProxy: { scheme: 'http', host: 'p.example', port: 3128 }, bypassList: [] }
      },
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(get(w, NEW)).toMatchObject({ levelOfControl: 'controlled_by_other_extensions' })
    expect(w.persisted.get(OLD)?.regular).toContain('"fixed_servers"')
    expect(w.api.effectiveConfig(false).mode).toBe('fixed_servers')
    expect(w.api.controller(false)).toBe(OLD)
  })

  it('rejects a bad config with Chrome\u2019s message and changes nothing', () => {
    const w = world()
    expect(() => set(w, OLD, { value: { mode: 'fixed_servers' } })).toThrow(
      "Proxy mode 'fixed_servers' requires a 'rules' field."
    )
    expect(() => set(w, OLD, { scope: 'regular' })).toThrow("Missing required property 'value'.")
    expect(() => set(w, OLD, { value: PAC, scope: 'everywhere' })).toThrow(
      "Invalid scope 'everywhere'."
    )
    expect(w.regular.applied).toEqual([])
    expect(w.persisted.size).toBe(0)
  })

  it('the most recently installed extension\u2019s value wins, and clearing it hands control back', () => {
    const w = world()
    set(w, OLD, { value: FIXED })
    set(w, NEW, { value: PAC })
    expect(w.regular.last?.mode).toBe('pac_script')
    expect(
      w.regular.last?.pacScript?.startsWith('data:application/x-ns-proxy-autoconfig;base64,')
    ).toBe(true)
    expect(get(w, OLD)).toMatchObject({
      value: { mode: 'pac_script' },
      levelOfControl: 'controlled_by_other_extensions'
    })
    clear(w, NEW, { scope: 'regular' })
    expect(w.regular.last?.mode).toBe('fixed_servers')
    expect(w.api.controller(false)).toBe(OLD)
    clear(w, OLD)
    expect(w.regular.last).toEqual({ mode: 'system' })
    expect(w.api.controller(false)).toBeNull()
    expect(w.persisted.size).toBe(0)
  })

  it('tells every extension holding the permission about a change, each with its own level of control', () => {
    const w = world()
    set(w, NEW, { value: PAC })
    const changes = w.dispatched.filter((d) => d.event === 'proxy.settings.onChange')
    expect(changes.map((d) => d.extensionId).sort()).toEqual([OLD, NEW])
    expect(changes.find((d) => d.extensionId === NEW)?.details).toEqual({
      value: { mode: 'pac_script', pacScript: { data: PAC.pacScript.data, mandatory: false } },
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(changes.find((d) => d.extensionId === OLD)?.details).toMatchObject({
      levelOfControl: 'controlled_by_other_extensions'
    })
    // Setting the same value again is not a change.
    w.dispatched.length = 0
    set(w, NEW, { value: PAC })
    expect(w.dispatched).toEqual([])
  })

  it('reports a configuration the session refused to the controlling extension as a fatal onProxyError', async () => {
    const w = world()
    w.regular.refuse = 'ERR_PROXY_CONFIGURATION_INVALID'
    set(w, OLD, { value: FIXED })
    await new Promise((r) => setTimeout(r, 0))
    const errors = w.dispatched.filter((d) => d.event === 'proxy.onProxyError')
    expect(errors).toHaveLength(1)
    expect(errors[0].extensionId).toBe(OLD)
    expect(errors[0].details).toEqual({
      fatal: true,
      error: 'net::ERR_PROXY_CONFIGURATION_INVALID',
      details: 'ERR_PROXY_CONFIGURATION_INVALID'
    })
  })
})

describe('ProxyApi: private windows', () => {
  it('follows the regular value only for extensions the user allowed there, and its session comes up configured', () => {
    const w = world()
    set(w, OLD, { value: FIXED })
    expect(w.api.effectiveConfig(true)).toEqual({ mode: 'system' })
    expect(() => get(w, OLD, { incognito: true })).toThrow(INCOGNITO_ERROR)
    expect(() => set(w, OLD, { value: PAC, scope: 'incognito_persistent' })).toThrow(
      INCOGNITO_ERROR
    )
    w.privateAllowed.add(OLD)
    w.api.privateAccessChanged()
    expect(w.api.effectiveConfig(true).mode).toBe('fixed_servers')
    const privateSession = w.openPrivate()
    expect(privateSession.last?.mode).toBe('fixed_servers')
    expect(get(w, OLD, { incognito: true })).toEqual({
      value: {
        mode: 'fixed_servers',
        rules: { singleProxy: { scheme: 'http', host: 'p.example', port: 3128 }, bypassList: [] }
      },
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: false
    })
  })

  it('a private-window value applies to the private session alone; the session-only one needs an open private window', () => {
    const w = world()
    w.privateAllowed.add(OLD)
    w.api.privateAccessChanged()
    expect(() => set(w, OLD, { value: PAC, scope: 'incognito_session_only' })).toThrow(
      INCOGNITO_SCOPE_ERROR
    )
    const privateSession = w.openPrivate()
    set(w, OLD, { value: PAC, scope: 'incognito_session_only' })
    expect(privateSession.last?.mode).toBe('pac_script')
    expect(w.regular.applied).toEqual([])
    expect(get(w, OLD, { incognito: true })).toMatchObject({ incognitoSpecific: true })
    // Session-only values are not persisted.
    expect(w.persisted.has(OLD)).toBe(false)
    set(w, OLD, { value: FIXED, scope: 'incognito_persistent' })
    expect(w.persisted.get(OLD)).toEqual({ incognito_persistent: expect.stringContaining('fixed') })
  })
})

describe('ProxyApi: lifecycle', () => {
  it('re-applies a persisted value on load, drops it while disabled and forgets it on uninstall', () => {
    const first = world()
    set(first, OLD, { value: FIXED })
    const restarted = world(first.persisted)
    expect(restarted.regular.last?.proxyRules).toBe('p.example:3128')
    expect(restarted.api.controller(false)).toBe(OLD)
    restarted.api.unload(OLD)
    expect(restarted.regular.last).toEqual({ mode: 'system' })
    expect(restarted.persisted.has(OLD)).toBe(true)
    restarted.api.load(OLD)
    expect(restarted.regular.last?.proxyRules).toBe('p.example:3128')
    restarted.api.forget(OLD)
    expect(restarted.regular.last).toEqual({ mode: 'system' })
    expect(restarted.persisted.has(OLD)).toBe(false)
  })

  it('drops an unreadable persisted value instead of applying it', () => {
    const w = world(new Map([[OLD, { regular: '{"mode":"nowhere"}' }]]))
    expect(w.regular.applied).toEqual([])
    expect(w.api.controller(false)).toBeNull()
  })

  it('a newer install takes over an older extension\u2019s control when the ranking changes', () => {
    const w = world()
    set(w, NEW, { value: PAC })
    set(w, OLD, { value: FIXED })
    expect(w.api.controller(false)).toBe(NEW)
    w.api.installOrderChanged()
    expect(w.api.controller(false)).toBe(NEW)
  })
})

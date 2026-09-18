import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
} from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  notifications: Array<{ kind: string; payload: unknown }>
  push(namespace: string, event: string, ...args: unknown[]): void
  pushDelivery(namespace: string, event: string, args: unknown[], delivery: EventDelivery): void
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
}

function fakeHost(kind: 'frame' | 'worker' = 'worker'): FakeHost {
  let listener:
    ((namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void) | null =
    null
  const host: FakeHost = {
    kind,
    calls: [],
    notifications: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify(kind, payload) {
      host.notifications.push({ kind, payload })
    },
    onEvent(fn) {
      listener = fn
    },
    push(namespace, event, ...args) {
      listener?.(namespace, event, args)
    },
    pushDelivery(namespace, event, args, delivery) {
      listener?.(namespace, event, args, delivery)
    }
  }
  return host
}

/** A stand-in for Chromium's native bindings: a distinct `browser` object and inert members. */
function installNativeGlobals(manifestVersion: 2 | 3 = 3): { chrome: Any; browser: Any } {
  const g = globalThis as Any
  const manifest = { manifest_version: manifestVersion, name: 'Probe', version: '1.0' }
  const nativeStorageArea = (): Any => {
    const items: Record<string, unknown> = {}
    return {
      get(keys: Any, cb: (items: Any) => void) {
        if (keys === null || keys === undefined) return cb({ ...items })
        const list =
          typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
        const out: Any = {}
        for (const k of list) if (k in items) out[k] = items[k]
        cb(out)
      },
      set(next: Any, cb: () => void) {
        Object.assign(items, next)
        cb()
      },
      remove(keys: Any, cb: () => void) {
        for (const k of typeof keys === 'string' ? [keys] : keys) delete items[k]
        cb()
      },
      clear(cb: () => void) {
        for (const k of Object.keys(items)) delete items[k]
        cb()
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const chrome: Any = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent(),
      onInstalled: nativeEvent(),
      onStartup: nativeEvent(),
      openOptionsPage: () => Promise.reject(new Error('Could not create an options page.'))
    },
    storage: {
      local: nativeStorageArea(),
      session: nativeStorageArea(),
      onChanged: nativeEvent()
    },
    tabs: {
      query: vi.fn(),
      getZoom: vi.fn(() => Promise.resolve(1)),
      setZoom: vi.fn(() => Promise.resolve()),
      sendMessage: vi.fn(),
      onUpdated: nativeEvent()
    },
    alarms: { create: vi.fn(), get: vi.fn(), onAlarm: nativeEvent() },
    action: { setBadgeText: () => Promise.resolve(), getBadgeText: () => Promise.resolve('') }
  }
  const browser: Any = { runtime: chrome.runtime, storage: chrome.storage }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: browser, configurable: true, writable: true })
  return { chrome, browser }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('installExtensionApi', () => {
  const g = globalThis as Any
  let host: FakeHost

  beforeEach(() => {
    installNativeGlobals()
    host = fakeHost()
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('aliases the browser global to the augmented chrome object and installs once', () => {
    const diag = installExtensionApi(host, API_SPEC)
    expect(diag.installed).toBe(true)
    expect(diag.browserAliased).toBe(true)
    expect(g.browser).toBe(g.chrome)
    expect(typeof g.browser.tabs.create).toBe('function')
    expect(typeof g.browser.windows.getAll).toBe('function')
    const again = installExtensionApi(host, API_SPEC)
    expect(again.installed).toBe(false)
    expect(host.notifications.filter((n) => n.kind === 'hello')).toHaveLength(1)
  })

  it('keeps native members that work and replaces inert ones in place', () => {
    const nativeGetZoom = g.chrome.tabs.getZoom
    const nativeSendMessage = g.chrome.tabs.sendMessage
    installExtensionApi(host, API_SPEC)
    expect(g.chrome.tabs.getZoom).toBe(nativeGetZoom)
    expect(g.chrome.tabs.sendMessage).toBe(nativeSendMessage)
    expect(g.chrome.tabs.query).not.toBe(installNativeGlobals)
    expect(Object.isFrozen(g.chrome)).toBe(false)
    expect(g.chrome.tabs.TAB_ID_NONE).toBe(-1)
    expect(g.chrome.action.getUserSettings).toBeTypeOf('function')
    expect(g.chrome.browserAction).toBeUndefined()
  })

  it('routes the part-2 namespaces to the host and answers cookies.getPartitionKey itself', async () => {
    installExtensionApi(host, API_SPEC)
    host.respond = (namespace, method) => {
      if (namespace === 'notifications' && method === 'create') return { ok: true, value: 'n1' }
      if (namespace === 'notifications' && method === 'getPermissionLevel')
        return { ok: true, value: 'granted' }
      if (namespace === 'cookies' && method === 'getAll') return { ok: true, value: [] }
      if (namespace === 'commands' && method === 'getAll') return { ok: true, value: [] }
      return { ok: true, value: null }
    }
    await expect(g.chrome.notifications.create('n1', { type: 'basic' })).resolves.toBe('n1')
    await expect(g.chrome.notifications.getPermissionLevel()).resolves.toBe('granted')
    await expect(g.chrome.cookies.getAll({ domain: 'a.test' })).resolves.toEqual([])
    await expect(g.chrome.cookies.get({ url: 'https://a.test', name: 'x' })).resolves.toBeNull()
    await expect(g.chrome.webNavigation.getFrame({ tabId: 1, frameId: 0 })).resolves.toBeNull()
    await expect(g.chrome.commands.getAll()).resolves.toEqual([])
    expect(host.calls.map((c) => `${c.namespace}.${c.method}`)).toEqual([
      'notifications.create',
      'notifications.getPermissionLevel',
      'cookies.getAll',
      'cookies.get',
      'webNavigation.getFrame',
      'commands.getAll'
    ])
    // Zenium has no per-site cookie partitions: the key is answered on this side.
    await expect(g.chrome.cookies.getPartitionKey({ tabId: 1 })).resolves.toEqual({
      partitionKey: {}
    })
    expect(host.calls).toHaveLength(6)
    expect(g.chrome.contextMenus.ContextType.ACTION).toBe('action')
    expect(g.chrome.declarativeNetRequest.DYNAMIC_RULESET_ID).toBe('_dynamic')
    expect(g.browser.webNavigation.onCommitted).toBe(g.chrome.webNavigation.onCommitted)
  })

  it('contextMenus.create returns the id synchronously and keeps onclick on this side', async () => {
    installExtensionApi(host, API_SPEC)
    const clicks: unknown[] = []
    const listened: unknown[] = []
    g.chrome.contextMenus.onClicked.addListener((info: unknown) => listened.push(info))
    let created = false
    const id = g.chrome.contextMenus.create(
      { id: 'zen', title: 'Zen', onclick: (...args: unknown[]) => clicks.push(args) },
      () => (created = true)
    )
    expect(id).toBe('zen')
    const generated = g.chrome.contextMenus.create({ title: 'x' })
    expect(generated).toBe(1)
    await flush()
    expect(created).toBe(true)
    // `onclick` is a function: it cannot cross to the host, a flag says one was given.
    expect(host.calls[0]).toMatchObject({
      namespace: 'contextMenus',
      method: 'create',
      args: [{ id: 'zen', title: 'Zen', onclick: true }, 'zen']
    })
    expect(host.calls[1]).toMatchObject({ method: 'create', args: [{ title: 'x' }, 1] })
    host.push('contextMenus', 'onClicked', { menuItemId: 'zen', editable: false }, { id: 3 })
    expect(clicks).toEqual([[{ menuItemId: 'zen', editable: false }, { id: 3 }]])
    expect(listened).toEqual([{ menuItemId: 'zen', editable: false }])
    await new Promise<void>((resolve) => g.chrome.contextMenus.removeAll(() => resolve()))
    host.push('contextMenus', 'onClicked', { menuItemId: 'zen' })
    expect(clicks).toHaveLength(1)
  })

  it('registers URL-filtered listeners with the host and delivers by filter id', () => {
    installExtensionApi(host, API_SPEC)
    const everyone: unknown[] = []
    const filtered: unknown[] = []
    g.chrome.webNavigation.onCommitted.addListener((d: unknown) => everyone.push(d))
    g.chrome.webNavigation.onCommitted.addListener((d: unknown) => filtered.push(d), {
      url: [{ hostSuffix: 'example.com' }]
    })
    expect(host.notifications.filter((n) => n.kind === 'listen').map((n) => n.payload)).toEqual([
      { event: 'webNavigation.onCommitted' },
      {
        event: 'webNavigation.onCommitted',
        filterId: 1,
        filters: [{ hostSuffix: 'example.com' }]
      }
    ])
    expect(() =>
      g.chrome.webNavigation.onCommitted.addListener(() => undefined, { url: 'nope' })
    ).toThrow(/Expected array of UrlFilter objects/)
    // The host addresses each delivery: everyone, or only the filters that matched.
    host.pushDelivery('webNavigation', 'onCommitted', [{ url: 'https://a.test/' }], {
      unfiltered: true,
      matched: []
    })
    host.pushDelivery('webNavigation', 'onCommitted', [{ url: 'https://example.com/' }], {
      unfiltered: true,
      matched: [1]
    })
    host.push('webNavigation', 'onCommitted', { url: 'https://everyone.test/' })
    expect(everyone.map((d: Any) => d.url)).toEqual([
      'https://a.test/',
      'https://example.com/',
      'https://everyone.test/'
    ])
    expect(filtered.map((d: Any) => d.url)).toEqual([
      'https://example.com/',
      'https://everyone.test/'
    ])
  })

  it('ignores a second addListener argument on events without filter support, as Chromium does', () => {
    installExtensionApi(host, API_SPEC)
    const seen: unknown[] = []
    const fn = (...args: unknown[]): void => void seen.push(args)
    // Violentmonkey: `tabs.onUpdated.addListener(fn, false)` and `(fn, cond && { properties })`.
    expect(() => g.chrome.tabs.onUpdated.addListener(fn, false)).not.toThrow()
    expect(() =>
      g.chrome.tabs.onUpdated.addListener(() => undefined, { properties: ['status'] })
    ).not.toThrow()
    expect(() => g.chrome.tabs.onRemoved.addListener(() => undefined, 'nope', 3)).not.toThrow()
    expect(g.chrome.tabs.onUpdated.hasListener(fn)).toBe(true)
    expect(host.notifications.filter((n) => n.kind === 'listen').map((n) => n.payload)).toEqual([
      { event: 'tabs.onUpdated' },
      { event: 'tabs.onRemoved' }
    ])
    host.push('tabs', 'onUpdated', 4, { status: 'complete' }, { id: 4 })
    expect(seen).toEqual([[4, { status: 'complete' }, { id: 4 }]])
    // Events with filter support keep validating the argument.
    expect(() => g.chrome.webNavigation.onCommitted.addListener(() => undefined, false)).toThrow(
      /No matching signature/
    )
  })

  it('defines the bridged namespaces only for extensions declaring their permission', () => {
    const manifest = {
      manifest_version: 3,
      name: 'Probe',
      version: '1.0',
      permissions: ['bookmarks', 'identity'],
      optional_permissions: ['tabGroups']
    }
    g.chrome.runtime.getManifest = () => manifest
    installExtensionApi(host, API_SPEC)
    expect(g.chrome.bookmarks.getTree).toBeTypeOf('function')
    // Optional and not granted yet: the namespace is there for the grant to make useful.
    expect(g.chrome.tabGroups.query).toBeTypeOf('function')
    expect(g.chrome.tabs.group).toBeTypeOf('function')
    expect(g.chrome.identity.getRedirectURL()).toBe(
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/'
    )
    for (const hidden of [
      'history',
      'downloads',
      'sessions',
      'topSites',
      'sidePanel',
      'browsingData',
      'tts'
    ]) {
      expect(g.chrome[hidden]).toBeUndefined()
    }
  })

  it('exposes browserAction instead of action for MV2', () => {
    installNativeGlobals(2)
    const diag = installExtensionApi(host, API_SPEC)
    expect(diag.manifestVersion).toBe(2)
    expect(typeof g.chrome.browserAction.setBadgeText).toBe('function')
    g.chrome.browserAction.setBadgeText({ text: '3' })
    expect(host.calls[0]).toMatchObject({ namespace: 'action', method: 'setBadgeText' })
  })

  it('returns a promise without a callback and calls back otherwise', async () => {
    installExtensionApi(host, API_SPEC)
    host.respond = () => ({ ok: true, value: [{ id: 7 }] })
    const viaPromise = await g.chrome.tabs.query({})
    expect(viaPromise).toEqual([{ id: 7 }])
    const cb = vi.fn()
    const ret = g.chrome.tabs.query({ active: true }, cb)
    expect(ret).toBeUndefined()
    await flush()
    expect(cb).toHaveBeenCalledWith([{ id: 7 }])
    expect(host.calls[1].args).toEqual([{ active: true }])
  })

  it('reports failures through runtime.lastError for callbacks and rejections for promises', async () => {
    installExtensionApi(host, API_SPEC)
    host.respond = () => ({ ok: false, error: 'No tab with id: 99.' })
    await expect(g.chrome.tabs.get(99)).rejects.toThrow('No tab with id: 99.')
    let seen: unknown = null
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    g.chrome.tabs.get(99, () => {
      seen = g.chrome.runtime.lastError
    })
    await flush()
    expect(seen).toEqual({ message: 'No tab with id: 99.' })
    expect(g.chrome.runtime.lastError).toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
    g.chrome.tabs.get(99, () => undefined)
    await flush()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unchecked runtime.lastError'))
  })

  it('skips optional arguments Chrome-style', () => {
    installExtensionApi(host, API_SPEC)
    g.chrome.tabs.update({ url: 'https://example.com' })
    expect(host.calls[0].args).toEqual([undefined, { url: 'https://example.com' }])
    g.chrome.tabs.update(3, { active: true })
    expect(host.calls[1].args).toEqual([3, { active: true }])
    g.chrome.tabs.reload()
    expect(host.calls[2].args).toEqual([undefined, undefined])
    expect(() => g.chrome.tabs.get('nope')).toThrow(/No matching signature/)
  })

  it('event objects register with the host once and dispatch pushed events', () => {
    installExtensionApi(host, API_SPEC)
    const ev = g.chrome.tabs.onUpdated
    const a = vi.fn()
    const b = vi.fn()
    expect(ev.hasListeners()).toBe(false)
    ev.addListener(a)
    ev.addListener(b)
    expect(ev.hasListener(a)).toBe(true)
    expect(host.notifications.filter((n) => n.kind === 'listen')).toEqual([
      { kind: 'listen', payload: { event: 'tabs.onUpdated' } }
    ])
    host.push('tabs', 'onUpdated', 5, { status: 'complete' }, { id: 5 })
    expect(a).toHaveBeenCalledWith(5, { status: 'complete' }, { id: 5 })
    expect(b).toHaveBeenCalledTimes(1)
    ev.removeListener(a)
    ev.removeListener(b)
    expect(host.notifications.filter((n) => n.kind === 'unlisten')).toHaveLength(1)
    expect(ev.hasListeners()).toBe(false)
    expect(typeof ev.addRules).toBe('function')
  })

  it('queues events that arrive before the first listener (worker start-up)', () => {
    installExtensionApi(host, API_SPEC)
    host.push('runtime', 'onInstalled', { reason: 'install' })
    const fn = vi.fn()
    g.chrome.runtime.onInstalled.addListener(fn)
    expect(fn).toHaveBeenCalledWith({ reason: 'install' })
    const later = vi.fn()
    g.chrome.runtime.onInstalled.addListener(later)
    expect(later).not.toHaveBeenCalled()
  })

  it('delivers action events to browserAction listeners as well', () => {
    installNativeGlobals(2)
    installExtensionApi(host, API_SPEC)
    const fn = vi.fn()
    g.chrome.browserAction.onClicked.addListener(fn)
    host.push('action', 'onClicked', { id: 1 })
    expect(fn).toHaveBeenCalledWith({ id: 1 })
  })

  it('wraps native storage.local writes to notify the host with Chrome change records', async () => {
    installExtensionApi(host, API_SPEC)
    await g.chrome.storage.local.set({ a: 1, b: 'x' })
    await g.chrome.storage.local.set({ a: 2, b: 'x' })
    await g.chrome.storage.local.remove('b')
    await g.chrome.storage.local.clear()
    const changes = host.notifications
      .filter((n) => n.kind === 'storage-changed')
      .map((n) => n.payload)
    expect(changes).toEqual([
      { area: 'local', changes: { a: { newValue: 1 }, b: { newValue: 'x' } } },
      { area: 'local', changes: { a: { oldValue: 1, newValue: 2 } } },
      { area: 'local', changes: { b: { oldValue: 'x' } } },
      { area: 'local', changes: { a: { oldValue: 2 } } }
    ])
    expect(g.chrome.storage.local.QUOTA_BYTES).toBeUndefined()
    const got = await new Promise((resolve) => g.chrome.storage.local.get(null, resolve))
    expect(got).toEqual({})
  })

  it('routes storage.sync and storage.managed through the host', async () => {
    installExtensionApi(host, API_SPEC)
    host.respond = (_ns, method) =>
      method === 'get' ? { ok: true, value: { k: 1 } } : { ok: true, value: undefined }
    expect(await g.chrome.storage.sync.get('k')).toEqual({ k: 1 })
    await g.chrome.storage.sync.set({ k: 2 })
    expect(host.calls.map((c) => [c.namespace, c.method, c.args])).toEqual([
      ['storage', 'get', ['sync', 'k']],
      ['storage', 'set', ['sync', { k: 2 }]]
    ])
    expect(g.chrome.storage.sync.QUOTA_BYTES).toBe(102400)
    expect(g.chrome.storage.sync.MAX_ITEMS).toBe(512)
    expect(g.browser.storage.managed).toBe(g.chrome.storage.managed)
    const fn = vi.fn()
    g.chrome.storage.onChanged.addListener(fn)
    const syncFn = vi.fn()
    g.chrome.storage.sync.onChanged.addListener(syncFn)
    host.push('storage', 'onChanged', { k: { newValue: 3 } }, 'sync')
    host.push('storage.sync', 'onChanged', { k: { newValue: 3 } })
    expect(fn).toHaveBeenCalledWith({ k: { newValue: 3 } }, 'sync')
    expect(syncFn).toHaveBeenCalledWith({ k: { newValue: 3 } })
  })

  it('aliases the legacy extension namespace onto runtime', () => {
    installExtensionApi(host, API_SPEC)
    expect(g.chrome.extension.getURL('x.html')).toBe(
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html'
    )
    expect(g.chrome.extension.inIncognitoContext).toBe(false)
    expect(g.chrome.extension.onRequest).toBe(g.chrome.runtime.onMessage)
    g.chrome.extension.sendRequest({ ping: 1 })
    expect(g.chrome.runtime.sendMessage).toHaveBeenCalledWith({ ping: 1 })
    expect(g.chrome.extension.ViewType.POPUP).toBe('popup')
    // Workers have no views of their own.
    expect(g.chrome.extension.getViews).toBeUndefined()
  })

  it('serialises ImageData for action.setIcon', () => {
    installExtensionApi(host, API_SPEC)
    const data = new Uint8ClampedArray([1, 2, 3, 4])
    g.chrome.action.setIcon({ imageData: { width: 1, height: 1, data, extra: true } })
    expect(host.calls[0].args[0]).toEqual({ imageData: { width: 1, height: 1, data } })
  })

  it('resolves action.setIcon paths against the calling context, as Chrome does', () => {
    Object.defineProperty(g, 'location', {
      value: { href: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background/index.js' },
      configurable: true,
      writable: true
    })
    try {
      installExtensionApi(host, API_SPEC)
      g.chrome.action.setIcon({ path: { 19: '../icons/a19.png', 38: '/icons/a38.png' } })
      g.chrome.action.setIcon({ path: 'x.png' })
      expect(host.calls[0].args[0]).toEqual({
        path: {
          19: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/icons/a19.png',
          38: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/icons/a38.png'
        }
      })
      expect(host.calls[1].args[0]).toEqual({
        path: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background/x.png'
      })
    } finally {
      delete g.location
    }
  })
})

describe('installExtensionApi in frames', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    delete g.location
  })

  it('reports getViews from the host list and identifies the background page', () => {
    installNativeGlobals(2)
    g.chrome.runtime.getManifest = () => ({
      manifest_version: 2,
      name: 'Legacy',
      version: '1',
      background: { scripts: ['bg.js'] }
    })
    Object.defineProperty(g, 'location', {
      value: {
        href: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/_generated_background_page.html',
        protocol: 'chrome-extension:',
        host: 'abcdefghijklmnopabcdefghijklmnop'
      },
      configurable: true,
      writable: true
    })
    const host = fakeHost('frame')
    installExtensionApi(host, API_SPEC)
    const hello = host.notifications.find((n) => n.kind === 'hello')?.payload as Any
    expect(hello.isBackgroundPage).toBe(true)
    expect(g.chrome.extension.getBackgroundPage()).toBe(g)
    host.push('__zen', 'views', [
      { url: g.location.href, type: 'background', self: true },
      { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', type: 'popup' }
    ])
    const views = g.chrome.extension.getViews()
    expect(views).toHaveLength(2)
    expect(views[0]).toBe(g)
    expect(views[1].location.href).toContain('popup.html')
    expect(g.chrome.extension.getViews({ type: 'popup' })).toHaveLength(1)
  })
})

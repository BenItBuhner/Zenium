import { describe, expect, it } from 'vitest'
import {
  createEmulatedEngine,
  type EmulatedEngine,
  type EngineConfig,
  type Primordials
} from '../api/engine'

const EXT = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
const ORIGIN = `https://${EXT}.ext.zenium.invalid`

const primordials: Primordials = {
  stringify: JSON.stringify,
  parse: JSON.parse,
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  queueMicrotask: (cb) => queueMicrotask(cb),
  error: () => undefined
}

type Ns = Record<string, unknown>
type Fn = (...args: unknown[]) => unknown
type Listenable = { addListener(l: Fn): void; hasListeners(): boolean }

interface Harness {
  engine: EmulatedEngine
  chrome: Record<string, Ns>
  root: Record<string, unknown>
  sent: Record<string, unknown>[]
  last(): Record<string, unknown>
  reply(id: unknown, result: unknown): void
  fail(id: unknown, error: string): void
}

function harness(over: Partial<EngineConfig> = {}): Harness {
  const sent: Record<string, unknown>[] = []
  const root: Record<string, unknown> = {}
  const config: EngineConfig = {
    id: EXT,
    origin: ORIGIN,
    manifest: { manifest_version: 3, name: 'x', version: '1' },
    manifestVersion: 3,
    permissions: ['storage', 'tabs', 'alarms', 'scripting'],
    messages: { hello: { message: 'Hallo $1' } },
    uiLanguage: 'de',
    context: 'background',
    token: 'tok',
    endpointId: 'ep1',
    url: `${ORIGIN}/_generated_background_page.html`,
    isTopFrame: true,
    ...over
  }
  const engine = createEmulatedEngine(
    config,
    { post: (m) => void sent.push(JSON.parse(m) as Record<string, unknown>) },
    primordials,
    { root }
  )
  return {
    engine,
    chrome: engine.chrome as Record<string, Ns>,
    root,
    sent,
    last: () => sent[sent.length - 1],
    reply: (id, result) => engine.receive({ t: 'reply', id, ok: true, result }),
    fail: (id, error) => engine.receive({ t: 'reply', id, ok: false, error })
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createEmulatedEngine', () => {
  it('says hello with the token and endpoint and exposes the granted namespaces only', () => {
    const h = harness()
    expect(h.sent[0]).toEqual({
      t: 'hello',
      ctx: 'background',
      ext: EXT,
      url: `${ORIGIN}/_generated_background_page.html`,
      top: true,
      token: 'tok',
      ep: 'ep1'
    })
    const names = Object.keys(h.chrome)
    for (const ns of [
      'alarms',
      'extension',
      'i18n',
      'runtime',
      'scripting',
      'storage',
      'tabs',
      'windows',
      'action',
      'permissions',
      'management'
    ])
      expect(names).toContain(ns)
    // Permission-gated namespaces stay hidden until granted; MV2-only ones never appear in MV3.
    for (const ns of [
      'cookies',
      'history',
      'bookmarks',
      'declarativeNetRequest',
      'webRequest',
      'notifications',
      'browserAction',
      'pageAction'
    ])
      expect(names).not.toContain(ns)
    expect(h.root.chrome).toBe(h.chrome)
    expect(h.root.browser).toBe(h.chrome)
    expect(h.chrome.runtime.id).toBe(EXT)
    expect((h.chrome.runtime.getURL as Fn)('popup.html')).toBe(`${ORIGIN}/popup.html`)
    expect((h.chrome.runtime.getURL as Fn)('/popup.html')).toBe(`${ORIGIN}/popup.html`)
    expect((h.chrome.extension.getURL as Fn)('a.png')).toBe(`${ORIGIN}/a.png`)
    expect((h.chrome.i18n.getMessage as Fn)('hello', 'Ada')).toBe('Hallo Ada')
    expect((h.chrome.i18n.getUILanguage as Fn)()).toBe('de')
    expect(h.engine.diagnostics).toMatchObject({ installed: true, browserAliased: true })
  })

  it('content scripts only see the content-script namespaces', () => {
    const h = harness({ context: 'content' })
    expect(Object.keys(h.chrome).sort()).toEqual(['dom', 'extension', 'i18n', 'runtime', 'storage'])
  })

  it('hides storage without the permission and browserAction/pageAction outside MV2', () => {
    const h = harness({ permissions: [] })
    expect(h.chrome.storage).toBeUndefined()
    const mv2 = harness({
      manifest: { manifest_version: 2, name: 'x', version: '1' },
      manifestVersion: 2
    })
    expect(Object.keys(mv2.chrome)).toContain('browserAction')
    expect(Object.keys(mv2.chrome)).toContain('pageAction')
    expect(Object.keys(mv2.chrome)).not.toContain('action')
  })

  it('supports promises and callbacks with runtime.lastError on routed methods', async () => {
    const h = harness()
    const promise = (h.chrome.tabs.query as Fn)({ active: true }) as Promise<unknown>
    const call = h.last()
    expect(call).toMatchObject({ t: 'call', ns: 'tabs', method: 'query', args: [{ active: true }] })
    h.reply(call.id, [{ id: 1 }])
    await expect(promise).resolves.toEqual([{ id: 1 }])

    let seen: unknown = 'unset'
    let lastError: unknown = 'unset'
    ;(h.chrome.tabs.get as Fn)(4, (tab: unknown) => {
      seen = tab
      lastError = h.chrome.runtime.lastError
    })
    h.fail(h.last().id, 'No tab with id: 4.')
    await flush()
    expect(seen).toBeUndefined()
    expect(lastError).toEqual({ message: 'No tab with id: 4.' })
    expect(h.chrome.runtime.lastError).toBeUndefined()
    expect('lastError' in h.chrome.runtime).toBe(false)
  })

  it('validates signatures the way Chrome does and normalises optional leading arguments', () => {
    const mv2 = harness({
      manifest: { manifest_version: 2, name: 'x', version: '1' },
      manifestVersion: 2
    })
    void (mv2.chrome.tabs.executeScript as Fn)({ code: '1' })
    expect(mv2.last()).toMatchObject({
      t: 'call',
      ns: 'tabs',
      method: 'executeScript',
      args: [null, { code: '1' }]
    })
    void (mv2.chrome.tabs.insertCSS as Fn)(7, { code: 'a{}' })
    expect(mv2.last()).toMatchObject({ method: 'insertCSS', args: [7, { code: 'a{}' }] })
    expect(() => (mv2.chrome.tabs.get as Fn)('not a number')).toThrow(/No matching signature/)
  })

  it('routes stubbed members to the host so the rejection carries the member name', async () => {
    const h = harness({ permissions: ['tabCapture'] })
    const promise = (h.chrome.tabCapture.capture as Fn)({}) as Promise<unknown>
    expect(h.last()).toMatchObject({ t: 'call', ns: 'tabCapture', method: 'capture' })
    h.fail(h.last().id, 'chrome.tabCapture.capture is not implemented on Zenium for Android')
    await expect(promise).rejects.toThrow(/not implemented on Zenium for Android/)
  })

  it('answers no-ops and stub results on the context side without a host round trip', async () => {
    const h = harness({ permissions: ['fontSettings'] })
    const before = h.sent.length
    await expect(
      (h.chrome.runtime.setUninstallURL as Fn)('https://example.org/bye') as Promise<unknown>
    ).resolves.toBeUndefined()
    await expect((h.chrome.fontSettings.getFontList as Fn)() as Promise<unknown>).resolves.toEqual(
      []
    )
    expect(h.sent.length).toBe(before)
  })

  it('routes every storage area to the host with the area as the first argument', () => {
    const h = harness()
    void (h.chrome.storage.sync as Ns & { get: Fn }).get({ theme: 'light', size: 1 })
    expect(h.last()).toMatchObject({
      t: 'call',
      ns: 'storage',
      method: 'get',
      args: ['sync', { theme: 'light', size: 1 }]
    })
    void (h.chrome.storage.local as Ns & { set: Fn }).set({ a: 1 })
    expect(h.last()).toMatchObject({ ns: 'storage', method: 'set', args: ['local', { a: 1 }] })
    void (h.chrome.storage.local as Ns & { remove: Fn }).remove('a')
    expect(h.last()).toMatchObject({ method: 'remove', args: ['local', 'a'] })
    void (h.chrome.storage.session as Ns & { clear: Fn }).clear()
    expect(h.last()).toMatchObject({ method: 'clear', args: ['session'] })
    expect((h.chrome.storage.sync as Ns).QUOTA_BYTES).toBe(102400)
    expect((h.chrome.storage.local as Ns).QUOTA_BYTES).toBe(10485760)
  })

  it('routes runtime.sendMessage through the host and answers delivered messages', async () => {
    const h = harness()
    const promise = (h.chrome.runtime.sendMessage as Fn)({ type: 'ping' }) as Promise<unknown>
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { extensionId: null, options: null },
      data: { type: 'ping' }
    })
    h.reply(h.last().id, { pong: 1 })
    await expect(promise).resolves.toEqual({ pong: 1 })

    // No listener yet: the host learns nobody listens.
    h.engine.receive({ t: 'deliver', id: 9, data: 'x', sender: { id: EXT } })
    expect(h.last()).toEqual({
      t: 'msgReply',
      id: 9,
      handled: false,
      listeners: false,
      token: 'tok',
      ep: 'ep1'
    })

    const onMessage = h.chrome.runtime.onMessage as Listenable
    onMessage.addListener((message, _sender, sendResponse) => {
      if (message === 'sync') (sendResponse as Fn)('now')
      if (message === 'async') {
        setTimeout(() => (sendResponse as Fn)('later'), 0)
        return true
      }
      if (message === 'promise') return Promise.resolve('resolved')
      return undefined
    })
    expect(
      h.sent.some((m) => m.t === 'listen' && m.event === 'runtime.onMessage' && m.on === true)
    ).toBe(true)

    h.engine.receive({ t: 'deliver', id: 10, data: 'sync', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 10, handled: true, response: 'now' })
    h.engine.receive({ t: 'deliver', id: 11, data: 'async', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 11, handled: true, willRespond: true })
    await flush()
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 11, handled: true, response: 'later' })
    h.engine.receive({ t: 'deliver', id: 12, data: 'silent', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 12, handled: false, listeners: true })
    h.engine.receive({ t: 'deliver', id: 13, data: 'promise', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 13, handled: true, willRespond: true })
    await flush()
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 13, handled: true, response: 'resolved' })
  })

  it('sendMessage with a callback reports failures through runtime.lastError', async () => {
    const h = harness()
    let lastError: unknown = 'unset'
    ;(h.chrome.runtime.sendMessage as Fn)('hi', () => {
      lastError = h.chrome.runtime.lastError
    })
    h.fail(h.last().id, 'Could not establish connection. Receiving end does not exist.')
    await flush()
    expect(lastError).toEqual({
      message: 'Could not establish connection. Receiving end does not exist.'
    })
    expect(h.chrome.runtime.lastError).toBeUndefined()
  })

  it('tabs.sendMessage carries the tab id, and the extension id form is parsed', () => {
    const h = harness()
    void (h.chrome.tabs.sendMessage as Fn)(3, 'hi', { frameId: 0 })
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { tabId: 3, options: { frameId: 0 } },
      data: 'hi'
    })
    void (h.chrome.runtime.sendMessage as Fn)('b'.repeat(32), 'hi')
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { extensionId: 'b'.repeat(32) },
      data: 'hi'
    })
  })

  it('ports: connect, message, disconnect on both sides', () => {
    const h = harness()
    const port = (h.chrome.runtime.connect as Fn)({ name: 'chan' }) as Record<string, unknown>
    const connect = h.last()
    expect(connect).toMatchObject({ t: 'connect', name: 'chan', target: { extensionId: null } })
    const portId = connect.portId
    ;(port.postMessage as Fn)({ n: 1 })
    expect(h.last()).toMatchObject({ t: 'portMsg', portId, data: { n: 1 } })
    const received: unknown[] = []
    ;(port.onMessage as Listenable).addListener((m) => received.push(m))
    h.engine.receive({ t: 'portMsg', portId, data: 'back' })
    expect(received).toEqual(['back'])
    let disconnected = false
    let lastError: unknown = 'unset'
    ;(port.onDisconnect as Listenable).addListener(() => {
      disconnected = true
      lastError = h.chrome.runtime.lastError
    })
    h.engine.receive({ t: 'portDisconnect', portId })
    expect(disconnected).toBe(true)
    expect(lastError).toBeUndefined()
    expect(() => (port.postMessage as Fn)('x')).toThrow(/disconnected port/)

    // A refused connection disconnects with runtime.lastError set during the listener.
    const refused = (h.chrome.runtime.connect as Fn)() as Record<string, unknown>
    const refusedId = h.last().portId
    ;(refused.onDisconnect as Listenable).addListener(() => {
      lastError = h.chrome.runtime.lastError
    })
    h.engine.receive({ t: 'portAccept', portId: refusedId, accept: false })
    expect(lastError).toEqual({
      message: 'Could not establish connection. Receiving end does not exist.'
    })

    // Incoming connection: refused without onConnect listeners, accepted with.
    h.engine.receive({ t: 'portConnect', portId: 'r:1', name: 'x', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'portAccept', portId: 'r:1', accept: false })
    let incoming: Record<string, unknown> | null = null
    ;(h.chrome.runtime.onConnect as Listenable).addListener(
      (p) => (incoming = p as Record<string, unknown>)
    )
    h.engine.receive({ t: 'portConnect', portId: 'r:2', name: 'x', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'portAccept', portId: 'r:2', accept: true })
    expect(incoming).not.toBeNull()
    expect((incoming as unknown as Record<string, unknown>).name).toBe('x')
  })

  it('dispatches host events, including storage.<area>.onChanged mirrors and action aliases', () => {
    const h = harness()
    const seen: unknown[] = []
    ;(h.chrome.storage.onChanged as Listenable).addListener((changes, area) =>
      seen.push(['all', changes, area])
    )
    ;((h.chrome.storage.local as Ns).onChanged as Listenable).addListener((changes) =>
      seen.push(['local', changes])
    )
    h.engine.receive({
      t: 'event',
      ns: 'storage',
      name: 'onChanged',
      args: [{ a: { newValue: 1 } }, 'local']
    })
    expect(seen).toEqual([
      ['all', { a: { newValue: 1 } }, 'local'],
      ['local', { a: { newValue: 1 } }]
    ])
    expect(
      h.sent.some((m) => m.t === 'listen' && m.event === 'storage.local.onChanged' && m.on)
    ).toBe(true)

    const mv2 = harness({
      manifest: { manifest_version: 2, name: 'x', version: '1' },
      manifestVersion: 2
    })
    const clicks: unknown[] = []
    ;(mv2.chrome.browserAction.onClicked as Listenable).addListener((tab) => clicks.push(tab))
    mv2.engine.receive({ t: 'event', ns: 'action', name: 'onClicked', args: [{ id: 1 }] })
    expect(clicks).toEqual([{ id: 1 }])
  })

  it('queues an event pushed before any listener exists and replays it on addListener', () => {
    const h = harness()
    h.engine.receive({
      t: 'event',
      ns: 'runtime',
      name: 'onInstalled',
      args: [{ reason: 'install' }]
    })
    const seen: unknown[] = []
    ;(h.chrome.runtime.onInstalled as Listenable).addListener((d) => seen.push(d))
    expect(seen).toEqual([{ reason: 'install' }])
  })

  it('serialises scripting.executeScript functions as source', () => {
    const h = harness()
    void (h.chrome.scripting.executeScript as Fn)({
      target: { tabId: 1 },
      func: (a: number) => a + 1,
      args: [1]
    })
    const call = h.last()
    expect(call).toMatchObject({ ns: 'scripting', method: 'executeScript' })
    const [injection] = call.args as Record<string, unknown>[]
    expect(injection.func).toBeUndefined()
    expect(String(injection.funcSource)).toContain('a + 1')
    expect(injection.args).toEqual([1])
  })

  it('contextMenus.create returns the id synchronously and routes the creation', async () => {
    const h = harness({ permissions: ['contextMenus'] })
    const id = (h.chrome.contextMenus.create as Fn)({ title: 'Hi', contexts: ['page'] })
    expect(id).toBe(1)
    expect(h.last()).toMatchObject({
      t: 'call',
      ns: 'contextMenus',
      method: 'create',
      args: [{ title: 'Hi', contexts: ['page'] }, 1]
    })
    expect((h.chrome.contextMenus.create as Fn)({ id: 'own', title: 'x' })).toBe('own')
    let called = false
    ;(h.chrome.contextMenus.create as Fn)({ title: 'y' }, () => (called = true))
    h.reply(h.last().id, null)
    await flush()
    expect(called).toBe(true)
    void (h.chrome.contextMenus.removeAll as Fn)()
    expect(h.last()).toMatchObject({ ns: 'contextMenus', method: 'removeAll' })
  })

  it('user-script contexts get messaging only, flagged for onUserScriptMessage', () => {
    const h = harness({ context: 'userScript' })
    expect(Object.keys(h.chrome)).toEqual(['runtime'])
    expect(Object.keys(h.chrome.runtime).sort()).toEqual(['connect', 'id', 'sendMessage'])
    void (h.chrome.runtime.sendMessage as Fn)('hi')
    expect(h.last()).toMatchObject({ t: 'msg', data: 'hi', userScript: true })
    void (h.chrome.runtime.connect as Fn)({ name: 'p' })
    expect(h.last()).toMatchObject({ t: 'connect', name: 'p', userScript: true })
    expect(h.engine.diagnostics).toBeNull()

    const bg = harness()
    const plain: unknown[] = []
    const fromUserScripts: unknown[] = []
    ;(bg.chrome.runtime.onMessage as Listenable).addListener((m) => plain.push(m))
    ;(bg.chrome.runtime.onUserScriptMessage as Listenable).addListener((m) =>
      fromUserScripts.push(m)
    )
    bg.engine.receive({ t: 'deliver', id: 1, data: 'u', sender: { id: EXT }, userScript: true })
    bg.engine.receive({ t: 'deliver', id: 2, data: 'c', sender: { id: EXT } })
    expect(plain).toEqual(['c'])
    expect(fromUserScripts).toEqual(['u'])
  })

  it('exposes engine-side helpers: platform info, privacy settings, identity redirect', async () => {
    const h = harness({ permissions: ['privacy', 'identity', 'idle'] })
    await expect((h.chrome.runtime.getPlatformInfo as Fn)() as Promise<unknown>).resolves.toEqual({
      os: 'android',
      arch: 'arm64',
      nacl_arch: 'arm'
    })
    const websites = (h.chrome.privacy.websites as Ns).hyperlinkAuditingEnabled as Ns & { get: Fn }
    await expect(websites.get({}) as Promise<unknown>).resolves.toEqual({
      value: false,
      levelOfControl: 'not_controllable'
    })
    expect((h.chrome.identity.getRedirectURL as Fn)('cb')).toBe(`${ORIGIN}/_zenium/identity/cb`)
    expect((h.chrome.idle.setDetectionInterval as Fn)(60)).toBeUndefined()
    expect(h.chrome.runtime.OnInstalledReason).toEqual({
      INSTALL: 'install',
      UPDATE: 'update',
      CHROME_UPDATE: 'chrome_update',
      SHARED_MODULE_UPDATE: 'shared_module_update'
    })
  })

  it('ready and raw posts carry the token and endpoint', () => {
    const h = harness({ context: 'popup', url: `${ORIGIN}/popup.html` })
    h.engine.ready()
    expect(h.last()).toEqual({ t: 'ready', token: 'tok', ep: 'ep1' })
    h.engine.post({ t: 'popupSize', width: 320, height: 200 })
    expect(h.last()).toEqual({ t: 'popupSize', width: 320, height: 200, token: 'tok', ep: 'ep1' })
  })
})

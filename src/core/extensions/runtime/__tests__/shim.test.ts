import { describe, expect, it } from 'vitest'
import { createChromeShim, type ChromeShim, type Primordials, type ShimConfig } from '../shim'

const EXT = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

const primordials: Primordials = {
  stringify: JSON.stringify,
  parse: JSON.parse,
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  queueMicrotask: (cb) => queueMicrotask(cb),
  error: () => undefined
}

interface Harness {
  shim: ChromeShim
  chrome: Record<string, Record<string, unknown>>
  sent: Record<string, unknown>[]
  last(): Record<string, unknown>
  reply(id: unknown, result: unknown): void
  fail(id: unknown, error: string): void
}

function harness(over: Partial<ShimConfig> = {}): Harness {
  const sent: Record<string, unknown>[] = []
  const config: ShimConfig = {
    id: EXT,
    manifest: { manifest_version: 3, name: 'x', version: '1' },
    manifestVersion: 3,
    permissions: ['storage', 'tabs', 'alarms', 'scripting'],
    messages: { hello: { message: 'Hallo $1' } },
    uiLanguage: 'de',
    context: 'background',
    token: 'tok',
    endpointId: 'ep1',
    url: `https://${EXT}.ext.zenium.invalid/bg.html`,
    isTopFrame: true,
    ...over
  }
  const shim = createChromeShim(
    config,
    { post: (m) => void sent.push(JSON.parse(m) as Record<string, unknown>) },
    primordials
  )
  return {
    shim,
    chrome: shim.chrome as Record<string, Record<string, unknown>>,
    sent,
    last: () => sent[sent.length - 1],
    reply: (id, result) => shim.receive({ t: 'reply', id, ok: true, result }),
    fail: (id, error) => shim.receive({ t: 'reply', id, ok: false, error })
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createChromeShim', () => {
  it('says hello with the token and endpoint, and exposes the granted namespaces only', () => {
    const h = harness()
    expect(h.sent[0]).toEqual({
      t: 'hello',
      ctx: 'background',
      ext: EXT,
      url: `https://${EXT}.ext.zenium.invalid/bg.html`,
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
      'action'
    ])
      expect(names).toContain(ns)
    // Permission-gated namespaces stay hidden until granted.
    for (const ns of [
      'cookies',
      'history',
      'bookmarks',
      'declarativeNetRequest',
      'webRequest',
      'notifications'
    ])
      expect(names).not.toContain(ns)
    expect(h.chrome.runtime.id).toBe(EXT)
    expect((h.chrome.runtime.getURL as (p: string) => string)('popup.html')).toBe(
      `https://${EXT}.ext.zenium.invalid/popup.html`
    )
    expect((h.chrome.i18n.getMessage as (n: string, s?: unknown) => string)('hello', 'Ada')).toBe(
      'Hallo Ada'
    )
    expect((h.chrome.i18n.getUILanguage as () => string)()).toBe('de')
  })

  it('content scripts only see the content-script namespaces', () => {
    const h = harness({ context: 'content' })
    expect(Object.keys(h.chrome).sort()).toEqual(['dom', 'extension', 'i18n', 'runtime', 'storage'])
  })

  it('supports promises and callbacks with runtime.lastError', async () => {
    const h = harness()
    const promise = (h.chrome.tabs.query as (q: unknown) => Promise<unknown>)({ active: true })
    const call = h.last()
    expect(call).toMatchObject({ t: 'call', ns: 'tabs', method: 'query', args: [{ active: true }] })
    h.reply(call.id, [{ id: 1 }])
    await expect(promise).resolves.toEqual([{ id: 1 }])

    let seen: unknown = 'unset'
    let lastError: unknown = 'unset'
    ;(h.chrome.tabs.get as (id: number, cb: (t: unknown) => void) => void)(4, (tab) => {
      seen = tab
      lastError = h.chrome.runtime.lastError
    })
    h.fail(h.last().id, 'No tab with id: 4.')
    await flush()
    expect(seen).toBeUndefined()
    expect(lastError).toEqual({ message: 'No tab with id: 4.' })
    expect(h.chrome.runtime.lastError).toBeUndefined()
  })

  it('stubs unimplemented members with a clear error', async () => {
    const h = harness({ permissions: ['tabCapture'] })
    await expect(
      (h.chrome.tabCapture.capture as (o: unknown) => Promise<unknown>)({})
    ).rejects.toThrow(/not implemented on Zenium for Android/)
  })

  it('storage.get merges defaults and maps sync onto the host storage call', async () => {
    const h = harness()
    const promise = (h.chrome.storage.sync as Record<string, (k: unknown) => Promise<unknown>>).get(
      { theme: 'light', size: 1 }
    )
    expect(h.last()).toMatchObject({
      t: 'call',
      ns: 'storage',
      method: 'get',
      args: ['sync', ['theme', 'size']]
    })
    h.reply(h.last().id, { theme: 'dark' })
    await expect(promise).resolves.toEqual({ theme: 'dark', size: 1 })
    void (h.chrome.storage.local as Record<string, (k: unknown) => Promise<unknown>>).set({ a: 1 })
    expect(h.last()).toMatchObject({ ns: 'storage', method: 'set', args: ['local', { a: 1 }] })
    void (h.chrome.storage.local as Record<string, (k: unknown) => Promise<unknown>>).remove('a')
    expect(h.last()).toMatchObject({ method: 'remove', args: ['local', ['a']] })
  })

  it('routes runtime.sendMessage through the host and answers delivered messages', async () => {
    const h = harness()
    const promise = (h.chrome.runtime.sendMessage as (m: unknown) => Promise<unknown>)({
      type: 'ping'
    })
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { extensionId: null, options: null },
      data: { type: 'ping' }
    })
    h.reply(h.last().id, { pong: 1 })
    await expect(promise).resolves.toEqual({ pong: 1 })

    // No listener yet: the host learns nobody listens.
    h.shim.receive({ t: 'deliver', id: 9, data: 'x', sender: { id: EXT } })
    expect(h.last()).toEqual({
      t: 'msgReply',
      id: 9,
      handled: false,
      listeners: false,
      token: 'tok',
      ep: 'ep1'
    })

    const onMessage = h.chrome.runtime.onMessage as {
      addListener(l: (...a: unknown[]) => unknown): void
    }
    onMessage.addListener((message, _sender, sendResponse) => {
      if (message === 'sync') (sendResponse as (v: unknown) => void)('now')
      if (message === 'async') {
        setTimeout(() => (sendResponse as (v: unknown) => void)('later'), 0)
        return true
      }
      return undefined
    })
    expect(
      h.sent.some(
        (m) => m.t === 'listen' && m.ns === 'runtime' && m.name === 'onMessage' && m.on === true
      )
    ).toBe(true)

    h.shim.receive({ t: 'deliver', id: 10, data: 'sync', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 10, handled: true, response: 'now' })
    h.shim.receive({ t: 'deliver', id: 11, data: 'async', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 11, handled: true, willRespond: true })
    await flush()
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 11, handled: true, response: 'later' })
    h.shim.receive({ t: 'deliver', id: 12, data: 'silent', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'msgReply', id: 12, handled: false, listeners: true })
  })

  it('tabs.sendMessage carries the tab id, and the extension id form is parsed', () => {
    const h = harness()
    void (h.chrome.tabs.sendMessage as (id: number, m: unknown, o?: unknown) => Promise<unknown>)(
      3,
      'hi',
      { frameId: 0 }
    )
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { tabId: 3, options: { frameId: 0 } },
      data: 'hi'
    })
    void (h.chrome.runtime.sendMessage as (id: string, m: unknown) => Promise<unknown>)(
      'b'.repeat(32),
      'hi'
    )
    expect(h.last()).toMatchObject({
      t: 'msg',
      target: { extensionId: 'b'.repeat(32) },
      data: 'hi'
    })
  })

  it('ports: connect, message, disconnect on both sides', () => {
    const h = harness()
    const port = (h.chrome.runtime.connect as (info: unknown) => Record<string, unknown>)({
      name: 'chan'
    })
    const connect = h.last()
    expect(connect).toMatchObject({ t: 'connect', name: 'chan', target: { extensionId: null } })
    const portId = connect.portId
    ;(port.postMessage as (m: unknown) => void)({ n: 1 })
    expect(h.last()).toMatchObject({ t: 'portMsg', portId, data: { n: 1 } })
    const received: unknown[] = []
    ;(port.onMessage as { addListener(l: (m: unknown) => void): void }).addListener((m) =>
      received.push(m)
    )
    h.shim.receive({ t: 'portMsg', portId, data: 'back' })
    expect(received).toEqual(['back'])
    let disconnected = false
    ;(port.onDisconnect as { addListener(l: () => void): void }).addListener(
      () => (disconnected = true)
    )
    h.shim.receive({ t: 'portDisconnect', portId })
    expect(disconnected).toBe(true)
    expect(() => (port.postMessage as (m: unknown) => void)('x')).toThrow(/disconnected port/)

    // Incoming connection: refused without onConnect listeners, accepted with.
    h.shim.receive({ t: 'portConnect', portId: 'r:1', name: 'x', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'portAccept', portId: 'r:1', accept: false })
    let incoming: Record<string, unknown> | null = null
    ;(
      h.chrome.runtime.onConnect as { addListener(l: (p: Record<string, unknown>) => void): void }
    ).addListener((p) => (incoming = p))
    h.shim.receive({ t: 'portConnect', portId: 'r:2', name: 'x', sender: { id: EXT } })
    expect(h.last()).toMatchObject({ t: 'portAccept', portId: 'r:2', accept: true })
    expect(incoming).not.toBeNull()
    expect((incoming as unknown as Record<string, unknown>).name).toBe('x')
  })

  it('dispatches host events, including storage.<area>.onChanged mirrors', () => {
    const h = harness()
    const seen: unknown[] = []
    ;(
      h.chrome.storage.onChanged as { addListener(l: (...a: unknown[]) => void): void }
    ).addListener((changes, area) => seen.push(['all', changes, area]))
    ;(
      (h.chrome.storage.local as Record<string, unknown>).onChanged as {
        addListener(l: (...a: unknown[]) => void): void
      }
    ).addListener((changes) => seen.push(['local', changes]))
    h.shim.receive({
      t: 'event',
      ns: 'storage',
      name: 'onChanged',
      args: [{ a: { newValue: 1 } }, 'local']
    })
    expect(seen).toEqual([
      ['all', { a: { newValue: 1 } }, 'local'],
      ['local', { a: { newValue: 1 } }]
    ])
  })

  it('serialises scripting.executeScript functions as source', () => {
    const h = harness()
    void (h.chrome.scripting.executeScript as (i: unknown) => Promise<unknown>)({
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
})

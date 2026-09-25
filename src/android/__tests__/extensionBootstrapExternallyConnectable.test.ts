// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * `externally_connectable`: the page's own `chrome.runtime` in the copy of the bootstrap that
 * runs a connectable extension's main-world unit. Speak Subtitles for YouTube declares
 * `externally_connectable.matches: ["https://www.youtube.com/*"]` and its `world: "MAIN"`
 * content scripts reach the worker through `chrome.runtime.sendMessage(<its id>, …)` on the
 * page's `chrome` – which a WebView's page does not have. The page gets Chrome's two functions
 * and `lastError`, nothing else of the extension's; each connectable extension gets an engine
 * of its own behind them, marked external, so the extension hears the page on
 * `onMessageExternal` / `onConnectExternal`. One boot per test file (the bootstrap is an IIFE
 * over `__zenExtBoot`); happy-dom's document is `http://localhost:3000/`.
 */

type GroupFunction = (
  window: unknown,
  self: unknown,
  globalThis: unknown,
  chrome: unknown,
  browser: unknown
) => unknown

interface Boot {
  config: ContentBootConfig
  sources: Record<string, GroupFunction>
  css: Record<string, string>
  debug?: boolean
}

type Exec = (
  token: unknown,
  extId: unknown,
  kind: unknown,
  payload: unknown,
  fn: unknown
) => unknown

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

interface PageRuntime {
  sendMessage: (...args: unknown[]) => unknown
  connect: (...args: unknown[]) => Port
  lastError?: { message: string }
}

interface Port {
  name: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(l: (message: unknown) => void): void }
  onDisconnect: { addListener(l: () => void): void }
}

const TOKEN = 'externally-connectable-token'
/** Not connectable: a `world: "MAIN"` script over every page (Mobile simulator's spoofer). */
const SPOOFER = 'm'.repeat(32)
/** Connectable from this document (Speak Subtitles' shape; ids spell a-p). */
const SPEAK = 'p'.repeat(32)
/** Connectable from this document too: shares the page's `chrome.runtime`. */
const OTHER = 'o'.repeat(32)
/** Connectable from www.youtube.com alone: nothing here. */
const ELSEWHERE = 'e'.repeat(32)
const ABSENT = 'a'.repeat(32)

const mainGroup = (js: string): BootGroup => ({
  index: 0,
  runAt: 'document_start',
  world: 'MAIN',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: true,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js: [js],
  css: []
})

const extension = (id: string, name: string, over: Partial<ExtensionBoot> = {}): ExtensionBoot => ({
  id,
  name,
  version: '1.0.0',
  manifestVersion: 3,
  permissions: ['storage'],
  optionalPermissions: [],
  hostPermissions: [],
  manifest: { manifest_version: 3, name, version: '1.0.0' },
  messages: null,
  groups: [],
  isolation: 'none',
  ...over
})

const mainUnit = (ext: ExtensionBoot): ContentBootConfig => ({
  kind: 'content',
  token: TOKEN,
  uiLanguage: 'en',
  world: 'main',
  extension: ext
})

describe('content bootstrap: the web page’s chrome.runtime for externally connectable extensions', () => {
  it('installs sendMessage, connect and lastError for the extensions whose patterns cover the page, behind external engines', async () => {
    const posted: Array<Record<string, unknown>> = []
    const bridge: Bridge = {
      postMessage: (message) => {
        posted.push(JSON.parse(message) as Record<string, unknown>)
      },
      onmessage: null
    }
    const fromHost = (message: Record<string, unknown>): void => {
      if (!bridge.onmessage) throw new Error('the bootstrap did not listen')
      bridge.onmessage({ data: JSON.stringify(message) })
    }
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: Boot
      __zenExtExec?: Exec
      __zenExtRuntime?: { attach(boot: Boot): void }
      __zenExtStats?: { pageApi?: string[] }
      chrome?: { runtime?: PageRuntime; app?: Record<string, unknown> } & Record<string, unknown>
    }
    const seenBySpoofer: unknown[] = []
    g.__zenExtBridge = bridge
    // The first copy: the spoofer's main-world unit, not connectable. Its `document_start`
    // script runs on the page's window before any `chrome` exists there.
    g.__zenExtBoot = {
      config: mainUnit(
        extension(SPOOFER, 'Mobile simulator', { groups: [mainGroup('js/spoofer.js')] })
      ),
      sources: {
        [`${SPOOFER}/0`]: (_w, _s, _g, chrome) => {
          seenBySpoofer.push(chrome)
        }
      },
      css: {},
      debug: true
    }
    await import('../extensionBootstrap')
    const exec = g.__zenExtExec
    const runtime = g.__zenExtRuntime
    expect(exec).toBeTypeOf('function')
    expect(runtime).toBeDefined()
    if (!exec || !runtime) return
    expect(seenBySpoofer).toEqual([undefined])
    expect(g.chrome).toBeUndefined()
    expect(posted.filter((m) => m.t === 'hello')).toHaveLength(0)

    // Speak Subtitles' main-world unit attaches: no sources, the connectable pages' pattern.
    runtime.attach({
      config: mainUnit(
        extension(SPEAK, 'Speak Subtitles for YouTube', {
          externallyConnectable: ['http://localhost:3000/*']
        })
      ),
      sources: {},
      css: {}
    })
    const chrome = g.chrome
    expect(chrome).toBeTypeOf('object')
    if (!chrome) return
    const page = chrome.runtime
    expect(page).toBeTypeOf('object')
    if (!page) return
    // Chrome's web-page surface: the two functions and `lastError`, nothing of the extension's.
    expect(Object.keys(page).sort()).toEqual(['connect', 'lastError', 'sendMessage'])
    expect(page.lastError).toBeUndefined()
    const surface = page as unknown as Record<string, unknown>
    expect(surface.id).toBeUndefined()
    expect(surface.getURL).toBeUndefined()
    expect(surface.onMessage).toBeUndefined()
    // The object Chrome gives every http(s) document came with it (shared/chromeObject.ts).
    expect(chrome.app).toMatchObject({ isInstalled: false })
    expect(chrome.csi).toBeTypeOf('function')
    expect(chrome.loadTimes).toBeTypeOf('function')
    // One engine behind it: a content endpoint of the extension's, told apart by its `x`.
    const hellos = posted.filter((m) => m.t === 'hello')
    expect(hellos).toHaveLength(1)
    expect(hellos[0]).toMatchObject({ ctx: 'content', ext: SPEAK, top: true })
    const speakEp = String(hellos[0].ep)
    expect(speakEp).toMatch(new RegExp(`x\\.${SPEAK.slice(0, 8)}$`))
    expect(g.__zenExtStats?.pageApi).toEqual([SPEAK])

    // `sendMessage(id, message, options, callback)`, as Speak Subtitles' page bundle calls it:
    // marked external, the extension's id as the target, over the extension's own endpoint.
    const answers: unknown[] = []
    page.sendMessage(SPEAK, { op: 'settings' }, {}, (response: unknown) => {
      answers.push(response)
    })
    const msg = posted.find((m) => m.t === 'msg')
    expect(msg).toMatchObject({
      ep: speakEp,
      target: { extensionId: SPEAK },
      data: { op: 'settings' },
      callback: true,
      external: true
    })
    expect(msg?.userScript).toBeUndefined()
    fromHost({ t: 'reply', id: msg?.id, ok: true, result: { volume: 1 }, ep: speakEp })
    await Promise.resolve()
    await Promise.resolve()
    expect(answers).toEqual([{ volume: 1 }])

    // A refused message: `lastError` while the callback runs, gone after it, as in Chrome.
    let seenError: unknown = 'not read'
    page.sendMessage(SPEAK, 'ping', () => {
      seenError = page.lastError
    })
    const refused = posted.filter((m) => m.t === 'msg').at(-1)
    fromHost({
      t: 'reply',
      id: refused?.id,
      ok: false,
      error: 'Could not establish connection. Receiving end does not exist.',
      ep: speakEp
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(seenError).toEqual({
      message: 'Could not establish connection. Receiving end does not exist.'
    })
    expect(page.lastError).toBeUndefined()

    // The promise form.
    const promised = page.sendMessage(SPEAK, 'p') as Promise<unknown>
    expect(promised).toBeInstanceOf(Promise)
    const promisedMsg = posted.filter((m) => m.t === 'msg').at(-1)
    fromHost({ t: 'reply', id: promisedMsg?.id, ok: true, result: 'pong', ep: speakEp })
    await expect(promised).resolves.toBe('pong')

    // An id no connectable extension here owns still goes out (through any engine): the router
    // answers it with no receiving end, as Chrome answers a page naming an absent extension.
    void page.sendMessage(ABSENT, 'x', () => undefined)
    expect(posted.filter((m) => m.t === 'msg').at(-1)).toMatchObject({
      target: { extensionId: ABSENT },
      external: true
    })
    // Without an id a web page gets Chrome's error.
    expect(() => page.sendMessage({ op: 1 })).toThrow(
      'chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.'
    )
    expect(() => page.connect()).toThrow(
      'chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.'
    )
    expect(() => page.sendMessage('not-an-id', 'x')).toThrow(TypeError)

    // A port: `connect(id, { name })` marked external; the host's traffic reaches its listeners.
    const port = page.connect(SPEAK, { name: 'yss' })
    expect(port.name).toBe('yss')
    const connect = posted.find((m) => m.t === 'connect')
    expect(connect).toMatchObject({ ep: speakEp, name: 'yss', target: { extensionId: SPEAK }, external: true })
    const heard: unknown[] = []
    port.onMessage.addListener((m) => heard.push(m))
    fromHost({ t: 'portAccept', portId: connect?.portId, accept: true, ep: speakEp })
    fromHost({ t: 'portMsg', portId: connect?.portId, data: { captions: 'on' }, ep: speakEp })
    expect(heard).toEqual([{ captions: 'on' }])
    port.postMessage({ op: 'toggle' })
    expect(posted.filter((m) => m.t === 'portMsg').at(-1)).toMatchObject({
      portId: connect?.portId,
      data: { op: 'toggle' }
    })

    // The spoofer's `world: "MAIN"` scope was made before the API landed; a script of its run
    // now sees the page's `chrome` – the scope reads the window's live, not a copy.
    const fromMain = exec(
      TOKEN,
      SPOOFER,
      'js',
      { world: 'MAIN' },
      (_w: unknown, _s: unknown, _g: unknown, chromeArg: unknown) => chromeArg === g.chrome
    )
    expect(fromMain).toBe(true)

    // A second connectable extension shares the document's one `chrome.runtime` and gets an
    // engine of its own; one whose patterns do not cover this page gets nothing here.
    runtime.attach({
      config: mainUnit(
        extension(OTHER, 'Another connectable', {
          externallyConnectable: ['http://localhost:3000/*', 'https://www.youtube.com/*']
        })
      ),
      sources: {},
      css: {}
    })
    runtime.attach({
      config: mainUnit(
        extension(ELSEWHERE, 'Elsewhere', { externallyConnectable: ['https://www.youtube.com/*'] })
      ),
      sources: {},
      css: {}
    })
    expect(g.chrome?.runtime).toBe(page)
    const engines = posted.filter((m) => m.t === 'hello').map((m) => [m.ext, m.ep])
    expect(engines.map(([ext]) => ext)).toEqual([SPEAK, OTHER])
    const otherEp = String(engines[1][1])
    expect(otherEp).toMatch(new RegExp(`x\\.${OTHER.slice(0, 8)}$`))
    void page.sendMessage(OTHER, 'hello other', () => undefined)
    expect(posted.filter((m) => m.t === 'msg').at(-1)).toMatchObject({
      ep: otherEp,
      target: { extensionId: OTHER },
      external: true
    })
    expect(g.__zenExtStats?.pageApi).toEqual([SPEAK, OTHER])
    // A page's `chrome` is Chrome's plain data properties: a script may replace them.
    expect(Object.getOwnPropertyDescriptor(chrome, 'runtime')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true
    })
  })
})

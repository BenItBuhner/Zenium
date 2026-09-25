import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any
type Listener = (...args: unknown[]) => unknown

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const TARGET = { tabId: 3 }
const HIGHLIGHT_CSS = '::highlight(zen-mark) { background-color: rgba(255, 0, 0, 0.6) }'
const PLAIN_CSS = '#p1 { background-color: rgba(0, 0, 255, 0.6) }'

function fakeHost(): ShimHost {
  return {
    kind: 'worker',
    invoke: (): Promise<InvokeResult> => Promise.resolve({ ok: true, value: undefined }),
    notify: () => {},
    onEvent: () => {}
  }
}

function nativeEvent(): { addListener: Listener; removeListener: Listener; hasListener: Listener } {
  return { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
}

/** The engine's own `insertCSS` / `removeCSS`: a callback answered on the next tick, else a promise. */
function answered(): ReturnType<typeof vi.fn> {
  return vi.fn((...raw: unknown[]) => {
    const cb = raw[raw.length - 1]
    if (typeof cb === 'function') {
      queueMicrotask(() => (cb as Listener)())
      return undefined
    }
    return Promise.resolve(undefined)
  })
}

interface World {
  chrome: Any
  insertCSS: ReturnType<typeof vi.fn>
  removeCSS: ReturnType<typeof vi.fn>
  fetched: string[]
}

/** An MV3 worker's `chrome` with the engine's `scripting`, and the extension's own files behind `fetch`. */
function install(files: Record<string, string> = {}): World {
  const g = globalThis as Any
  const insertCSS = answered()
  const removeCSS = answered()
  const chrome: Any = {
    runtime: {
      id: EXT,
      getManifest: () => ({
        manifest_version: 3,
        name: 'Probe',
        version: '1.0',
        background: { service_worker: 'sw.js' }
      }),
      getURL: (path: string) => `chrome-extension://${EXT}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent(),
      onInstalled: nativeEvent(),
      onStartup: nativeEvent()
    },
    scripting: { insertCSS, removeCSS }
  }
  const fetched: string[] = []
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'fetch', {
    value: (url: string) => {
      fetched.push(url)
      const prefix = `chrome-extension://${EXT}/`
      const path = url.startsWith(prefix) ? url.slice(prefix.length) : url
      const text = files[path]
      return Promise.resolve(
        text === undefined
          ? { ok: false, status: 404, text: () => Promise.resolve('') }
          : { ok: true, status: 200, text: () => Promise.resolve(text) }
      )
    },
    configurable: true,
    writable: true
  })
  installExtensionApi(fakeHost(), API_SPEC)
  return { chrome, insertCSS, removeCSS, fetched }
}

describe("scripting.insertCSS's cascade origin", () => {
  const g = globalThis as Any
  const realFetch = g.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
    Object.defineProperty(g, 'fetch', { value: realFetch, configurable: true, writable: true })
  })

  it('files a USER sheet that styles a registered highlight as AUTHOR, the origin it paints from', async () => {
    const w = install()
    await w.chrome.scripting.insertCSS({ target: TARGET, css: HIGHLIGHT_CSS, origin: 'USER' })
    expect(w.insertCSS).toHaveBeenCalledWith({
      target: TARGET,
      css: HIGHLIGHT_CSS,
      origin: 'AUTHOR'
    })
    await w.chrome.scripting.insertCSS({
      target: TARGET,
      css: `${PLAIN_CSS}\n${HIGHLIGHT_CSS}`,
      origin: 'USER'
    })
    expect(w.insertCSS).toHaveBeenLastCalledWith({
      target: TARGET,
      css: `${PLAIN_CSS}\n${HIGHLIGHT_CSS}`,
      origin: 'AUTHOR'
    })
    await w.chrome.scripting.insertCSS({
      target: TARGET,
      css: 'p::HIGHLIGHT(Mark) { color: red }',
      origin: 'USER'
    })
    expect(w.insertCSS.mock.calls[2]![0]).toMatchObject({ origin: 'AUTHOR' })
    expect(w.fetched).toEqual([])
  })

  it('leaves every other request as the extension made it, the same object', async () => {
    const w = install()
    const plainUser = { target: TARGET, css: PLAIN_CSS, origin: 'USER' }
    const highlightAuthor = { target: TARGET, css: HIGHLIGHT_CSS, origin: 'AUTHOR' }
    const highlightDefault = { target: TARGET, css: HIGHLIGHT_CSS }
    const commented = { target: TARGET, css: `/* ${HIGHLIGHT_CSS} */ ${PLAIN_CSS}`, origin: 'USER' }
    const lookalike = {
      target: TARGET,
      css: '::selection { color: red } .highlight { color: red }',
      origin: 'USER'
    }
    for (const injection of [plainUser, highlightAuthor, highlightDefault, commented, lookalike]) {
      await w.chrome.scripting.insertCSS(injection)
      expect(w.insertCSS.mock.calls.at(-1)![0]).toBe(injection)
    }
    expect(w.fetched).toEqual([])
  })

  it('reads the files of a USER injection from the extension first and promotes when one styles a highlight', async () => {
    const w = install({ 'styles/mark.css': HIGHLIGHT_CSS, 'styles/plain.css': PLAIN_CSS })
    await w.chrome.scripting.insertCSS({
      target: TARGET,
      files: ['/styles/plain.css', 'styles/mark.css'],
      origin: 'USER'
    })
    expect(w.fetched).toEqual([
      `chrome-extension://${EXT}/styles/plain.css`,
      `chrome-extension://${EXT}/styles/mark.css`
    ])
    expect(w.insertCSS).toHaveBeenCalledTimes(1)
    expect(w.insertCSS.mock.calls[0]![0]).toEqual({
      target: TARGET,
      files: ['/styles/plain.css', 'styles/mark.css'],
      origin: 'AUTHOR'
    })
    // The engine's call is the callback form the shim awaits through.
    expect(typeof w.insertCSS.mock.calls[0]![1]).toBe('function')

    const plain = { target: TARGET, files: ['styles/plain.css'], origin: 'USER' }
    await w.chrome.scripting.insertCSS(plain)
    expect(w.insertCSS.mock.calls[1]![0]).toBe(plain)
  })

  it('leaves a files injection one of whose files does not load to the engine, as it was', async () => {
    const w = install({ 'styles/mark.css': HIGHLIGHT_CSS })
    const injection = { target: TARGET, files: ['styles/mark.css', 'missing.css'], origin: 'USER' }
    await w.chrome.scripting.insertCSS(injection)
    expect(w.insertCSS).toHaveBeenCalledTimes(1)
    expect(w.insertCSS.mock.calls[0]![0]).toBe(injection)
  })

  it('answers a callback after the files were read and the engine answered', async () => {
    const w = install({ 'mark.css': HIGHLIGHT_CSS })
    const cb = vi.fn()
    const returned = w.chrome.scripting.insertCSS(
      { target: TARGET, files: ['mark.css'], origin: 'USER' },
      cb
    )
    expect(returned).toBeUndefined()
    expect(cb).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(w.insertCSS.mock.calls[0]![0]).toMatchObject({ origin: 'AUTHOR' })
  })

  it('removes a promoted sheet under the origin it was filed with', async () => {
    const w = install({ 'mark.css': HIGHLIGHT_CSS })
    await w.chrome.scripting.removeCSS({ target: TARGET, css: HIGHLIGHT_CSS, origin: 'USER' })
    expect(w.removeCSS).toHaveBeenCalledWith({
      target: TARGET,
      css: HIGHLIGHT_CSS,
      origin: 'AUTHOR'
    })
    await w.chrome.scripting.removeCSS({ target: TARGET, files: ['mark.css'], origin: 'USER' })
    expect(w.removeCSS.mock.calls[1]![0]).toEqual({
      target: TARGET,
      files: ['mark.css'],
      origin: 'AUTHOR'
    })
    const plain = { target: TARGET, css: PLAIN_CSS, origin: 'USER' }
    await w.chrome.scripting.removeCSS(plain)
    expect(w.removeCSS.mock.calls[2]![0]).toBe(plain)
  })

  it('reaches the engine the same way through the browser alias', async () => {
    const w = install()
    expect(g.browser).toBe(w.chrome)
    await g.browser.scripting.insertCSS({ target: TARGET, css: HIGHLIGHT_CSS, origin: 'USER' })
    expect(w.insertCSS).toHaveBeenCalledWith({
      target: TARGET,
      css: HIGHLIGHT_CSS,
      origin: 'AUTHOR'
    })
  })
})

// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { beforeAll, describe, expect, it } from 'vitest'
import { wrapModuleText } from '../extensionModuleChrome'

/*
 * A content script's module graph under the `with` fallback (a WebView without isolated worlds):
 * the modules a content script `import()`s evaluate on the page's real global, bracketed by the
 * host (`ExtensionScripts.moduleChromeWrap`), where the bootstrap's accessor answers the
 * extension's `chrome`; a webpack chunk of the graph is served as a stub and runs as a block of
 * the content script's scope (`ExtensionScripts.chunkStub`, `extensionChunkRelay.ts`). The three
 * rows of compat round 11 §7 on WebView 113, each with the shape that failed and the one that
 * holds. One boot per test file (the bootstrap is an IIFE over `__zenExtBoot`); the other two
 * extensions attach to it as later units of the same main world do.
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
  /** `__zenExtStats` for the chunk counters. */
  debug?: boolean
}

interface Runtime {
  attach(boot: Boot): void
}

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Store = Record<string, unknown>

const TOKEN = 'unit-test-token'
const AITOPIA = 'becfinhbfclcgokjlobojlnldbfillpf'
const SPEECHIFY = 'ljflmlehinmoeknoonhibbjpldiijjmm'
const MOTE = 'ajphlblkfpppdpkgokiejbjfohfohhmk'

const group = (runAt: BootGroup['runAt'], js: string[]): BootGroup => ({
  index: 0,
  runAt,
  world: 'ISOLATED',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: false,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js,
  css: []
})

const extension = (id: string, name: string, groups: BootGroup[]): ExtensionBoot => ({
  id,
  name,
  version: '6.9.1',
  manifestVersion: 3,
  permissions: ['storage'],
  optionalPermissions: [],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name, version: '6.9.1' },
  messages: null,
  groups,
  isolation: 'with'
})

const boot = (ext: ExtensionBoot, source: GroupFunction): Boot => ({
  config: {
    kind: 'content',
    token: TOKEN,
    uiLanguage: 'en',
    world: 'isolated',
    extension: ext
  },
  sources: { [`${ext.id}/0`]: source },
  css: {},
  debug: true
})

/** A served module's text evaluated on the real global, as the WebView evaluates the bracketed file. */
const evaluateModule = (text: string, id: string): unknown =>
  new Function(wrapModuleText(text, id))()

/**
 * The exec of kind `chunk` as the host assembles it (`ExtensionScripts.execScript`, scoped): the
 * chunk's text inside a `with(window){…}` block of the group function's shape.
 */
const chunkFunction = (text: string): unknown =>
  new Function(
    'window',
    'self',
    'globalThis',
    'chrome',
    'browser',
    '__zenMirror',
    '__zenCompletion',
    `with(window){\n${text}\n}`
  )

const g = globalThis as typeof globalThis & {
  __zenExtBridge?: Bridge
  __zenExtBoot?: Boot
  __zenExtRuntime?: Runtime
  __zenExtExec?: (
    token: string,
    extId: string,
    kind: string,
    payload: unknown,
    fn: unknown
  ) => unknown
  __zenExtChunk?: (extId: unknown, url: unknown) => Promise<boolean> | false
  __zenExtStats?: { chunks?: { scoped: number; plain: number; failed: number } }
  chrome?: unknown
  __zenExtModule?: unknown
}

const posted: Array<Record<string, unknown>> = []
const bridge: Bridge = {
  postMessage: (message) => {
    posted.push(JSON.parse(message) as Record<string, unknown>)
  },
  onmessage: null
}
/** What each extension's content script saw as its `chrome`. */
const seen = new Map<string, unknown>()
/** Mote's runtime chunk: the registry its `import()`ed chunks push onto, and the global it wrote through `r.g`. */
const moteRegistry: Array<[number[], Record<string, () => unknown>]> = []
class HowlerGlobal {}

beforeAll(async () => {
  // A WebView's page has no `chrome` of its own (the round 11 engine probe on 113).
  delete g.chrome
  g.__zenExtBridge = bridge
  g.__zenExtBoot = boot(
    extension(AITOPIA, 'AITOPIA', [
      group('document_end', ['assets/5601d865e4d69e12ffd05583b25a2fd9.js'])
    ]),
    (_window, _self, _globalThis, chrome) => {
      seen.set(AITOPIA, chrome)
    }
  )
  await import('../extensionBootstrap')
  const runtime = g.__zenExtRuntime
  if (!runtime) throw new Error('the bootstrap did not install the runtime')
  runtime.attach(
    boot(
      extension(SPEECHIFY, 'Speechify', [group('document_start', ['content.js'])]),
      (_window, _self, _globalThis, chrome) => {
        seen.set(SPEECHIFY, chrome)
      }
    )
  )
  runtime.attach(
    boot(
      extension(MOTE, 'Mote', [group('document_start', ['content.js'])]),
      (_window, self, globalThis, chrome) => {
        seen.set(MOTE, chrome)
        // webpack's runtime: the chunk registry on `self`, and `HowlerGlobal` through `r.g`
        // (`globalThis`, the scope proxy under the `with` fallback).
        ;(self as Store).webpackChunk_mote_plugin = moteRegistry
        ;(globalThis as Store).HowlerGlobal = HowlerGlobal
      }
    )
  )
  // `document_end`: AITOPIA's group runs once the document is ready.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

describe('a content script module graph under the with fallback', () => {
  it('boots the three extensions as units of one main world', () => {
    expect(seen.size).toBe(3)
    expect(typeof g.__zenExtModule).toBe('function')
    expect(typeof g.__zenExtChunk).toBe('function')
    expect(
      posted
        .filter((m) => m.t === 'hello')
        .map((m) => m.ext)
        .sort()
    ).toEqual([AITOPIA, SPEECHIFY, MOTE].sort())
  })

  it('02 AITOPIA: the polyfill dependency reading globalThis.chrome.runtime.id passes bracketed, and only bracketed', () => {
    // The polyfill's check, as webextension-polyfill spells it (assets/4befdc…js): a static
    // dependency of the entry the content script imported, so it evaluates ahead of the entry.
    const polyfill = `if(!(globalThis.chrome&&globalThis.chrome.runtime&&globalThis.chrome.runtime.id))throw new Error("This script should only be loaded in a browser extension.");globalThis.__seenId=globalThis.chrome.runtime.id;`
    // Served plain – as the dependency was while the host read the Referer for the graph, since
    // a dependency's referrer is the importing module on the extension origin – the page's
    // `chrome` (undefined) answers and the polyfill throws.
    expect(() => new Function(polyfill)()).toThrow(
      'This script should only be loaded in a browser extension.'
    )
    // Served bracketed (ExtensionScripts.isPageModuleGraph: the graph is told by the document,
    // not the Referer), the accessor answers the extension's `chrome` while it evaluates.
    expect(() => evaluateModule(polyfill, AITOPIA)).not.toThrow()
    expect((g as Store).__seenId).toBe(AITOPIA)
    // Outside a module's evaluation the page's own value answers.
    expect(g.chrome).toBeUndefined()
  })

  it('03 Speechify: a dependency binding chrome lazily keeps the extension’s chrome for a read after the graph evaluated', () => {
    // chunk-CAO5DZGK.js: `var ye,O=I(()=>{ye=chrome})`, run by chunk-QZ3HJF6L.js at its first
    // `m.storage.local` read, long after the module evaluated; the bare `chrome` is the
    // module-scoped binding the prologue makes (`let chrome=…`), the extension's for every
    // closure of the module.
    const dependency = `var ye,O=()=>{ye=chrome;return ye};globalThis.__speechifyInit=O;`
    // Served plain, the closure's bare `chrome` is the page's global, undefined here.
    new Function(dependency)()
    const plainInit = (g as Store).__speechifyInit as () => unknown
    expect(plainInit()).toBeUndefined()
    // Served bracketed, the later read finds the extension's `chrome`, with its `storage`.
    evaluateModule(dependency, SPEECHIFY)
    const init = (g as Store).__speechifyInit as () => { storage?: { local?: unknown } }
    expect(g.chrome).toBeUndefined()
    const chrome = init()
    expect(chrome).toBe(seen.get(SPEECHIFY))
    expect(chrome.storage?.local).toBeDefined()
  })

  it('13 Mote: a webpack chunk of the graph runs as a block of the content script’s scope, where the bare HowlerGlobal is', async () => {
    // Mote's sidebar chunk (6380): registered on `self`'s registry, its factory reading the bare
    // `HowlerGlobal` the runtime chunk wrote through `r.g`.
    const chunk = `(self.webpackChunk_mote_plugin=self.webpackChunk_mote_plugin||[]).push([[6380],{1:function(){return HowlerGlobal}}]);`
    // Bracketed on the real global (round 10's `self`), the chunk registers on the content
    // script's registry, but its factory looks the bare name up on the page's global: the
    // ChunkLoadError of round 11's row 13 came from this ReferenceError.
    evaluateModule(chunk, MOTE)
    expect(moteRegistry).toHaveLength(1)
    expect(() => moteRegistry[0][1][1]()).toThrow(ReferenceError)
    moteRegistry.length = 0

    // The stub the host serves the chunk as: `await __zenExtChunk(id, url)`. The relay asks the
    // host for the file over the bridge…
    const url = `https://${MOTE}.ext.zenium.invalid/chunks/6380.js`
    const claim = g.__zenExtChunk?.(MOTE, url)
    expect(claim).toBeInstanceOf(Promise)
    const ask = posted.find((m) => m.t === 'chunkScript')
    expect(ask).toMatchObject({ t: 'chunkScript', token: TOKEN, ext: MOTE, url })
    expect(String(ask?.ep)).toMatch(new RegExp(`\\.${MOTE.slice(0, 8)}$`))
    // …and the host runs it as an exec of kind `chunk`, a `with(window){…}` block of the scope.
    const exec = g.__zenExtExec
    if (!exec) throw new Error('no __zenExtExec')
    expect(exec(TOKEN, MOTE, 'chunk', { id: ask?.id, url }, chunkFunction(chunk))).toBeNull()
    await expect(claim).resolves.toBe(true)
    // The chunk registered on the content script's registry, and its factory finds the bare
    // `HowlerGlobal` through the scope.
    expect(moteRegistry).toHaveLength(1)
    expect(moteRegistry[0][1][1]()).toBe(HowlerGlobal)
    expect((g as Store).HowlerGlobal).toBeUndefined()
    expect(g.__zenExtStats?.chunks).toEqual({ scoped: 1, plain: 0, failed: 0 })
  })

  it('a chunk the bootstrap cannot run here is imported plain: no scope of the extension, or the host’s refusal', async () => {
    // An extension this copy made no scope for answers false at once, without a bridge message.
    const before = posted.length
    expect(g.__zenExtChunk?.('nonexistent-extension-id', 'https://x.ext.zenium.invalid/a.js')).toBe(
      false
    )
    expect(posted).toHaveLength(before)
    // The host's `chunkDone` (not web-accessible, not found, a text it could not run): false, so
    // the stub imports the chunk plain, bracketed.
    const url = `https://${MOTE}.ext.zenium.invalid/chunks/private.js`
    const claim = g.__zenExtChunk?.(MOTE, url)
    const ask = posted.filter((m) => m.t === 'chunkScript').at(-1)
    expect(ask?.url).toBe(url)
    bridge.onmessage?.({
      data: JSON.stringify({
        t: 'chunkDone',
        ep: ask?.ep,
        id: ask?.id,
        ok: false,
        error: 'chunks/private.js is not a web-accessible resource'
      })
    })
    await expect(claim).resolves.toBe(false)
    expect(g.__zenExtStats?.chunks).toEqual({ scoped: 1, plain: 2, failed: 0 })
  })

  it('a chunk that throws in the scope rejects the import with its error', async () => {
    const url = `https://${MOTE}.ext.zenium.invalid/chunks/broken.js`
    const claim = g.__zenExtChunk?.(MOTE, url)
    const ask = posted.filter((m) => m.t === 'chunkScript').at(-1)
    const exec = g.__zenExtExec
    if (!exec) throw new Error('no __zenExtExec')
    exec(
      TOKEN,
      MOTE,
      'chunk',
      { id: ask?.id, url },
      chunkFunction(`throw new TypeError("no registry")`)
    )
    await expect(claim).rejects.toThrow('TypeError: no registry')
    expect(g.__zenExtStats?.chunks).toEqual({ scoped: 1, plain: 2, failed: 1 })
  })
})

import { describe, expect, it } from 'vitest'
import {
  installModuleChrome,
  isWebpackChunk,
  moduleOpen,
  wrapModuleText
} from '../extensionModuleChrome'

const LT = 'oldceeleldhonbafppcapldpdifcinji'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'
const MOTE = 'ajphlblkfpppdpkgokiejbjfohfohhmk'

/** A page global with WebView's own `chrome` object on it, and the extensions attached to the page. */
function page(): {
  win: Record<string, unknown>
  chromes: Map<string, unknown>
  scopes: Map<string, object>
  evaluate: (text: string) => unknown
} {
  const win: Record<string, unknown> = { chrome: { loadTimes: () => 0 } }
  // The window's `self` is a [Replaceable] accessor, `globalThis` a writable data property.
  Object.defineProperty(win, 'self', {
    configurable: true,
    enumerable: true,
    get: () => win,
    set: (value: unknown) => {
      Object.defineProperty(win, 'self', {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
    }
  })
  Object.defineProperty(win, 'globalThis', { value: win, writable: true, configurable: true })
  const chromes = new Map<string, unknown>()
  const scopes = new Map<string, object>()
  // The served module text runs as the page's real global would run it: `globalThis` is `win`,
  // and so are the bare `self` and `chrome` of a module on that global.
  const evaluate = (text: string): unknown =>
    new Function('globalThis', `with (globalThis) { return (() => { ${text} })() }`)(win)
  return { win, chromes, scopes, evaluate }
}

describe('a chrome for the module graph on a one-realm WebView', () => {
  it("answers the extension's chrome while its bracketed module evaluates, the page's otherwise", () => {
    const { win, chromes, evaluate } = page()
    const pageChrome = win.chrome
    const installed = installModuleChrome(win, (id) => chromes.get(id))
    expect(installed.accessor).toBe(true)
    chromes.set(LT, { runtime: { id: LT } })

    // Nothing evaluates: the page sees its own object, enumerable as WebView left it.
    expect(win.chrome).toBe(pageChrome)
    expect(Object.getOwnPropertyDescriptor(win, 'chrome')?.enumerable).toBe(true)
    expect(installed.current()).toBeNull()

    // LanguageTool's polyfill, as its content.js carries it, inside the served module.
    const polyfill = `
      if (!globalThis.chrome?.runtime?.id) throw new Error("This script should only be loaded in a browser extension.");
      const captured = globalThis.chrome;
      globalThis.__seen = captured.runtime.id;
    `
    expect(() => evaluate(polyfill)).toThrow('only be loaded in a browser extension')
    evaluate(wrapModuleText(polyfill, LT))
    expect(win.__seen).toBe(LT)
    // The bracket closed: the page's own object again.
    expect(win.chrome).toBe(pageChrome)
    expect(installed.current()).toBeNull()
  })

  it('nests dependencies of one graph and interleaves two extensions, each seeing its own', () => {
    const { win, chromes } = page()
    const installed = installModuleChrome(win, (id) => chromes.get(id))
    const lt = { runtime: { id: LT } }
    const other = { runtime: { id: OTHER } }
    chromes.set(LT, lt)
    chromes.set(OTHER, other)
    const enter = win.__zenExtModule as (id: string) => unknown
    const leave = win.__zenExtModuleEnd as (id: string) => void

    // A dependency of LT's graph evaluates first, inside the importing module's fetch order.
    expect(enter(LT)).toBe(lt)
    expect(win.chrome).toBe(lt)
    enter(LT)
    expect(win.chrome).toBe(lt)
    leave(LT)
    expect(win.chrome).toBe(lt)
    // Another extension's module, resumed after a top-level await in the middle of LT's.
    enter(OTHER)
    expect(win.chrome).toBe(other)
    leave(LT)
    expect(installed.current()).toBe(OTHER)
    leave(OTHER)
    expect(installed.current()).toBeNull()
    // An extension not attached here: the page's value stands in.
    enter('nobody0000000000000000000000000000')
    expect((win.chrome as { loadTimes?: unknown }).loadTimes).toBeTypeOf('function')
    leave('nobody0000000000000000000000000000')
  })

  it("keeps the page's own assignments, installs once, and leaves a pinned chrome alone", () => {
    const { win, chromes } = page()
    const first = installModuleChrome(win, (id) => chromes.get(id))
    const again = installModuleChrome(win, () => undefined)
    expect(again).toBe(first)
    // A page script that assigns its own `chrome` sees what it assigned.
    const mine = { mine: true }
    win.chrome = mine
    expect(win.chrome).toBe(mine)
    chromes.set(LT, { runtime: { id: LT } })
    ;(win.__zenExtModule as (id: string) => unknown)(LT)
    expect((win.chrome as { runtime: { id: string } }).runtime.id).toBe(LT)
    ;(win.__zenExtModuleEnd as (id: string) => void)(LT)
    expect(win.chrome).toBe(mine)
    // The brackets cannot be redefined by the page.
    expect(Object.getOwnPropertyDescriptor(win, '__zenExtModule')).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false
    })

    const pinned: Record<string, unknown> = {}
    Object.defineProperty(pinned, 'chrome', {
      value: 'theirs',
      writable: false,
      configurable: false
    })
    const result = installModuleChrome(pinned, () => ({}))
    expect(result.accessor).toBe(false)
    expect(pinned.chrome).toBe('theirs')
    expect(typeof pinned.__zenExtModule).toBe('function')
  })

  it("registers a webpack chunk on the content script's own registry and keeps the extension's chrome in its factories (Mote's sidebar chunk)", () => {
    const { win, chromes, scopes, evaluate } = page()
    const installed = installModuleChrome(
      win,
      (id) => chromes.get(id),
      (id) => scopes.get(id)
    )
    expect(installed.selfAccessor).toBe(true)
    const connected: string[] = []
    const moteChrome = {
      runtime: { id: MOTE, connect: (info: { name: string }) => connected.push(info.name) }
    }
    chromes.set(MOTE, moteChrome)
    // The content scripts' `self`: the runtime's scope proxy, whose expandos never reach the page.
    const scope: Record<string, unknown> = { chrome: moteChrome }
    scope.self = scope
    scopes.set(MOTE, scope)

    // runtime.bundle.js, as a content script under the scope: the registry and its hooked push.
    const registered: number[] = []
    new Function(
      'self',
      'registered',
      `const n = self.webpackChunk_mote_plugin = self.webpackChunk_mote_plugin || [];
       const install = (data) => { const [ids, modules] = data; self.__modules = modules; ids.forEach((id) => registered.push(id)) };
       n.forEach(install); n.push = install;`
    )(scope, registered)

    // sidebar.bundle.js, imported by the runtime: on the page's real global, bracketed by the host.
    const chunk =
      '"undefined"!=typeof browser&&(chrome=browser);"use strict";' +
      '(self.webpackChunk_mote_plugin=self.webpackChunk_mote_plugin||[]).push([[6380],{83325(e,t,i){' +
      'chrome.runtime.connect({name:"read-aloud-injector"});e.exports=self}}]);'
    expect(isWebpackChunk(chunk)).toBe(true)
    evaluate(wrapModuleText(chunk, MOTE))
    // The chunk landed on the content script's registry, not on a fresh array of the page's.
    expect(registered).toEqual([6380])
    expect(win.webpackChunk_mote_plugin).toBeUndefined()
    expect(installed.current()).toBeNull()
    // The page's own `self` and `chrome` are back to the page's; `globalThis` was never taken.
    expect(win.self).toBe(win)
    expect(win.globalThis).toBe(win)
    expect(Object.getOwnPropertyDescriptor(win, 'globalThis')).toMatchObject({
      value: win,
      writable: true
    })
    expect((win.chrome as { loadTimes?: unknown }).loadTimes).toBeTypeOf('function')

    // Later, the runtime runs the factory: `chrome` and `self` are still the extension's.
    const modules = scope.__modules as Record<string, (e: { exports?: unknown }) => void>
    const module: { exports?: unknown } = {}
    modules['83325']!(module)
    expect(connected).toEqual(['read-aloud-injector'])
    expect(module.exports).toBe(scope)
  })

  it('answers the scope as self while any bracketed module evaluates, the page otherwise, and globalThis stays the page', () => {
    const { win, chromes, scopes, evaluate } = page()
    installModuleChrome(
      win,
      (id) => chromes.get(id),
      (id) => scopes.get(id)
    )
    const scope: Record<string, unknown> = {}
    scopes.set(LT, scope)
    // A bundle of another shape (Rollup's `self.__lt = ...` at its top level): the plain
    // bracket, the accessor answers the scope as `self` at evaluation time; `globalThis` is the
    // page's real global, as the bracket's own epilogue reaches it through that name.
    const text = 'self.__lt = 1; globalThis.__ltToo = 2; self.__seenSelf = self;'
    expect(isWebpackChunk(text)).toBe(false)
    expect(
      wrapModuleText(text, LT).startsWith(
        `globalThis.__zenExtModule&&globalThis.__zenExtModule("${LT}");self.__lt`
      )
    ).toBe(true)
    evaluate(wrapModuleText(text, LT))
    expect(scope).toEqual({ __lt: 1, __seenSelf: scope })
    expect(win.__lt).toBeUndefined()
    expect(win.__ltToo).toBe(2)
    expect(win.self).toBe(win)
    // An extension without a scope here: the page's own `self`.
    ;(win.__zenExtModule as (id: string) => unknown)(OTHER)
    expect(win.self).toBe(win)
    expect((win.__zenExtModuleSelf as (id: string) => unknown)(OTHER)).toBe(win)
    ;(win.__zenExtModuleEnd as (id: string) => void)(OTHER)
    // A page script assigning `self` keeps what it assigned, and the accessor its place.
    win.self = 'mine'
    expect(win.self).toBe('mine')
    expect(typeof Object.getOwnPropertyDescriptor(win, 'self')?.get).toBe('function')
    ;(win.__zenExtModule as (id: string) => unknown)(LT)
    expect(win.self).toBe(scope)
    ;(win.__zenExtModuleEnd as (id: string) => void)(LT)
    expect(win.self).toBe('mine')
  })

  it("tells a webpack chunk by its registration at the head of the file, whatever the global's spelling", () => {
    expect(
      isWebpackChunk(
        '(self.webpackChunk_mote_plugin=self.webpackChunk_mote_plugin||[]).push([[6380],{}]);'
      )
    ).toBe(true)
    expect(
      isWebpackChunk(
        '/*! chunk */\n"use strict";\n(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[1],{}]);'
      )
    ).toBe(true)
    expect(
      isWebpackChunk('(window.webpackChunkapp = window.webpackChunkapp || []).push([[2], {}]);')
    ).toBe(true)
    // A mismatched pair, a plain module, a registration past the head: not a chunk.
    expect(isWebpackChunk('(self.webpackChunkA=self.webpackChunkB||[]).push([[1],{}]);')).toBe(
      false
    )
    expect(isWebpackChunk('import x from "./x.js"; export const y = x + 1;')).toBe(false)
    expect(
      isWebpackChunk(`${'/'.repeat(600)}(self.webpackChunk=self.webpackChunk||[]).push([[1],{}]);`)
    ).toBe(false)
    // The chunk's prologue binds the module's own `chrome` and `self`; a plain module's does not.
    expect(moduleOpen(MOTE, '(self.webpackChunk=self.webpackChunk||[]).push([[1],{}]);')).toBe(
      `let chrome=globalThis.__zenExtModule?globalThis.__zenExtModule("${MOTE}"):globalThis.chrome,` +
        `self=globalThis.__zenExtModuleSelf?globalThis.__zenExtModuleSelf("${MOTE}"):globalThis.self;`
    )
    expect(moduleOpen(MOTE, 'export const a = 1;')).toBe(
      `globalThis.__zenExtModule&&globalThis.__zenExtModule("${MOTE}");`
    )
    // Without the brackets (isolated worlds, a page without the bootstrap) the chunk's prologue
    // binds the page's own values and the text runs as it was.
    const bare: Record<string, unknown> = { chrome: 'pages', registry: [] }
    bare.self = bare
    new Function(
      'globalThis',
      `with (globalThis) { (() => { ${wrapModuleText('(self.webpackChunk=self.webpackChunk||[]).push([[1],{}]); self.seen = chrome;', MOTE)} })() }`
    )(bare)
    expect(bare.seen).toBe('pages')
    expect(bare.webpackChunk).toEqual([[[1], {}]])
  })

  it('wraps the served text without moving its lines and guarded for globals without the brackets', () => {
    const text =
      'import x from "./x.js";\nexport const y = x + 1;\n//# sourceMappingURL=content.js.map'
    const wrapped = wrapModuleText(text, LT)
    expect(
      wrapped
        .split('\n')
        .slice(0, 3)
        .map((line) => line.replace(/^globalThis\.__zenExtModule[^;]*;/, ''))
    ).toEqual(text.split('\n'))
    expect(
      wrapped.startsWith(`globalThis.__zenExtModule&&globalThis.__zenExtModule("${LT}");import x`)
    ).toBe(true)
    expect(
      wrapped.endsWith(`\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd("${LT}");`)
    ).toBe(true)
    // On a global without the brackets (isolated worlds, a page without the bootstrap) the text runs as it was.
    const bare: Record<string, unknown> = { ran: false }
    new Function('globalThis', wrapModuleText('globalThis.ran = true;', LT))(bare)
    expect(bare.ran).toBe(true)
  })
})

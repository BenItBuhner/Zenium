import { describe, expect, it } from 'vitest'
import { installModuleChrome, wrapModuleText } from '../extensionModuleChrome'

const LT = 'oldceeleldhonbafppcapldpdifcinji'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'

/** A page global with WebView's own `chrome` object on it, and the extensions attached to the page. */
function page(): {
  win: Record<string, unknown>
  chromes: Map<string, unknown>
  evaluate: (text: string) => unknown
} {
  const win: Record<string, unknown> = { chrome: { loadTimes: () => 0 } }
  const chromes = new Map<string, unknown>()
  // The served module text runs as the page's real global would run it: `globalThis` is `win`.
  const evaluate = (text: string): unknown => new Function('globalThis', text)(win)
  return { win, chromes, evaluate }
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

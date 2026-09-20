import { describe, expect, it } from 'vitest'
import {
  collectBuiltins,
  createScopeProxy,
  frameLocation,
  installTrustedTypesShield,
  ownScriptMatcher,
  stackFrame,
  type Any,
  type ShieldedWorld
} from '../extensionIsolation'

/** A window-like global: browser globals on a prototype (as a real window has them), page expandos own. */
function fakeWindow(): Any {
  const proto: Any = {}
  // A native method has no `prototype`; a method shorthand is the closest plain JS gets.
  const methods = {
    setTimeout(this: unknown, fn: () => void): unknown {
      return this === win ? fn() : 'lost this'
    }
  }
  Object.defineProperty(proto, 'setTimeout', { value: methods.setTimeout, configurable: true })
  Object.defineProperty(proto, 'IntersectionObserver', {
    value: class IntersectionObserver {},
    configurable: true
  })
  let handler: unknown = null
  Object.defineProperty(proto, 'onerror', {
    get: () => handler,
    set: (value: unknown) => {
      handler = value
    },
    configurable: true
  })
  const win: Any = Object.create(proto) as Any
  Object.defineProperty(win, 'document', { value: { title: 'page' }, configurable: true })
  return win
}

describe('the scope proxy of the with-fallback', () => {
  it('keeps the extension globals in a private store and never shows the page its own', () => {
    const win = fakeWindow()
    const builtins = collectBuiltins(win)
    win.pageGlobal = 'from the page'
    const scope = createScopeProxy(win, builtins)
    scope.forTrusted = (): string => 'ext'
    expect((scope.forTrusted as () => string)()).toBe('ext')
    expect(win.forTrusted).toBeUndefined()
    expect(scope.pageGlobal).toBeUndefined()
    expect('pageGlobal' in scope).toBe(false)
    expect('IntersectionObserver' in scope).toBe(true)
    expect(scope.window).toBe(scope)
    expect(scope.self).toBe(scope)
    expect(scope.globalThis).toBe(scope)
    expect(scope.document).toBe(win.document)
  })

  it('as the object of a with block, resolves a bare name the script wrote through globalThis', () => {
    const win = fakeWindow()
    const scope = createScopeProxy(win, collectBuiltins(win))
    // Lit's reactive element as Read&Write's toolbar bundles it: the write goes to
    // `globalThis`, the read is the bare identifier; an injection wrapped as a content script's
    // group (`with(window){…}`) finds its own write, and the page's global never sees it.
    const wrapper = new Function(
      'window',
      'self',
      'globalThis',
      `with (window) {
         globalThis.litPropertyMetadata = new WeakMap();
         var metadata = { own: true };
         litPropertyMetadata.set(metadata, 'own');
         return [litPropertyMetadata.get(metadata), typeof setTimeout, 'litPropertyMetadata' in window];
       }`
    ) as (w: unknown, s: unknown, g: unknown) => unknown
    expect(wrapper(scope, scope, scope)).toEqual(['own', 'function', true])
    expect(win.litPropertyMetadata).toBeUndefined()
    expect(scope.litPropertyMetadata).toBeInstanceOf(WeakMap)
  })

  it('shows the top frame its own global as `top` and `parent`, a subframe the real ones', () => {
    const top = fakeWindow()
    Object.defineProperty(Object.getPrototypeOf(top) as object, 'top', {
      get(this: Any) {
        return this === top || this === child ? top : undefined
      },
      configurable: true
    })
    Object.defineProperty(Object.getPrototypeOf(top) as object, 'parent', {
      get(this: Any) {
        return this === child ? top : this === top ? top : undefined
      },
      configurable: true
    })
    const child: Any = Object.create(Object.getPrototypeOf(top) as object) as Any
    const topScope = createScopeProxy(top, collectBuiltins(top))
    expect(topScope.top).toBe(topScope)
    expect(topScope.parent).toBe(topScope)
    expect(topScope.top === topScope.window).toBe(true)
    const childScope = createScopeProxy(child, collectBuiltins(child))
    expect(childScope.top).toBe(top)
    expect(childScope.parent).toBe(top)
    expect(childScope.top === childScope.window).toBe(false)
  })

  it('binds native methods to the real window and keeps constructors as they are', () => {
    const win = fakeWindow()
    const scope = createScopeProxy(win, collectBuiltins(win))
    const setTimeout = scope.setTimeout as (fn: () => string) => unknown
    expect(setTimeout(() => 'ran')).toBe('ran')
    expect(scope.setTimeout).toBe(scope.setTimeout)
    expect(scope.IntersectionObserver).toBe(win.IntersectionObserver)
  })

  it('forwards setter properties of the window (event handlers) and stores the rest', () => {
    const win = fakeWindow()
    const scope = createScopeProxy(win, collectBuiltins(win))
    const onerror = (): void => undefined
    scope.onerror = onerror
    expect(win.onerror).toBe(onerror)
    scope.settings = { a: 1 }
    expect(win.settings).toBeUndefined()
    expect(Object.keys(scope)).toContain('settings')
    delete scope.settings
    expect(scope.settings).toBeUndefined()
  })
})

/**
 * A world whose prototypes mirror Chromium's Trusted Types sinks: every string assigned to a
 * guarded sink is refused unless it is one of the world's trusted objects, as a page with
 * `require-trusted-types-for 'script'` makes the engine do.
 */
function fakeWorld(options: { scriptOwnSetters: boolean; refusePolicy?: boolean }): {
  world: ShieldedWorld & Any
  script: Any
  div: Any
  assigned: string[]
} {
  const assigned: string[] = []
  class Trusted {
    constructor(
      readonly kind: string,
      readonly value: string
    ) {}
  }
  const factory = {
    createPolicy(
      name: string,
      rules: {
        createHTML(i: string): unknown
        createScript(i: string): unknown
        createScriptURL(i: string): unknown
      }
    ) {
      if (options.refusePolicy) throw new TypeError(`Policy "${name}" disallowed`)
      return {
        createHTML: (i: string) => new Trusted('html', String(rules.createHTML(i))),
        createScript: (i: string) => new Trusted('script', String(rules.createScript(i))),
        createScriptURL: (i: string) => new Trusted('scriptUrl', String(rules.createScriptURL(i)))
      }
    }
  }
  const sink =
    (kind: string, name: string) =>
    (value: unknown): void => {
      if (value instanceof Trusted && value.kind === kind) {
        assigned.push(`${name}=${value.value}`)
        return
      }
      const type = { html: 'TrustedHTML', script: 'TrustedScript', scriptUrl: 'TrustedScriptURL' }[
        kind
      ]
      throw new TypeError(
        `Failed to set the '${name}' property: This document requires '${type}' assignment.`
      )
    }
  const guarded = (proto: object, name: string, kind: string): void => {
    Object.defineProperty(proto, name, { set: sink(kind, name), configurable: true })
  }
  const Node = class {}
  const Element = class extends Node {
    localName = ''
  }
  const HTMLElement = class extends Element {}
  const HTMLScriptElement = class extends HTMLElement {
    localName = 'script'
  }
  const HTMLDivElement = class extends HTMLElement {
    localName = 'div'
  }
  guarded(Element.prototype, 'innerHTML', 'html')
  guarded(HTMLScriptElement.prototype, 'src', 'scriptUrl')
  guarded(HTMLScriptElement.prototype, 'text', 'script')
  // Older engines check `textContent` in Node's setter; Chromium 156 gives HTMLScriptElement its own.
  if (options.scriptOwnSetters) {
    Object.defineProperty(Node.prototype, 'textContent', {
      set: (value: unknown) => {
        assigned.push(`Node.textContent=${String(value)}`)
      },
      configurable: true
    })
    guarded(HTMLScriptElement.prototype, 'textContent', 'script')
    guarded(HTMLScriptElement.prototype, 'innerText', 'script')
  } else {
    Object.defineProperty(Node.prototype, 'textContent', {
      set: function (this: { localName?: string }, value: unknown) {
        if (this.localName === 'script') sink('script', 'textContent')(value)
        else assigned.push(`Node.textContent=${String(value)}`)
      },
      configurable: true
    })
  }
  Object.defineProperty(Element.prototype, 'setAttribute', {
    value: function (this: unknown, name: string, value: unknown) {
      if (name === 'src' || name === 'onclick')
        sink(name === 'src' ? 'scriptUrl' : 'script', name)(value)
      else assigned.push(`${name}=${String(value)}`)
    },
    configurable: true
  })
  const world: ShieldedWorld & Any = {
    trustedTypes: factory,
    Node,
    Element,
    HTMLElement,
    HTMLScriptElement
  }
  return {
    world,
    script: new HTMLScriptElement() as unknown as Any,
    div: new HTMLDivElement() as unknown as Any,
    assigned
  }
}

describe('the Trusted Types shield of an isolated world', () => {
  it('routes script text through the policy where the engine checks it on the script element itself', () => {
    const { world, script, div, assigned } = fakeWorld({ scriptOwnSetters: true })
    const result = installTrustedTypesShield(world, 'zenium-ext-test')
    expect(result.policy).toBe(true)
    script.textContent = 'void 0'
    script.innerText = 'void 1'
    script.text = 'void 2'
    script.src = 'https://cdn.example/x.js'
    div.textContent = 'plain text'
    div.innerHTML = '<b>hi</b>'
    expect(assigned).toEqual([
      'textContent=void 0',
      'innerText=void 1',
      'text=void 2',
      'src=https://cdn.example/x.js',
      'Node.textContent=plain text',
      'innerHTML=<b>hi</b>'
    ])
  })

  it('does the same where only the inherited setters exist', () => {
    const { world, script, div, assigned } = fakeWorld({ scriptOwnSetters: false })
    installTrustedTypesShield(world, 'zenium-ext-test')
    script.textContent = 'void 0'
    div.textContent = 'text'
    expect(assigned).toEqual(['textContent=void 0', 'Node.textContent=text'])
  })

  it('guards the attribute sinks by element and leaves the others alone', () => {
    const { world, script, div, assigned } = fakeWorld({ scriptOwnSetters: true })
    installTrustedTypesShield(world, 'zenium-ext-test')
    ;(script.setAttribute as (n: string, v: unknown) => void)('src', 'https://cdn.example/y.js')
    ;(div.setAttribute as (n: string, v: unknown) => void)('onclick', 'go()')
    ;(div.setAttribute as (n: string, v: unknown) => void)('class', 'x')
    expect(assigned).toEqual(['src=https://cdn.example/y.js', 'onclick=go()', 'class=x'])
  })

  it('leaves the sinks untouched when the page refuses the policy name', () => {
    const { world, script } = fakeWorld({ scriptOwnSetters: true, refusePolicy: true })
    const result = installTrustedTypesShield(world, 'zenium-ext-test')
    expect(result).toEqual({ policy: false, patched: 0 })
    expect(() => {
      script.textContent = 'void 0'
    }).toThrow(/TrustedScript/)
  })

  it('does nothing without a factory', () => {
    expect(installTrustedTypesShield({}, 'zenium-ext-test')).toEqual({ policy: false, patched: 0 })
  })
})

/** The host's `//# sourceURL` of the document-start script (ExtensionScripts.SOURCE_URL). */
const OWN = 'zenium-ext://content-scripts/boot.js'

/** `body`, compiled as a function whose frames carry the extension script's location. */
const extensionCode = (params: string, body: string): ((...args: unknown[]) => unknown) =>
  new Function(params, `${body}\n//# sourceURL=${OWN}`) as (...args: unknown[]) => unknown

/** `body`, compiled as page code would be by `new Function`: an `<anonymous>` location. */
const pageCode = (params: string, body: string): ((...args: unknown[]) => unknown) =>
  new Function(params, body) as (...args: unknown[]) => unknown

describe('the stack frames the page-realm shield judges by', () => {
  it('reads the location out of both frame shapes', () => {
    expect(
      frameLocation('    at set src [as src] (zenium-ext://content-scripts/boot.js:12:34)')
    ).toBe('zenium-ext://content-scripts/boot.js')
    expect(frameLocation('    at zenium-ext://content-scripts/boot.js:12:34')).toBe(
      'zenium-ext://content-scripts/boot.js'
    )
    expect(frameLocation('    at f (https://m.youtube.com/s/player.js:1:2)')).toBe(
      'https://m.youtube.com/s/player.js'
    )
    expect(frameLocation('    at <anonymous>:1:2')).toBe('<anonymous>')
    // An eval origin is not a location the shield accepts.
    expect(
      frameLocation('    at eval (eval at run (https://page.example/a.js:1:2), <anonymous>:1:1)')
    ).toBe('')
    expect(frameLocation('')).toBe('')
  })

  it('captures the frame at the asked depth and puts the Error statics back', () => {
    const E = Error as ErrorConstructor & { stackTraceLimit: number; prepareStackTrace?: unknown }
    const limit = E.stackTraceLimit
    E.stackTraceLimit = 0
    const hadPrepare = Object.prototype.hasOwnProperty.call(E, 'prepareStackTrace')
    try {
      const own = extensionCode('stackFrame', 'return stackFrame(Error, 1)')(stackFrame) as string
      expect(frameLocation(own)).toBe(OWN)
      expect(frameLocation(stackFrame(Error, 1))).not.toBe(OWN)
      expect(E.stackTraceLimit).toBe(0)
      expect(Object.prototype.hasOwnProperty.call(E, 'prepareStackTrace')).toBe(hadPrepare)
    } finally {
      E.stackTraceLimit = limit
    }
  })

  it('knows its own script by the location the host named it with, and stays off without one', () => {
    const matcher = extensionCode('own', 'return own(Error)')(ownScriptMatcher) as
      ((frame: string) => boolean) | undefined
    expect(matcher).toBeDefined()
    const ownFrame = extensionCode(
      'stackFrame',
      'return stackFrame(Error, 1)'
    )(stackFrame) as string
    expect(matcher!(ownFrame)).toBe(true)
    expect(matcher!('    at f (https://m.youtube.com/s/player.js:1:2)')).toBe(false)
    expect(matcher!('    at <anonymous>:1:2')).toBe(false)
    expect(matcher!('')).toBe(false)
    // Called from a script without the host's name (this test file, `new Function` code): no matcher.
    expect(ownScriptMatcher(Error)).toBeUndefined()
    expect(pageCode('own', 'return own(Error)')(ownScriptMatcher)).toBeUndefined()
    // A web location is never the extension's, even when named so.
    const web = new Function(
      'own',
      'return own(Error)\n//# sourceURL=https://page.example/x.js'
    ) as (o: unknown) => unknown
    expect(web(ownScriptMatcher)).toBeUndefined()
  })
})

describe('the Trusted Types shield of the page realm (the with-fallback)', () => {
  const shield = (
    options: { scriptOwnSetters: boolean; refusePolicy?: boolean } = { scriptOwnSetters: true }
  ): ReturnType<typeof fakeWorld> & { result: ReturnType<typeof installTrustedTypesShield> } => {
    const fake = fakeWorld(options)
    const ownCaller = extensionCode('own', 'return own(Error)')(ownScriptMatcher) as (
      frame: string
    ) => boolean
    const result = installTrustedTypesShield(fake.world, 'zenium-ext-test', { ownCaller, Error })
    return { ...fake, result }
  }

  it("trusts the extension's refused string writes and keeps the page's policy for the page", () => {
    const { script, div, assigned, result } = shield()
    expect(result.policy).toBe(true)
    extensionCode('s', 's.src = "https://cdn.example/x.js"')(script)
    extensionCode('s', 's.textContent = "void 0"')(script)
    extensionCode('s', 's.text = "void 1"')(script)
    extensionCode('d', 'd.innerHTML = "<b>ext</b>"')(div)
    extensionCode('d', 'd.setAttribute("onclick", "go()")')(div)
    expect(assigned).toEqual([
      'src=https://cdn.example/x.js',
      'textContent=void 0',
      'text=void 1',
      'innerHTML=<b>ext</b>',
      'onclick=go()'
    ])
    // The page's writes: refused as before the shield, by the page's own policy.
    expect(() => pageCode('s', 's.src = "https://cdn.example/y.js"')(script)).toThrow(
      /TrustedScriptURL/
    )
    expect(() => pageCode('d', 'd.innerHTML = "<b>page</b>"')(div)).toThrow(/TrustedHTML/)
    expect(() => pageCode('d', 'd.setAttribute("onclick", "go()")')(div)).toThrow(/TrustedScript/)
    expect(() => {
      script.text = 'void 2'
    }).toThrow(/TrustedScript/)
    expect(assigned).toHaveLength(5)
  })

  it('passes writes the policy accepts and non-string writes straight through', () => {
    const { script, div, assigned } = shield()
    // Not a sink for a div: no policy involved, from anyone.
    pageCode('d', 'd.textContent = "plain"')(div)
    extensionCode('d', 'd.setAttribute("class", "x")')(div)
    expect(assigned).toEqual(['Node.textContent=plain', 'class=x'])
    // A non-string the policy refuses stays refused: the retry has nothing to trust.
    expect(() => extensionCode('s', 's.src = 42')(script)).toThrow(/TrustedScriptURL/)
    expect(assigned).toHaveLength(2)
  })

  it('lets any other error of a sink through untouched', () => {
    const { world, div, assigned } = shield()
    Object.defineProperty((world.Element as { prototype: object }).prototype, 'outerHTML', {
      set: () => {
        throw new RangeError('not Trusted Types')
      },
      configurable: true
    })
    installTrustedTypesShield(world, 'zenium-ext-test-2', {
      ownCaller: () => true,
      Error
    })
    expect(() => extensionCode('d', 'd.outerHTML = "<b>x</b>"')(div)).toThrow(RangeError)
    expect(assigned).toEqual([])
  })

  it('does the same where only the inherited setters exist', () => {
    const { script, div, assigned } = shield({ scriptOwnSetters: false })
    extensionCode('s', 's.textContent = "void 0"')(script)
    expect(() => pageCode('s', 's.textContent = "void 1"')(script)).toThrow(/TrustedScript/)
    pageCode('d', 'd.textContent = "text"')(div)
    expect(assigned).toEqual(['textContent=void 0', 'Node.textContent=text'])
  })
})

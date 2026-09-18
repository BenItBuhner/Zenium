import { describe, expect, it } from 'vitest'
import {
  collectBuiltins,
  createScopeProxy,
  installTrustedTypesShield,
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

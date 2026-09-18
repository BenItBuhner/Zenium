/**
 * The two pieces of the content-script bootstrap that keep an extension apart from the page,
 * as pure functions over a window-like object so they can be tested outside a WebView:
 *
 *  - the scope proxy of the `with` fallback (WebViews without isolated worlds, Chromium < 146):
 *    a per-extension stand-in for `window` / `self` / `globalThis` whose expandos never reach
 *    the page and which never shows the page's globals;
 *  - the Trusted Types shield for real isolated worlds: a pass-through policy created in the
 *    world and applied to the world's own DOM sinks, so a content script's `innerHTML = …` is
 *    not refused by a page whose CSP demands Trusted Types (m.youtube.com), while the page's
 *    own prototypes stay untouched.
 */
export type Any = Record<PropertyKey, unknown>

/**
 * The global's own keys and its prototype chain's at document start: everything the browser
 * defines. A key the page adds later is a page global, which an isolated world would not see.
 */
export function collectBuiltins(realWindow: object): Set<PropertyKey> {
  const builtins = new Set<PropertyKey>()
  let obj: object | null = realWindow
  while (obj) {
    for (const key of Reflect.ownKeys(obj)) builtins.add(key)
    obj = Object.getPrototypeOf(obj)
  }
  return builtins
}

/**
 * A per-extension stand-in for `window` / `self` / `globalThis`: expandos land in a private
 * store and never reach the page, reads of browser globals fall through to the real window with
 * native methods bound so `window.setTimeout(...)` keeps working, page globals read as
 * undefined, event handler and other setter properties are forwarded. As the scope object of a
 * `with` block, a bare `forTrusted(...)` finds the `globalThis.forTrusted = ...` another file of
 * the extension wrote; `has` answers for the store and the browser's globals only, so
 * `'IntersectionObserver' in window` stays honest and the group's own `var`s still resolve.
 *
 * What it cannot hide is what makes the host report reduced isolation: the page and the script
 * share prototypes, and a bare identifier the page defined is found through the real global
 * scope when the store and the browser do not have it.
 */
export function createScopeProxy(realWindow: object, builtins: Set<PropertyKey>): Any {
  const store: Any = Object.create(null) as Any
  const bound = new Map<PropertyKey, unknown>()
  const target = Object.create(Object.getPrototypeOf(realWindow) as object) as Any
  const win = realWindow as Any
  const findSetter = (key: PropertyKey): boolean => {
    let obj: object | null = win
    while (obj) {
      const desc = Object.getOwnPropertyDescriptor(obj, key)
      if (desc) return typeof desc.set === 'function'
      obj = Object.getPrototypeOf(obj)
    }
    return false
  }
  const proxy: Any = new Proxy(target, {
    get(_t, key) {
      if (key in store) return store[key]
      if (key === 'window' || key === 'self' || key === 'globalThis' || key === 'frames')
        return proxy
      if (!builtins.has(key)) return undefined
      const value = win[key]
      if (typeof value === 'function' && typeof key === 'string') {
        const fn = value as { prototype?: unknown }
        // Methods (no `prototype`, lower-case name) need `this === window`; constructors keep identity.
        if (!('prototype' in fn) && key[0] === key[0].toLowerCase()) {
          let b = bound.get(key)
          if (!b) {
            b = (value as (...a: unknown[]) => unknown).bind(realWindow)
            bound.set(key, b)
          }
          return b
        }
      }
      return value
    },
    set(_t, key, value) {
      if (!(key in store) && builtins.has(key) && findSetter(key)) {
        win[key] = value
        return true
      }
      store[key] = value
      return true
    },
    has(_t, key) {
      return key in store || builtins.has(key)
    },
    deleteProperty(_t, key) {
      delete store[key]
      return true
    },
    defineProperty(_t, key, descriptor) {
      Object.defineProperty(store, key, descriptor)
      return true
    },
    getOwnPropertyDescriptor(_t, key) {
      const own = Object.getOwnPropertyDescriptor(store, key)
      if (own) return own
      if (!builtins.has(key)) return undefined
      const real = Object.getOwnPropertyDescriptor(win, key)
      return real ? { ...real, configurable: true } : undefined
    },
    ownKeys() {
      const keys = new Set<string | symbol>()
      for (const key of Reflect.ownKeys(win)) if (builtins.has(key)) keys.add(key)
      for (const key of Reflect.ownKeys(store)) keys.add(key)
      return [...keys]
    }
  })
  return proxy
}

interface TrustedTypePolicy {
  createHTML(input: string): unknown
  createScript(input: string): unknown
  createScriptURL(input: string): unknown
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: TrustedTypePolicy): TrustedTypePolicy
  isHTML?(value: unknown): boolean
  isScript?(value: unknown): boolean
  isScriptURL?(value: unknown): boolean
}

type Sink = 'html' | 'script' | 'scriptUrl'

/** Attributes Trusted Types guards, by element (lower-case tag) and attribute (lower-case). */
const ATTRIBUTE_SINKS: Array<{ tag: string | null; attribute: string; sink: Sink }> = [
  { tag: 'iframe', attribute: 'srcdoc', sink: 'html' },
  { tag: 'script', attribute: 'src', sink: 'scriptUrl' },
  { tag: 'embed', attribute: 'src', sink: 'scriptUrl' },
  { tag: 'object', attribute: 'data', sink: 'scriptUrl' },
  { tag: 'object', attribute: 'codebase', sink: 'scriptUrl' }
]

/** The world-like shape the shield needs: the DOM constructors of the world plus its factory. */
export interface ShieldedWorld {
  trustedTypes?: TrustedTypePolicyFactory
  Element?: { prototype: object }
  ShadowRoot?: { prototype: object }
  Document?: { prototype: object }
  Range?: { prototype: object }
  Node?: { prototype: object }
  HTMLScriptElement?: { prototype: object }
  HTMLIFrameElement?: { prototype: object }
  HTMLElement?: { prototype: object }
}

export interface ShieldResult {
  /** The policy exists: the page's CSP let the world create it (or does not restrict names). */
  policy: boolean
  /** Number of sinks re-defined on the world's prototypes. */
  patched: number
}

/**
 * Create the pass-through policy in `world` and route the world's string sinks through it:
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, shadow roots, `document.write`,
 * `createContextualFragment`, `<iframe srcdoc>`, `<script>` sources and text, the guarded
 * attributes through `setAttribute`. Every wrapper is a thin pass-through when the value is
 * already trusted or the sink is not a string, so behaviour elsewhere is unchanged. Returns what
 * happened; a page whose `trusted-types` directive refuses the name leaves the sinks alone.
 */
export function installTrustedTypesShield(world: ShieldedWorld, policyName: string): ShieldResult {
  const factory = world.trustedTypes
  if (!factory || typeof factory.createPolicy !== 'function') return { policy: false, patched: 0 }
  let policy: TrustedTypePolicy
  try {
    policy = factory.createPolicy(policyName, {
      createHTML: (input) => input,
      createScript: (input) => input,
      createScriptURL: (input) => input
    })
  } catch {
    return { policy: false, patched: 0 }
  }
  const trust = (sink: Sink, value: unknown): unknown => {
    if (typeof value !== 'string') return value
    try {
      switch (sink) {
        case 'html':
          return policy.createHTML(value)
        case 'script':
          return policy.createScript(value)
        case 'scriptUrl':
          return policy.createScriptURL(value)
      }
    } catch {
      return value
    }
  }
  let patched = 0

  const patchSetter = (proto: object | undefined, name: string, sink: Sink): void => {
    if (!proto) return
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (!desc || typeof desc.set !== 'function' || !desc.configurable) return
    const set = desc.set
    try {
      Object.defineProperty(proto, name, {
        ...desc,
        set(this: unknown, value: unknown) {
          set.call(this, trust(sink, value))
        }
      })
      patched += 1
    } catch {
      /* a frozen prototype: leave it */
    }
  }

  const patchMethod = (
    proto: object | undefined,
    name: string,
    wrap: (args: unknown[], self: unknown) => unknown[]
  ): void => {
    if (!proto) return
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (!desc || typeof desc.value !== 'function' || !desc.configurable) return
    const original = desc.value as (...args: unknown[]) => unknown
    try {
      Object.defineProperty(proto, name, {
        ...desc,
        value: function (this: unknown, ...args: unknown[]) {
          return original.apply(this, wrap(args, this))
        }
      })
      patched += 1
    } catch {
      /* leave it */
    }
  }

  const tagOf = (self: unknown): string => {
    const tag = (self as { localName?: unknown } | null)?.localName
    return typeof tag === 'string' ? tag.toLowerCase() : ''
  }

  patchSetter(world.Element?.prototype, 'innerHTML', 'html')
  patchSetter(world.Element?.prototype, 'outerHTML', 'html')
  patchSetter(world.ShadowRoot?.prototype, 'innerHTML', 'html')
  patchSetter(world.HTMLIFrameElement?.prototype, 'srcdoc', 'html')
  patchSetter(world.HTMLScriptElement?.prototype, 'src', 'scriptUrl')
  patchSetter(world.HTMLScriptElement?.prototype, 'text', 'script')
  patchMethod(world.Element?.prototype, 'insertAdjacentHTML', (args) => [
    args[0],
    trust('html', args[1])
  ])
  patchMethod(world.Range?.prototype, 'createContextualFragment', (args) => [
    trust('html', args[0])
  ])
  for (const name of ['write', 'writeln'] as const)
    patchMethod(world.Document?.prototype, name, (args) => args.map((a) => trust('html', a)))
  const attributeSink = (self: unknown, attribute: unknown): Sink | null => {
    if (typeof attribute !== 'string') return null
    const lower = attribute.toLowerCase()
    if (lower.startsWith('on')) return 'script'
    const tag = tagOf(self)
    const hit = ATTRIBUTE_SINKS.find(
      (entry) => entry.attribute === lower && (entry.tag === null || entry.tag === tag)
    )
    return hit ? hit.sink : null
  }
  patchMethod(world.Element?.prototype, 'setAttribute', (args, self) => {
    const sink = attributeSink(self, args[0])
    return sink ? [args[0], trust(sink, args[1])] : args
  })
  patchMethod(world.Element?.prototype, 'setAttributeNS', (args, self) => {
    const sink = attributeSink(self, args[1])
    return sink ? [args[0], args[1], trust(sink, args[2])] : args
  })
  // `textContent` and `innerText` are sinks on <script> only. Their setters live up the chain
  // (Node, HTMLElement); Chromium 156 also gives HTMLScriptElement its own pair, per the HTML
  // spec's Trusted Types overrides, and those shadow the inherited ones, so they are patched too
  // where they exist (a `getOwnPropertyDescriptor` miss on an older engine skips them).
  for (const [proto, name] of [
    [world.Node?.prototype, 'textContent'],
    [world.HTMLElement?.prototype, 'innerText'],
    [world.HTMLScriptElement?.prototype, 'textContent'],
    [world.HTMLScriptElement?.prototype, 'innerText']
  ] as const) {
    if (!proto) continue
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (!desc || typeof desc.set !== 'function' || !desc.configurable) continue
    const set = desc.set
    try {
      Object.defineProperty(proto, name, {
        ...desc,
        set(this: unknown, value: unknown) {
          set.call(this, tagOf(this) === 'script' ? trust('script', value) : value)
        }
      })
      patched += 1
    } catch {
      /* leave it */
    }
  }
  return { policy: true, patched }
}

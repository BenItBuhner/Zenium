/**
 * The two pieces of the content-script bootstrap that keep an extension apart from the page,
 * as pure functions over a window-like object so they can be tested outside a WebView:
 *
 *  - the scope proxy of the `with` fallback (WebViews without isolated worlds, Chromium < 146):
 *    a per-extension stand-in for `window` / `self` / `globalThis` whose expandos never reach
 *    the page and which never shows the page's globals;
 *  - the Trusted Types shield: a pass-through policy applied to the DOM sinks, so a content
 *    script's `innerHTML = …` is not refused by a page whose CSP demands Trusted Types
 *    (m.youtube.com). In a real isolated world the world's own prototypes are patched and every
 *    write is the extension's, the page's prototypes stay untouched. In the `with` fallback the
 *    prototypes are the page's, so a sink keeps the page's policy for the page: a string the
 *    policy refused is retried through the pass-through policy only when the frame that wrote
 *    it is the extension's own script (the host names the document-start script with a
 *    `//# sourceURL` no page script can have, and the bootstrap reads its own frames' location).
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
 * The keys of the global's operations at document start: the function-valued data properties
 * of the global and its prototype chain that are not constructors (a native method has no
 * `prototype`; `fetch`, `setTimeout`, `addEventListener`, `requestAnimationFrame`, …).
 * Accessors are not read. A function read through one of these keys is a call on the window
 * whatever function a page script has put there since: Sentry's `browserApiErrors` replaces
 * `EventTarget.prototype.addEventListener` and the timer functions with plain wrappers that
 * forward `this` to the native, and a plain function has a `prototype`, so the shape test
 * alone would hand it back unbound and a bare `addEventListener(...)` in a `with` block would
 * call it with the scope object as `this` (roblox.com's Sentry: `Illegal invocation`).
 */
export function collectOperations(realWindow: object): Set<PropertyKey> {
  const operations = new Set<PropertyKey>()
  let obj: object | null = realWindow
  while (obj && obj !== Object.prototype) {
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key !== 'string' || key[0] !== key[0].toLowerCase()) continue
      const desc = Object.getOwnPropertyDescriptor(obj, key)
      const value = desc?.value as { prototype?: unknown } | undefined
      if (typeof value === 'function' && !('prototype' in value)) operations.add(key)
    }
    obj = Object.getPrototypeOf(obj)
  }
  return operations
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
 * A function is bound to the real window when it is method-shaped (no `prototype`, lower-case
 * name) or when its key is one of `operations` (the window's operations at document start,
 * `collectOperations`): a bare call inside the `with` block otherwise runs with the scope object
 * as `this`, and a native, or a page's wrapper forwarding `this` to the native, refuses that
 * receiver. The binding follows the current value: a function the page replaces after a first
 * read is bound afresh. Constructors keep their identity.
 *
 * What it cannot hide is what makes the host report reduced isolation: the page and the script
 * share prototypes, and a bare identifier the page defined is found through the real global
 * scope when the store and the browser do not have it.
 */
export function createScopeProxy(
  realWindow: object,
  builtins: Set<PropertyKey>,
  operations: ReadonlySet<PropertyKey> = new Set()
): Any {
  const store: Any = Object.create(null) as Any
  const bound = new Map<PropertyKey, { of: unknown; fn: unknown }>()
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
      // In an isolated world `window.top` and `window.parent` are the world's own global when
      // they are this frame's (the top frame: `window === window.top`, the idiom content scripts
      // tell the top frame by); another frame's window stays the page's, as Chrome shows it.
      if ((key === 'top' || key === 'parent') && value === realWindow) return proxy
      if (typeof value === 'function' && typeof key === 'string') {
        const fn = value as { prototype?: unknown }
        // Methods (no `prototype`, lower-case name) and the window's operations of document
        // start, whatever their shape now, need `this === window`; constructors keep identity.
        if (operations.has(key) || (!('prototype' in fn) && key[0] === key[0].toLowerCase())) {
          let b = bound.get(key)
          if (!b || b.of !== value) {
            b = { of: value, fn: (value as (...a: unknown[]) => unknown).bind(realWindow) }
            bound.set(key, b)
          }
          return b.fn
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

export interface ShieldOptions {
  /**
   * Set in the page realm (the `with` fallback, where the content scripts share the page's
   * prototypes): the page's own writes keep the page's policy, so a string a sink refused is
   * retried through the pass-through policy only when the frame that wrote it – the direct
   * caller of the sink, judged by this predicate from its stack frame line – is the extension's
   * script. Absent, every write is the extension's (a real isolated world).
   */
  ownCaller?: (frame: string) => boolean
  /** The realm's `Error`, captured before the page ran (the stack frames come from it). */
  Error?: ErrorConstructor
}

/** The location part of a V8 stack frame line: `at f (loc:1:2)` or `at loc:1:2` → `loc`. */
export function frameLocation(frame: string): string {
  const parenthesised = /\(([^()]*):\d+:\d+\)\s*$/.exec(frame)
  if (parenthesised) return parenthesised[1]
  const bare = /\bat\s+(\S+):\d+:\d+\s*$/.exec(frame)
  return bare ? bare[1] : ''
}

/**
 * The stack frame line `depth` frames above this function's own (0: this function, 1: its
 * caller, …), or '' when the realm gives no usable stack. `Error.stackTraceLimit` and
 * `Error.prepareStackTrace` are the realm's and a page may have changed them (a limit of 0, a
 * custom format): both are set for the capture and put back.
 */
export function stackFrame(ErrorCtor: ErrorConstructor, depth: number): string {
  const E = ErrorCtor as unknown as { stackTraceLimit?: number; prepareStackTrace?: unknown }
  let stack: unknown
  try {
    const limit = E.stackTraceLimit
    const hadPrepare = Object.prototype.hasOwnProperty.call(E, 'prepareStackTrace')
    const prepare = E.prepareStackTrace
    try {
      E.stackTraceLimit = depth + 1
      E.prepareStackTrace = undefined
      stack = new ErrorCtor().stack
    } finally {
      E.stackTraceLimit = limit
      if (hadPrepare) E.prepareStackTrace = prepare
      else delete E.prepareStackTrace
    }
  } catch {
    return ''
  }
  if (typeof stack !== 'string') return ''
  const frames = stack.split('\n').filter((line) => /^\s*at\s/.test(line))
  return frames[depth] ?? ''
}

/** Schemes a page's own script can carry as its location; a frame there is never the extension's. */
const PAGE_SCHEMES = /^(https?|blob|data|file|about|javascript|wss?|ftp):/i

/**
 * A predicate for `ShieldOptions.ownCaller` in the page realm: whether a frame's location is
 * the one of the script this is called from – the host's `//# sourceURL` of the document-start
 * script. `undefined` when the own location is one a page script could share (`<anonymous>`,
 * a web URL, an eval origin): then the shield cannot tell the writers apart and must stay off.
 */
export function ownScriptMatcher(
  ErrorCtor: ErrorConstructor
): ((frame: string) => boolean) | undefined {
  // 0: stackFrame, 1: this function, 2: the caller, in the script whose frames are to be known.
  const own = frameLocation(stackFrame(ErrorCtor, 2))
  if (!own || own === '<anonymous>' || !/^[a-z][a-z0-9+.-]*:/i.test(own) || PAGE_SCHEMES.test(own))
    return undefined
  return (frame) => frameLocation(frame) === own
}

/** Whether `error` is a Trusted Types refusal (`This document requires 'TrustedHTML' assignment`). */
function isTrustedTypesRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && /'Trusted(HTML|Script|ScriptURL)'/.test(message)
}

/**
 * Create the pass-through policy in `world` and route the world's string sinks through it:
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, shadow roots, `document.write`,
 * `createContextualFragment`, `<iframe srcdoc>`, `<script>` sources and text, the guarded
 * attributes through `setAttribute`. Every wrapper is a thin pass-through when the value is
 * already trusted or the sink is not a string, so behaviour elsewhere is unchanged. Returns what
 * happened; a page whose `trusted-types` directive refuses the name leaves the sinks alone.
 *
 * With `options.ownCaller` (the page realm) a wrapper first lets the sink run as it is; only a
 * string the page's policy refused, written by the extension's own frame, goes through the
 * policy on a second attempt. The page's writes, and the extension's non-string writes, see the
 * page's outcome. The first, refused attempt still reports to the page's `report-uri` and its
 * `securitypolicyviolation` listeners, as the write did before the shield.
 */
export function installTrustedTypesShield(
  world: ShieldedWorld,
  policyName: string,
  options: ShieldOptions = {}
): ShieldResult {
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
  const ownCaller = options.ownCaller
  const ErrorCtor = options.Error ?? Error
  /** Page realm: the refused write is the extension's own, so the retry may trust it. */
  const retryable = (error: unknown, before: unknown[], after: unknown[]): boolean =>
    ownCaller !== undefined &&
    isTrustedTypesRefusal(error) &&
    after.some((value, i) => value !== before[i]) &&
    // 0: stackFrame, 1: this arrow, 2: the sink wrapper, 3: whoever wrote the sink.
    ownCaller(stackFrame(ErrorCtor, 3))
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
          if (!ownCaller) {
            set.call(this, trust(sink, value))
            return
          }
          try {
            set.call(this, value)
          } catch (error) {
            const trusted = trust(sink, value)
            if (!retryable(error, [value], [trusted])) throw error
            set.call(this, trusted)
          }
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
          if (!ownCaller) return original.apply(this, wrap(args, this))
          try {
            return original.apply(this, args)
          } catch (error) {
            const trusted = wrap(args, this)
            if (!retryable(error, args, trusted)) throw error
            return original.apply(this, trusted)
          }
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
          if (!ownCaller) {
            set.call(this, tagOf(this) === 'script' ? trust('script', value) : value)
            return
          }
          try {
            set.call(this, value)
          } catch (error) {
            const trusted = tagOf(this) === 'script' ? trust('script', value) : value
            if (!retryable(error, [value], [trusted])) throw error
            set.call(this, trusted)
          }
        }
      })
      patched += 1
    } catch {
      /* leave it */
    }
  }
  return { policy: true, patched }
}

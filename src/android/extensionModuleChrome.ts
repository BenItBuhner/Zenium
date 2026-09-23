/**
 * A `chrome` (and a `self`) for the module graph of a content script on a one-realm WebView.
 *
 * Below Chromium 146 there are no isolated worlds: content scripts run in the page's main world
 * under the runtime's `with`-scope proxy, whose `chrome` is a binding of that scope. A dynamic
 * `import()` from such a script evaluates its module on the page's real global, where that
 * binding is not: LanguageTool's `content.js` (its polyfill: `globalThis.chrome?.runtime?.id`)
 * threw "This script should only be loaded in a browser extension".
 *
 * The host serves the extension's own module files and, on such a WebView, brackets each one it
 * serves to a page (`Extensions.kt`, `ExtensionScripts.moduleChromeWrap`): a prologue
 * `globalThis.__zenExtModule("<id>")` before the text and an epilogue `__zenExtModuleEnd("<id>")`
 * after it. While the module's body evaluates – synchronously, dependencies first, each bracketed
 * itself – the real global's `chrome` (an accessor this installs at document start, in place of
 * the page's own value) answers with that extension's `chrome`; at every other time it answers
 * with the page's own, so the page never sees an extension's API. A polyfill captures its
 * `chrome` at evaluation, which is what makes the graph work; a module that reads
 * `globalThis.chrome` later, from a callback, gets the page's value, as it does in Chrome for a
 * `world: "MAIN"` script.
 *
 * `self` answers the same way while a module evaluates: the extension's scope proxy, the
 * content scripts' own `self`, so a webpack chunk the content script's runtime `import()`s
 * registers on the runtime's registry (`self.webpackChunk_mote_plugin.push(...)`) and not on a
 * fresh array of the page's window, which left the runtime waiting and Mote's sidebar chunk a
 * "ChunkLoadError: Loading chunk 6380 failed." (compat round 10, row 27). `globalThis` stays
 * the page's: the brackets themselves are reached through it (`globalThis.__zenExtModuleEnd`),
 * and a `globalThis` answering the scope would never close one.
 *
 * A module that reads `chrome` later, from a function of its own, would find the page's value
 * by then: Buyhatke's Vite chunks (`chrome.storage.local.get`, `chrome.runtime.sendMessage`
 * from their handlers, compat round 9, row 7) did. So the prologue also binds `chrome` in the
 * module's own scope, `let chrome = <the bracket's entry>`: a module-scoped `let` shadows the
 * global for every closure the module creates, and its functions, run later, find the
 * extension's `chrome` as Chrome's isolated world has them. A webpack chunk
 * (`isWebpackChunk`) binds `self` the same way, for the registry its factories read. The one
 * module that keeps the plain bracket is one that declares `chrome` itself
 * (`declaresChrome`: a `let` / `const` / `var` / `function` / `class` of that name, or an
 * `import` binding it), since a second declaration would be a SyntaxError for the whole file;
 * the host looks for one in the first `MODULE_SCAN_HEAD` of the text (a file is never read
 * whole into the heap for it), which is where a minified chunk keeps every top-level name it
 * did not rename.
 */

export interface ModuleChrome {
  /** Whether the real global's `chrome` became the accessor (false when the page had pinned it). */
  accessor: boolean
  /** Whether the real global's `self` became the accessor answering the scope (false when pinned, or no `scopeFor`). */
  selfAccessor: boolean
  /** Which extension's module evaluates now, or null. */
  current(): string | null
}

const ENTER = '__zenExtModule'
const LEAVE = '__zenExtModuleEnd'
const SELF = '__zenExtModuleSelf'

/**
 * Install the module brackets and the `chrome` accessor on `win` (the page's real global), once
 * per global; `chromeFor` answers an attached extension's `chrome` or undefined, `scopeFor` its
 * content scripts' `self` (the scope proxy) or undefined.
 */
export function installModuleChrome(
  win: object,
  chromeFor: (extensionId: string) => unknown,
  scopeFor?: (extensionId: string) => object | undefined
): ModuleChrome {
  const g = win as Record<string, unknown>
  const existing = g[ENTER] as
    (((id: string) => unknown) & { __zenModuleChrome?: ModuleChrome }) | undefined
  if (typeof existing === 'function' && existing.__zenModuleChrome)
    return existing.__zenModuleChrome

  const stack: string[] = []
  const current = (): string | null => (stack.length ? stack[stack.length - 1] : null)

  /** The page's own value of each global taken over, read as the page would read it. */
  const reads = new Map<string, () => unknown>()
  const pageValueOf = (name: string): unknown => {
    const read = reads.get(name)
    return read ? read() : g[name]
  }

  /**
   * Take over a global of the page's with an accessor: while an extension's module evaluates it
   * answers what `answer` gives for that extension, at every other time the page's own value –
   * read through what the page had (WebView's `chrome` object, the window's `self` getter) and,
   * once the page assigns the name, what it assigned. False when the page had pinned the
   * property.
   */
  const takeOver = (name: string, answer: (id: string) => unknown): boolean => {
    const own = Object.getOwnPropertyDescriptor(win, name)
    if (own && !own.configurable) return false
    // The page's value as the page reads it: an own property (the window's `self` and WebView's
    // `chrome` are both own) or, on a global of another shape, one up the prototype chain.
    let had = own
    for (
      let proto = Object.getPrototypeOf(win) as object | null;
      !had && proto;
      proto = Object.getPrototypeOf(proto) as object | null
    )
      had = Object.getOwnPropertyDescriptor(proto, name)
    let pageValue: unknown = had && 'value' in had ? had.value : undefined
    let pageGet = had?.get
    const pageSet = had?.set
    const pageRead = (): unknown => (pageGet ? pageGet.call(win) : pageValue)
    try {
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: own?.enumerable ?? false,
        get() {
          const id = current()
          if (id !== null) {
            const value = answer(id)
            if (value !== undefined) return value
          }
          return pageRead()
        },
        set(value: unknown) {
          // The page's own `chrome` setter, when it had one, sees the write; the window's setter
          // of a [Replaceable] `self` would put a data property in the accessor's place, so the
          // page's value is kept here instead and answered as assigned.
          if (pageSet && name === 'chrome') pageSet.call(win, value)
          else {
            pageGet = undefined
            pageValue = value
          }
        }
      })
      reads.set(name, pageRead)
      return true
    } catch {
      return false
    }
  }

  const enter = (id: unknown): unknown => {
    const extensionId = String(id)
    stack.push(extensionId)
    const chrome = chromeFor(extensionId)
    return chrome !== undefined ? chrome : pageValueOf('chrome')
  }
  const leave = (id: unknown): void => {
    const extensionId = String(id)
    // The module's own mark, wherever a top-level `await` left it in the order.
    const at = stack.lastIndexOf(extensionId)
    if (at >= 0) stack.splice(at, 1)
  }
  const selfOf = (id: unknown): unknown => {
    const scope = scopeFor?.(String(id))
    return scope !== undefined ? scope : pageValueOf('self')
  }

  const accessor = takeOver('chrome', chromeFor)
  const selfAccessor = scopeFor ? takeOver('self', scopeFor) : false

  const result: ModuleChrome = { accessor, selfAccessor, current }
  const enterFn = enter as ((id: string) => unknown) & { __zenModuleChrome?: ModuleChrome }
  enterFn.__zenModuleChrome = result
  for (const [name, value] of [
    [ENTER, enterFn],
    [LEAVE, leave],
    [SELF, selfOf]
  ] as const) {
    try {
      Object.defineProperty(win, name, {
        value,
        writable: false,
        configurable: false,
        enumerable: false
      })
    } catch {
      /* a second bootstrap of the same world: the first one's stay */
    }
  }
  return result
}

/** How far into a served script the host looks for the webpack chunk's registration. */
export const WEBPACK_CHUNK_HEAD = 512

/**
 * A webpack chunk's registration, as webpack writes it at the top of every non-entry chunk of
 * a `web`-like target: `(self.webpackChunk<name>=self.webpackChunk<name>||[]).push([...`, the
 * global spelled `self`, `globalThis` or `window` by `output.globalObject`; a directive, a
 * comment or a one-line polyfill (`"undefined"!=typeof browser&&(chrome=browser);`) may come
 * first. The same expression is `ExtensionScripts.WEBPACK_CHUNK` on the host.
 */
const WEBPACK_CHUNK =
  /\((self|globalThis|window)\.(webpackChunk\w*)\s*=\s*\1\.\2\s*\|\|\s*\[\]\)\s*\.push\s*\(/

/** Whether the head of a served script is a webpack chunk's registration (see `WEBPACK_CHUNK`). */
export function isWebpackChunk(head: string): boolean {
  return WEBPACK_CHUNK.test(head.slice(0, WEBPACK_CHUNK_HEAD))
}

/** How far into a served module the host looks for a declaration of `chrome` of its own. */
export const MODULE_SCAN_HEAD = 1 << 20

/**
 * A binding named `chrome` the module may declare itself: a declaration keyword before the
 * name, an `import` of it (default, namespace or `as chrome`), or the name alone between the
 * braces or commas of a destructuring pattern or an import list. Read conservatively: a match
 * inside a function body or a string costs the module only the module-scoped binding, a miss
 * would cost it its whole text. The same expression is `ExtensionScripts.OWN_CHROME` on the host.
 */
const OWN_CHROME =
  /(?:^|[^\w$.])(?:(?:let|const|var|class|function)\s+chrome|function\s*\*\s*chrome|import\s+chrome|import\s*\*\s*as\s+chrome|as\s+chrome)(?![\w$])|[{,]\s*chrome\s*(?=[,}]|=(?!=))/

/** Whether the head of a served module declares a `chrome` of its own (see `OWN_CHROME`). */
export function declaresChrome(head: string): boolean {
  return OWN_CHROME.test(head.slice(0, MODULE_SCAN_HEAD))
}

/**
 * The prologue ahead of a served module's text, as the host writes it
 * (`ExtensionScripts.moduleChromeOpen`): the bracket's entry as the module-scoped `chrome`, for
 * a webpack chunk the module-scoped `self` too, and for a module declaring `chrome` itself the
 * bare entry. Guarded, so the same text also runs where the brackets were never installed.
 */
export function moduleOpen(extensionId: string, head = ''): string {
  const id = JSON.stringify(extensionId)
  const chrome = `let chrome=globalThis.${ENTER}?globalThis.${ENTER}(${id}):globalThis.chrome`
  if (isWebpackChunk(head))
    return `${chrome},self=globalThis.${SELF}?globalThis.${SELF}(${id}):globalThis.self;`
  if (declaresChrome(head)) return `globalThis.${ENTER}&&globalThis.${ENTER}(${id});`
  return `${chrome};`
}

/** The epilogue after a served module's text, on a line of its own. */
export function moduleClose(extensionId: string): string {
  const id = JSON.stringify(extensionId)
  return `\n;globalThis.${LEAVE}&&globalThis.${LEAVE}(${id});`
}

/**
 * The served module text with its brackets, as the host wraps it: the prologue shares the first
 * line (line numbers, and so source maps, stay), the epilogue takes a line of its own after
 * whatever the file ended in. Both are guarded, so the same text also runs where the brackets
 * were never installed (a page without the bootstrap, a WebView with isolated worlds).
 */
export function wrapModuleText(text: string, extensionId: string): string {
  return moduleOpen(extensionId, text) + text + moduleClose(extensionId)
}

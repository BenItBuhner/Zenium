/**
 * A `chrome` for the module graph of a content script on a one-realm WebView.
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
 */

export interface ModuleChrome {
  /** Whether the real global's `chrome` became the accessor (false when the page had pinned it). */
  accessor: boolean
  /** Which extension's module evaluates now, or null. */
  current(): string | null
}

const ENTER = '__zenExtModule'
const LEAVE = '__zenExtModuleEnd'

/**
 * Install the module brackets and the `chrome` accessor on `win` (the page's real global), once
 * per global; `chromeFor` answers an attached extension's `chrome` or undefined.
 */
export function installModuleChrome(
  win: object,
  chromeFor: (extensionId: string) => unknown
): ModuleChrome {
  const g = win as Record<string, unknown>
  const existing = g[ENTER] as
    (((id: string) => unknown) & { __zenModuleChrome?: ModuleChrome }) | undefined
  if (typeof existing === 'function' && existing.__zenModuleChrome)
    return existing.__zenModuleChrome

  const stack: string[] = []
  const current = (): string | null => (stack.length ? stack[stack.length - 1] : null)
  const enter = (id: unknown): unknown => {
    const extensionId = String(id)
    stack.push(extensionId)
    return chromeFor(extensionId)
  }
  const leave = (id: unknown): void => {
    const extensionId = String(id)
    // The module's own mark, wherever a top-level `await` left it in the order.
    const at = stack.lastIndexOf(extensionId)
    if (at >= 0) stack.splice(at, 1)
  }

  let accessor = false
  const own = Object.getOwnPropertyDescriptor(win, 'chrome')
  if (!own || own.configurable) {
    // The page's own `chrome` (WebView's object, or nothing) stays what the page sees.
    let pageValue: unknown = own && 'value' in own ? own.value : undefined
    const pageGet = own?.get
    const pageSet = own?.set
    try {
      Object.defineProperty(win, 'chrome', {
        configurable: true,
        enumerable: own?.enumerable ?? false,
        get() {
          const id = current()
          if (id !== null) {
            const chrome = chromeFor(id)
            if (chrome !== undefined) return chrome
          }
          return pageGet ? pageGet.call(win) : pageValue
        },
        set(value: unknown) {
          if (pageSet) pageSet.call(win, value)
          else pageValue = value
        }
      })
      accessor = true
    } catch {
      accessor = false
    }
  }

  const result: ModuleChrome = { accessor, current }
  const enterFn = enter as ((id: string) => unknown) & { __zenModuleChrome?: ModuleChrome }
  enterFn.__zenModuleChrome = result
  for (const [name, value] of [
    [ENTER, enterFn],
    [LEAVE, leave]
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

/**
 * The served module text with its brackets, as the host wraps it: the prologue shares the first
 * line (line numbers, and so source maps, stay), the epilogue takes a line of its own after
 * whatever the file ended in. Both are guarded, so the same text also runs where the brackets
 * were never installed (a page without the bootstrap, a WebView with isolated worlds).
 */
export function wrapModuleText(text: string, extensionId: string): string {
  const id = JSON.stringify(extensionId)
  return (
    `globalThis.__zenExtModule&&globalThis.__zenExtModule(${id});` +
    text +
    `\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd(${id});`
  )
}

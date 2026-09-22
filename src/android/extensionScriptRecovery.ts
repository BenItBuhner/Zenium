import { extensionOrigin } from '@core/extensions/runtime/plan'
import { presentExtensionUrl } from '@core/extensions/runtime/extensionUrls'

/**
 * Extension-origin scripts and stylesheets under the page's Content-Security-Policy.
 *
 * A content script may insert `<script src="chrome.runtime.getURL('x.js')">` or
 * `<link rel="stylesheet" href="chrome.runtime.getURL('x.css')">` into any page: in Chrome an
 * extension's resources are beyond the page's policy (`chrome-extension:` bypasses CSP). The
 * emulated origin, `https://<id>.ext.zenium.invalid`, is an https origin a page's `script-src`
 * or `style-src` refuses like any other, and then the element fires `error` and never runs or
 * applies.
 *
 * The bootstrap listens for that `error` (capture, on the window: `error` does not bubble) in
 * every world that runs an extension's scripts. An element under an attached extension's
 * origin is recovered:
 *
 * - a `<script>` is reported to the host, which runs the file in the main world itself
 *   (`evaluateJavascript` is under no page policy) and answers;
 * - a stylesheet `<link>` is read through the extension's own fetch (the relay's, past the
 *   page's `connect-src`), its relative `url()` references made absolute, and adopted as a
 *   constructed sheet of the document (`document.adoptedStyleSheets`, which no `style-src`
 *   governs, the way Chrome's extension sheets are beyond it).
 *
 * While the host takes the load over, the element's `src` / `href` attribute is re-spelled as
 * Chrome spells it, `chrome-extension://<id>/x.js`: the element has already started, so the
 * attribute changes nothing about loading, and a script that looks itself up by it (Language
 * Reactor's `script[data-lr-nonce][src*="extension://"]`) finds what it finds in Chrome. The
 * element then gets the `load` it expected, or, when the recovery could not (not web-accessible,
 * a subframe, no such file), the attribute back and the `error` it was already firing. The
 * refusal never reaches the extension's own handlers.
 */

/** What the bootstrap lends the recovery: the attached extensions, the bridge and a file read. */
export interface ScriptRecoveryHost {
  /** Ids of the extensions attached to this world at call time. */
  attachedIds(): string[]
  /** Ask the host to run `url` in the main world; it answers through `done(id, error)`. */
  request(id: string, extId: string, url: string): void
  /** Read an extension file's text the way the extension's own `fetch` would (the relay's). */
  readText?(extId: string, url: string): Promise<string>
  error(...args: unknown[]): void
}

/** The little of a `<script>` / `<link>` element and its `error` event the recovery reads. */
export interface ScriptLike {
  tagName?: unknown
  src?: unknown
  href?: unknown
  rel?: unknown
  ownerDocument?: unknown
  getAttribute?(name: string): string | null
  setAttribute?(name: string, value: string): void
  dispatchEvent(event: Event): boolean
}

export interface ErrorEventLike {
  target: unknown
  stopImmediatePropagation(): void
}

export interface ScriptRecovery {
  /** The window's capturing `error` listener. */
  onError(event: ErrorEventLike): void
  /** The host's answer to `request`: `error` null when the file ran in the main world. */
  done(id: string, error: string | null): void
  /** Requests still waiting for the host (tests, diagnostics). */
  pending(): number
}

/** The document's constructed-sheet surface the stylesheet recovery uses. */
interface AdoptingDocument {
  adoptedStyleSheets?: CSSStyleSheet[]
  defaultView?: { CSSStyleSheet?: typeof CSSStyleSheet } | null
}

const RECOVERED = new WeakSet<object>()

export function createScriptRecovery(host: ScriptRecoveryHost): ScriptRecovery {
  const waiting = new Map<string, { script: ScriptLike; url: string }>()
  let seq = 0
  let styles = 0

  const extensionFor = (src: string): string | null => {
    for (const id of host.attachedIds()) if (src.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  /** The attribute Chrome's DOM would show; back to the served one when the recovery fails. */
  const respell = (element: ScriptLike, attribute: string, value: string): void => {
    try {
      element.setAttribute?.(attribute, value)
    } catch {
      /* a frozen element of the page's: the load is still recovered */
    }
  }

  const recoverScript = (script: ScriptLike, src: string, extId: string): void => {
    const id = `s${(seq += 1)}`
    waiting.set(id, { script, url: src })
    respell(script, 'src', presentExtensionUrl(src))
    host.request(id, extId, src)
  }

  const recoverStyle = (link: ScriptLike, href: string, extId: string): void => {
    const read = host.readText
    if (!read) {
      link.dispatchEvent(new Event('error'))
      return
    }
    styles += 1
    respell(link, 'href', presentExtensionUrl(href))
    read(extId, href)
      .then((text) => {
        if (!adoptSheet(link, rebaseCssUrls(text, href)))
          throw new Error('the document takes no constructed stylesheet')
        link.dispatchEvent(new Event('load'))
      })
      .catch((reason: unknown) => {
        host.error(
          `[Zenium] ${href} could not be applied past the page's policy: ${String(reason)}`
        )
        respell(link, 'href', href)
        link.dispatchEvent(new Event('error'))
      })
      .finally(() => {
        styles -= 1
      })
  }

  return {
    onError(event) {
      const target = event.target as ScriptLike | null
      if (!target || typeof target !== 'object' || typeof target.dispatchEvent !== 'function')
        return
      const tag = String(target.tagName).toUpperCase()
      if (tag !== 'SCRIPT' && tag !== 'LINK') return
      // Our own `error`, re-dispatched after the recovery gave up: let it through this time.
      if (RECOVERED.has(target)) return
      if (tag === 'LINK') {
        const rel = typeof target.rel === 'string' ? target.rel : ''
        if (!/\bstylesheet\b/i.test(rel)) return
        const href = typeof target.href === 'string' ? target.href : ''
        const extId = extensionFor(href)
        if (extId === null) return
        RECOVERED.add(target)
        event.stopImmediatePropagation()
        recoverStyle(target, href, extId)
        return
      }
      const src = typeof target.src === 'string' ? target.src : ''
      const extId = extensionFor(src)
      if (extId === null) return
      RECOVERED.add(target)
      event.stopImmediatePropagation()
      recoverScript(target, src, extId)
    },
    done(id, error) {
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      if (error === null) {
        entry.script.dispatchEvent(new Event('load'))
        return
      }
      host.error(`[Zenium] ${entry.url} could not run in the main world: ${error}`)
      respell(entry.script, 'src', entry.url)
      entry.script.dispatchEvent(new Event('error'))
    },
    pending: () => waiting.size + styles
  }
}

/**
 * The sheet's text adopted by the link's document as a constructed stylesheet; false when the
 * document (or its window) has none of that (Chromium before 73), in which case the caller
 * reports the refusal as it stood.
 */
function adoptSheet(link: ScriptLike, css: string): boolean {
  const doc = link.ownerDocument as AdoptingDocument | null | undefined
  const Sheet = doc?.defaultView?.CSSStyleSheet
  if (!doc || typeof Sheet !== 'function' || !Array.isArray(doc.adoptedStyleSheets)) return false
  const sheet = new Sheet()
  if (typeof sheet.replaceSync !== 'function') return false
  sheet.replaceSync(css)
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  return true
}

/**
 * A constructed sheet resolves its `url()` references against the document, not the file: the
 * relative ones are spelled out against the file's URL (fonts beside a font face, images beside
 * a rule) so they load as the `<link>` would have loaded them. `@import` is dropped by
 * `replaceSync` and stays as it is.
 */
export function rebaseCssUrls(css: string, fileUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g,
    (whole: string, quote: string, ref: string): string => {
      const trimmed = ref.trim()
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(trimmed)) return whole
      try {
        return `url(${quote}${new URL(trimmed, fileUrl).href}${quote})`
      } catch {
        return whole
      }
    }
  )
}

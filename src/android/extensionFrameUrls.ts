import { toServedUrl } from '@core/extensions/runtime/extensionUrls'

/**
 * `chrome-extension://<id>/...` written out in an extension page's own DOM.
 *
 * An extension's pages live on the served origin, `https://<id>.ext.zenium.invalid/`
 * (`extensionUrls.ts`), and `runtime.getURL` answers that spelling, so what an extension builds
 * from it loads. What it spells out by hand does not: Read&Write's offscreen document builds its
 * feature frame as `<iframe src="chrome-extension://<its id>/...">`, the id hard-coded, and the
 * WebView has no such scheme. A frame sent there fails as an unknown scheme (Kotlin's
 * `shouldOverrideUrlLoading` sees the sub-frame's navigation but has nowhere to send the frame
 * from there, `ExtensionPageNavigation`), an image or a script never loads.
 *
 * So the page's own elements get the served spelling before the load starts: the URL setters
 * of the loading elements (`iframe.src`, `img.src`, `script.src`, `link.href`, `object.data`,
 * the media elements), `setAttribute`, and a document-start MutationObserver for what the
 * parser or `innerHTML` inserts and for attribute writes that went past the setters. Only a
 * string that spells `chrome-extension://` changes; a `TrustedScriptURL` or any other URL is
 * handed on as it is. `fetch` and `XMLHttpRequest` do the same in `extensionCorsProxy.ts`.
 * Chrome shows the element's `src` as written; here it reads as the served spelling, as
 * `runtime.getURL` does.
 */

/** Per element, the attributes that name a resource it loads. */
const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  IFRAME: ['src'],
  FRAME: ['src'],
  IMG: ['src'],
  SCRIPT: ['src'],
  EMBED: ['src'],
  OBJECT: ['data'],
  VIDEO: ['src'],
  AUDIO: ['src'],
  SOURCE: ['src'],
  TRACK: ['src'],
  INPUT: ['src'],
  LINK: ['href']
}

/** The elements the observer looks at inside an inserted subtree. */
const SELECTOR = Object.keys(URL_ATTRIBUTES).join(',')

/** The URL setters patched, `[interface, property]`. */
const SETTERS: ReadonlyArray<readonly [string, string]> = [
  ['HTMLIFrameElement', 'src'],
  ['HTMLFrameElement', 'src'],
  ['HTMLImageElement', 'src'],
  ['HTMLScriptElement', 'src'],
  ['HTMLEmbedElement', 'src'],
  ['HTMLObjectElement', 'data'],
  ['HTMLMediaElement', 'src'],
  ['HTMLSourceElement', 'src'],
  ['HTMLTrackElement', 'src'],
  ['HTMLInputElement', 'src'],
  ['HTMLLinkElement', 'href']
]

const CHROME_EXTENSION = /^\s*chrome-extension:\/\//i

/** The served spelling of a `chrome-extension://` string; anything else (another URL, a non-string) unchanged. */
export function servedSpelling<T>(value: T): T | string {
  if (typeof value !== 'string' || !CHROME_EXTENSION.test(value)) return value
  return toServedUrl(value.trim())
}

/** Whether `name` (any case) is a URL attribute of `element`. */
export function isUrlAttribute(element: Element, name: string): boolean {
  const names = URL_ATTRIBUTES[element.tagName.toUpperCase()]
  return names !== undefined && names.includes(name.toLowerCase())
}

/**
 * Rewrite the URL attributes of `element` that spell `chrome-extension://`, through `set` (the
 * native `setAttribute`, so the patched one is not re-entered). Returns the attributes changed.
 */
export function rewriteElement(
  element: Element,
  set: (element: Element, name: string, value: string) => void
): string[] {
  const names = URL_ATTRIBUTES[element.tagName.toUpperCase()]
  if (!names) return []
  const changed: string[] = []
  for (const name of names) {
    const value = element.getAttribute(name)
    if (value === null) continue
    const served = servedSpelling(value)
    if (served === value) continue
    set(element, name, served)
    changed.push(name)
  }
  return changed
}

/**
 * Install the rewrite on an extension page's window: the setters, `setAttribute`, and the
 * observer over `doc` (from document start: the observer sees the document's own markup as the
 * parser inserts it). Returns the count of attributes rewritten so far, for tests and stats.
 */
export function installExtensionUrlRewrite(
  win: Window & typeof globalThis,
  doc: Document = win.document
): { rewritten(): number } {
  let count = 0
  const elementProto = win.Element?.prototype
  const nativeSetAttribute: ((name: string, value: string) => void) | undefined =
    elementProto?.setAttribute
  const set = (element: Element, name: string, value: string): void => {
    count += 1
    if (nativeSetAttribute) nativeSetAttribute.call(element, name, value)
    else element.setAttribute(name, value)
  }

  for (const [ctor, property] of SETTERS) {
    const proto = (win as unknown as Record<string, { prototype?: object } | undefined>)[ctor]
      ?.prototype
    if (!proto) continue
    const descriptor = Object.getOwnPropertyDescriptor(proto, property)
    if (!descriptor?.set || !descriptor.configurable) continue
    const nativeSet = descriptor.set
    Object.defineProperty(proto, property, {
      ...descriptor,
      set(this: Element, value: unknown) {
        const served = servedSpelling(value)
        if (served !== value) count += 1
        nativeSet.call(this, served)
      }
    })
  }

  if (elementProto && nativeSetAttribute) {
    elementProto.setAttribute = function setAttribute(
      this: Element,
      name: string,
      value: string
    ): void {
      let next: unknown = value
      if (isUrlAttribute(this, String(name))) {
        next = servedSpelling(value)
        if (next !== value) count += 1
      }
      nativeSetAttribute.call(this, name, next as string)
    }
  }

  if (typeof win.MutationObserver === 'function' && doc) {
    const observer = new win.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const target = record.target
          if (target instanceof win.Element && record.attributeName)
            if (isUrlAttribute(target, record.attributeName)) rewriteElement(target, set)
          continue
        }
        record.addedNodes.forEach((node) => {
          if (!(node instanceof win.Element)) return
          rewriteElement(node, set)
          node.querySelectorAll(SELECTOR).forEach((child) => rewriteElement(child, set))
        })
      }
    })
    observer.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data']
    })
  }

  return { rewritten: () => count }
}

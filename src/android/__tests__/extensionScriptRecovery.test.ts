import { describe, expect, it } from 'vitest'
import {
  createScriptRecovery,
  rebaseCssUrls,
  type ScriptRecoveryHost
} from '../extensionScriptRecovery'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN = `https://${EXT}.ext.zenium.invalid`

/** A `<script>` as the recovery sees it: a tag name, a resolved `src`, its attributes and DOM events. */
class FakeScript extends EventTarget {
  readonly tagName = 'SCRIPT'
  readonly events: string[] = []
  readonly attributes = new Map<string, string>()
  constructor(readonly src: string) {
    super()
    this.attributes.set('src', src)
    this.addEventListener('load', () => this.events.push('load'))
    this.addEventListener('error', () => this.events.push('error'))
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
}

/** A constructed stylesheet as the recovery uses it. */
class FakeSheet {
  text = ''
  replaceSync(css: string): void {
    this.text = css
  }
}

/** A `<link rel=stylesheet>` in a document that adopts constructed sheets. */
class FakeLink extends EventTarget {
  readonly tagName = 'LINK'
  readonly rel = 'stylesheet'
  readonly events: string[] = []
  readonly attributes = new Map<string, string>()
  readonly ownerDocument: {
    adoptedStyleSheets: FakeSheet[]
    defaultView: { CSSStyleSheet: typeof FakeSheet }
  }
  constructor(
    readonly href: string,
    adopting = true
  ) {
    super()
    this.attributes.set('href', href)
    this.ownerDocument = {
      adoptedStyleSheets: [],
      defaultView: {
        CSSStyleSheet: adopting ? FakeSheet : (undefined as unknown as typeof FakeSheet)
      }
    }
    this.addEventListener('load', () => this.events.push('load'))
    this.addEventListener('error', () => this.events.push('error'))
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
}

function errorEvent(target: unknown): {
  target: unknown
  stopImmediatePropagation: () => void
  stopped: boolean
} {
  const event = {
    target,
    stopped: false,
    stopImmediatePropagation() {
      event.stopped = true
    }
  }
  return event
}

function harness(
  ids = [EXT],
  files: Record<string, string> | null = null
): {
  host: ScriptRecoveryHost
  requests: Array<[string, string, string]>
  reads: string[]
  errors: unknown[][]
} {
  const requests: Array<[string, string, string]> = []
  const reads: string[] = []
  const errors: unknown[][] = []
  const host: ScriptRecoveryHost = {
    attachedIds: () => ids,
    request: (id, extId, url) => void requests.push([id, extId, url]),
    error: (...args) => void errors.push(args)
  }
  if (files)
    host.readText = (_extId, url) => {
      reads.push(url)
      const text = files[url]
      return text === undefined
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(text)
    }
  return { host, requests, reads, errors }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('extension-origin scripts the page CSP refused', () => {
  it("reports a refused script of an attached extension to the host and keeps the refusal from the extension's handlers", () => {
    const { host, requests } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/menu-fixer.js`)
    const event = errorEvent(script)
    recovery.onError(event)
    expect(event.stopped).toBe(true)
    expect(requests).toEqual([['s1', EXT, `${ORIGIN}/menu-fixer.js`]])
    expect(recovery.pending()).toBe(1)
    expect(script.events).toEqual([])
    // While the host runs it the element reads as Chrome's DOM would: Language Reactor's page
    // script finds its nonce carrier by `script[data-lr-nonce][src*="extension://"]`.
    expect(script.getAttribute('src')).toBe(`chrome-extension://${EXT}/menu-fixer.js`)
  })

  it('fires load on the element once the host ran the file in the main world', () => {
    const { host } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/inject.js`)
    recovery.onError(errorEvent(script))
    recovery.done('s1', null)
    expect(script.events).toEqual(['load'])
    expect(recovery.pending()).toBe(0)
  })

  it('lets the error through, once, when the host could not run the file', () => {
    const { host, errors } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/private.js`)
    recovery.onError(errorEvent(script))
    recovery.done('s1', 'private.js is not a web-accessible resource')
    expect(script.events).toEqual(['error'])
    // The attribute tells the truth again: the served URL that was refused.
    expect(script.getAttribute('src')).toBe(`${ORIGIN}/private.js`)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toContain('private.js is not a web-accessible resource')
    // The re-dispatched error reaches the window listener again: no second request.
    const again = errorEvent(script)
    recovery.onError(again)
    expect(again.stopped).toBe(false)
    expect(recovery.pending()).toBe(0)
  })

  it("ignores the page's own scripts, other extensions' origins and non-script targets", () => {
    const { host, requests } = harness()
    const recovery = createScriptRecovery(host)
    const page = errorEvent(new FakeScript('https://m.youtube.com/s/player/base.js'))
    recovery.onError(page)
    const other = errorEvent(
      new FakeScript('https://ponmlkjihgfedcbaponmlkjihgfedcb.ext.zenium.invalid/a.js')
    )
    recovery.onError(other)
    const image = Object.assign(new EventTarget(), { tagName: 'IMG', src: `${ORIGIN}/icon.png` })
    recovery.onError(errorEvent(image))
    recovery.onError(errorEvent(null))
    expect(page.stopped).toBe(false)
    expect(other.stopped).toBe(false)
    expect(requests).toEqual([])
  })

  it('ignores an answer it never asked for', () => {
    const { host, errors } = harness()
    const recovery = createScriptRecovery(host)
    expect(() => recovery.done('s9', 'late')).not.toThrow()
    expect(errors).toEqual([])
    expect(recovery.pending()).toBe(0)
  })
})

describe('extension-origin stylesheets the page CSP refused', () => {
  it("reads a refused <link rel=stylesheet> through the extension's fetch, adopts it as a constructed sheet with its url()s made absolute, and fires load", async () => {
    const css =
      '@font-face{font-family:M;src:url(fonts/m.woff2)} .x{background:url("/img/a.png")} .y{background:url(data:image/png;base64,AA)}'
    const { host, reads, requests } = harness([EXT], { [`${ORIGIN}/css/fonts/manrope.css`]: css })
    const recovery = createScriptRecovery(host)
    const link = new FakeLink(`${ORIGIN}/css/fonts/manrope.css`)
    const event = errorEvent(link)
    recovery.onError(event)
    expect(event.stopped).toBe(true)
    expect(recovery.pending()).toBe(1)
    // Steam Inventory Helper's sheets: no main-world script request, a file read instead.
    expect(requests).toEqual([])
    expect(reads).toEqual([`${ORIGIN}/css/fonts/manrope.css`])
    expect(link.getAttribute('href')).toBe(`chrome-extension://${EXT}/css/fonts/manrope.css`)
    await tick()
    expect(link.events).toEqual(['load'])
    expect(recovery.pending()).toBe(0)
    const sheets = link.ownerDocument.adoptedStyleSheets
    expect(sheets).toHaveLength(1)
    expect(sheets[0].text).toBe(
      `@font-face{font-family:M;src:url(${ORIGIN}/css/fonts/fonts/m.woff2)} .x{background:url("${ORIGIN}/img/a.png")} .y{background:url(data:image/png;base64,AA)}`
    )
  })

  it('lets the error through, the href back, when the file cannot be read or the document adopts no sheet', async () => {
    const { host, errors } = harness([EXT], {})
    const recovery = createScriptRecovery(host)
    const missing = new FakeLink(`${ORIGIN}/gone.css`)
    recovery.onError(errorEvent(missing))
    await tick()
    expect(missing.events).toEqual(['error'])
    expect(missing.getAttribute('href')).toBe(`${ORIGIN}/gone.css`)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toContain('gone.css')
    const again = errorEvent(missing)
    recovery.onError(again)
    expect(again.stopped).toBe(false)

    const { host: plain } = harness([EXT], { [`${ORIGIN}/a.css`]: '.a{}' })
    const old = new FakeLink(`${ORIGIN}/a.css`, false)
    createScriptRecovery(plain).onError(errorEvent(old))
    await tick()
    expect(old.events).toEqual(['error'])
  })

  it("ignores the page's own stylesheets, other rels and a host without a file read", () => {
    const { host, reads } = harness([EXT], {})
    const recovery = createScriptRecovery(host)
    const page = errorEvent(
      new FakeLink('https://cdn.fastly.steamstatic.com/public/shared/css/motiva_sans.css')
    )
    recovery.onError(page)
    const icon = Object.assign(new FakeLink(`${ORIGIN}/icon.png`), { rel: 'icon' })
    const iconEvent = errorEvent(icon)
    recovery.onError(iconEvent)
    expect(page.stopped).toBe(false)
    expect(iconEvent.stopped).toBe(false)
    expect(reads).toEqual([])
    // No read lent (an extension page's bootstrap): the refusal stands as it was.
    const noRead = createScriptRecovery(harness().host)
    const link = new FakeLink(`${ORIGIN}/a.css`)
    noRead.onError(errorEvent(link))
    expect(link.events).toEqual(['error'])
  })

  /** A `<script type="module">` the retry creates: its fields, its place in the document and its events. */
  class FakeModuleScript extends EventTarget {
    readonly tagName = 'SCRIPT'
    type = ''
    nonce = ''
    src = ''
    connected = false
    constructor(readonly doc: FakeDocument) {
      super()
    }
    remove(): void {
      this.connected = false
      this.doc.scripts = this.doc.scripts.filter((s) => s !== this)
    }
    getAttribute(): string | null {
      return null
    }
    setAttribute(name: string, value: string): void {
      if (name === 'src') this.src = value
    }
  }

  /** flipkart.com's document as the retry sees it: nonced scripts of the page's, a head to append to. */
  class FakeDocument {
    scripts: Array<{ src: string; nonce: string }> = []
    created: FakeModuleScript[] = []
    refuseSrc = false
    readonly head = {
      appendChild: (node: object): unknown => {
        const script = node as FakeModuleScript
        script.connected = true
        this.scripts.push(script)
        return node
      }
    }
    constructor(nonce: string | null = 'nonce-of-the-page') {
      // The content attribute is hidden once the element is connected; the IDL attribute keeps it.
      if (nonce !== null)
        this.scripts.push({ src: 'https://www.flipkart.com/static/app.js', nonce })
      this.scripts.push({ src: '', nonce: '' })
    }
    createElement(): FakeModuleScript {
      const script = new FakeModuleScript(this)
      if (this.refuseSrc)
        Object.defineProperty(script, 'src', {
          set() {
            throw new TypeError("This document requires 'TrustedScriptURL' assignment.")
          }
        })
      this.created.push(script)
      return script
    }
  }

  const violation = (
    blockedURI: string,
    extra: Record<string, unknown> = {}
  ): {
    blockedURI: string
    effectiveDirective: string
    violatedDirective: string
    disposition: string
  } => ({
    blockedURI,
    effectiveDirective: 'script-src-elem',
    violatedDirective: 'script-src',
    disposition: 'enforce',
    ...extra
  })

  it("fetches a refused module graph again under the page's own nonce where the real global carries the extension's chrome (Buyhatke on flipkart.com)", () => {
    const { host, requests, errors } = harness()
    const doc = new FakeDocument()
    host.document = doc
    host.pageModules = true
    const recovery = createScriptRecovery(host)
    const entry = `${ORIGIN}/assets/indexedDb.js-1a1GZY9p.js`
    recovery.onViolation(violation(entry))
    expect(doc.created).toHaveLength(1)
    const script = doc.created[0]!
    expect(script).toMatchObject({
      type: 'module',
      nonce: 'nonce-of-the-page',
      src: entry,
      connected: true
    })
    expect(recovery.pending()).toBe(1)
    // Its `error` is not a classic script for the host to run; the graph loading is the retry.
    const own = errorEvent(script)
    recovery.onError(own)
    expect(own.stopped).toBe(false)
    expect(requests).toEqual([])
    // The same entry refused again (a second loader, a second frame boot) is not retried twice.
    recovery.onViolation(violation(entry))
    expect(doc.created).toHaveLength(1)
    // Loaded: the element is gone, nothing pending, nothing reported.
    script.dispatchEvent(new Event('load'))
    expect(script.connected).toBe(false)
    expect(recovery.pending()).toBe(0)
    expect(errors).toEqual([])
    // Another entry of the same extension: its own retry.
    recovery.onViolation(violation(`${ORIGIN}/assets/addToCart.js-7VOB0Zfo.js`))
    expect(doc.created).toHaveLength(2)
    expect(doc.created[1]!.src).toBe(`${ORIGIN}/assets/addToCart.js-7VOB0Zfo.js`)
    // The retry itself refused (the nonce not the policy's after all): reported, element gone.
    doc.created[1]!.dispatchEvent(new Event('error'))
    expect(recovery.pending()).toBe(0)
    expect(doc.created[1]!.connected).toBe(false)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toContain('addToCart.js-7VOB0Zfo.js')
    expect(String(errors[0]?.[0])).toContain('nonce')
  })

  it("leaves the page's own scripts, a classic <script src> of the extension's, other directives and a report-only policy alone", () => {
    const { host } = harness()
    const doc = new FakeDocument()
    host.document = doc
    host.pageModules = true
    const recovery = createScriptRecovery(host)
    // The page's own refused script, an image, a report-only policy: not the extension's module.
    recovery.onViolation(violation('https://cdn.example.com/vendor.js'))
    recovery.onViolation(
      violation(`${ORIGIN}/img/logo.png`, {
        effectiveDirective: 'img-src',
        violatedDirective: 'img-src'
      })
    )
    recovery.onViolation(violation(`${ORIGIN}/assets/a.js`, { disposition: 'report' }))
    recovery.onViolation(violation(`${ORIGIN}/frame.html`, { effectiveDirective: 'frame-src' }))
    recovery.onViolation({ blockedURI: `${ORIGIN}/assets/b.js` } as never)
    expect(doc.created).toEqual([])
    // A classic `<script src>` of the extension's the page refused: in the document, so the
    // element's own `error` recovers it (the host runs it in the main world) and no module is made.
    const classic = new FakeScript(`${ORIGIN}/menu-fixer.js`)
    doc.scripts.push({ src: classic.src, nonce: '' })
    recovery.onViolation(violation(classic.src))
    expect(doc.created).toEqual([])
    // Chrome's console spelling of a fallback: `violatedDirective` alone, the directive's whole text.
    recovery.onViolation({
      blockedURI: `${ORIGIN}/assets/c.js`,
      violatedDirective: "script-src 'nonce-4ehbChzSAcmrFde4ZyGokp' 'unsafe-eval'",
      disposition: 'enforce'
    })
    expect(doc.created).toHaveLength(1)
    expect(doc.created[0]!.src).toBe(`${ORIGIN}/assets/c.js`)
  })

  it('records the refusal, and retries nothing, in an isolated world, on a page without a nonce, and under Trusted Types without the shield', () => {
    // An isolated world (Chromium 146+): the module would evaluate in the world, whose policy is
    // the document's, and one of the page's world finds no `chrome`: recorded, not a failure.
    const world = harness()
    const warned: unknown[][] = []
    world.host.document = new FakeDocument()
    world.host.pageModules = false
    world.host.warn = (...args) => void warned.push(args)
    createScriptRecovery(world.host).onViolation(violation(`${ORIGIN}/assets/a.js`))
    expect((world.host.document as FakeDocument).created).toEqual([])
    expect(world.errors).toEqual([])
    expect(warned).toHaveLength(1)
    expect(String(warned[0]?.[0])).toContain('isolated world')
    // Without a `warn` the notice goes to `error`.
    const plain = harness()
    plain.host.document = new FakeDocument()
    createScriptRecovery(plain.host).onViolation(violation(`${ORIGIN}/assets/a.js`))
    expect(plain.errors).toHaveLength(1)
    // A hash-only or host-only policy lends no nonce: nothing to retry with.
    const noNonce = harness()
    noNonce.host.document = new FakeDocument(null)
    noNonce.host.pageModules = true
    createScriptRecovery(noNonce.host).onViolation(violation(`${ORIGIN}/assets/a.js`))
    expect((noNonce.host.document as FakeDocument).created).toEqual([])
    expect(noNonce.errors).toHaveLength(1)
    expect(String(noNonce.errors[0]?.[0])).toContain('lends no nonce')
    // An enforcing Trusted Types page refuses the `src` string: reported, no element inserted.
    const trusted = harness()
    const doc = new FakeDocument()
    doc.refuseSrc = true
    trusted.host.document = doc
    trusted.host.pageModules = true
    const recovery = createScriptRecovery(trusted.host)
    recovery.onViolation(violation(`${ORIGIN}/assets/a.js`))
    expect(doc.created[0]!.connected).toBe(false)
    expect(recovery.pending()).toBe(0)
    expect(String(trusted.errors[0]?.[0])).toContain('TrustedScriptURL')
    // No document lent (an extension page's bootstrap): nothing happens.
    const none = harness()
    none.host.pageModules = true
    createScriptRecovery(none.host).onViolation(violation(`${ORIGIN}/assets/a.js`))
    expect(none.errors).toEqual([])
  })

  it('rebaseCssUrls leaves absolute, fragment, protocol-relative and data references alone', () => {
    const out = rebaseCssUrls(
      'a{b:url(x.png) url(\'../y.png\') url("https://h/z.png") url(#frag) url(//cdn/w.png) url( sub/v.png )}',
      `${ORIGIN}/css/site.css`
    )
    expect(out).toBe(
      `a{b:url(${ORIGIN}/css/x.png) url('${ORIGIN}/y.png') url("https://h/z.png") url(#frag) url(//cdn/w.png) url(${ORIGIN}/css/sub/v.png)}`
    )
  })
})

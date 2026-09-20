// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  installExtensionUrlRewrite,
  isUrlAttribute,
  rewriteElement,
  servedSpelling
} from '../extensionFrameUrls'

const ID = 'inoeonmfapjbbkmdafoankkfajkcphgd'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'
const SERVED = `https://${ID}.ext.zenium.invalid`

// One window for the file, as one page has one bootstrap: the setters are patched once and one
// observer watches; every test starts on an empty body and counts the rewrites it caused. The
// document loads nothing (a served URL resolves nowhere here).
const win = window as Window & typeof globalThis
const settings = (win as unknown as { happyDOM: { settings: Record<string, unknown> } }).happyDOM
  .settings
settings.disableJavaScriptFileLoading = true
settings.disableCSSFileLoading = true
settings.disableIframePageLoading = true
settings.handleDisabledFileLoadingAsSuccess = true
const installed = installExtensionUrlRewrite(win)

function page(): { win: Window & typeof globalThis; count: () => number } {
  document.body.innerHTML = ''
  const before = installed.rewritten()
  return { win, count: () => installed.rewritten() - before }
}

/** The observer delivers on a microtask. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('servedSpelling', () => {
  it('maps Chrome spelling of an extension URL to the served origin, whatever the case or leading space', () => {
    expect(servedSpelling(`chrome-extension://${ID}/feature/toolbar.html?x=1#y`)).toBe(
      `${SERVED}/feature/toolbar.html?x=1#y`
    )
    expect(servedSpelling(`  Chrome-Extension://${ID.toUpperCase()}`)).toBe(`${SERVED}/`)
  })

  it('leaves every other value alone: other URLs, non-strings, trusted types', () => {
    expect(servedSpelling(`${SERVED}/a.js`)).toBe(`${SERVED}/a.js`)
    expect(servedSpelling('https://example.com/x')).toBe('https://example.com/x')
    expect(servedSpelling('chrome-extension://not-an-id/x')).toBe('chrome-extension://not-an-id/x')
    const trusted = { toString: () => `chrome-extension://${ID}/x.js` }
    expect(servedSpelling(trusted)).toBe(trusted)
    expect(servedSpelling(null)).toBe(null)
  })
})

describe('isUrlAttribute', () => {
  it('names the loading attribute of each element, not an anchor href', () => {
    expect(isUrlAttribute(document.createElement('iframe'), 'SRC')).toBe(true)
    expect(isUrlAttribute(document.createElement('link'), 'href')).toBe(true)
    expect(isUrlAttribute(document.createElement('object'), 'data')).toBe(true)
    expect(isUrlAttribute(document.createElement('a'), 'href')).toBe(false)
    expect(isUrlAttribute(document.createElement('iframe'), 'name')).toBe(false)
  })
})

describe('rewriteElement', () => {
  it('rewrites the URL attributes that spell chrome-extension:// and reports them', () => {
    // Parsed detached from the document: no observer watches it and no setter ran.
    const holder = document.createElement('div')
    holder.innerHTML = `<iframe src="chrome-extension://${ID}/feature.html" name="feature"></iframe>`
    const frame = holder.firstElementChild as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`chrome-extension://${ID}/feature.html`)
    const set = (el: Element, name: string, value: string): void => el.setAttribute(name, value)
    expect(rewriteElement(frame, set)).toEqual(['src'])
    expect(frame.getAttribute('src')).toBe(`${SERVED}/feature.html`)
    expect(frame.getAttribute('name')).toBe('feature')
    expect(rewriteElement(frame, set)).toEqual([])
    expect(rewriteElement(document.createElement('div'), set)).toEqual([])
  })
})

describe('installExtensionUrlRewrite', () => {
  it("Read&Write's frame: a literal chrome-extension:// src set through the property loads from the served origin", () => {
    const { win, count } = page()
    const frame = win.document.createElement('iframe')
    frame.src = `chrome-extension://${ID}/rw/toolbar.html`
    expect(frame.getAttribute('src')).toBe(`${SERVED}/rw/toolbar.html`)
    expect(count()).toBe(1)
  })

  it('the same through setAttribute, and another extension keeps its own id', () => {
    const { win, count } = page()
    const img = win.document.createElement('img')
    img.setAttribute('src', `chrome-extension://${OTHER}/icon.png`)
    expect(img.getAttribute('src')).toBe(`https://${OTHER}.ext.zenium.invalid/icon.png`)
    const anchor = win.document.createElement('a')
    anchor.setAttribute('href', `chrome-extension://${ID}/options.html`)
    expect(anchor.getAttribute('href')).toBe(`chrome-extension://${ID}/options.html`)
    expect(count()).toBe(1)
  })

  it('markup the parser inserts (innerHTML) is rewritten by the observer, nested elements included', async () => {
    // Elements the test document does not try to load (an iframe or a script would); the
    // observer's path is the same for every element of the table.
    const { win, count } = page()
    win.document.body.innerHTML =
      `<div><img src="chrome-extension://${ID}/a.png">` +
      `<video><source src="chrome-extension://${ID}/b.mp4"></video>` +
      `<object data="chrome-extension://${ID}/c.pdf"></object>` +
      `<a href="chrome-extension://${ID}/d.html">d</a></div>`
    await settle()
    expect(win.document.querySelector('img')?.getAttribute('src')).toBe(`${SERVED}/a.png`)
    expect(win.document.querySelector('source')?.getAttribute('src')).toBe(`${SERVED}/b.mp4`)
    expect(win.document.querySelector('object')?.getAttribute('data')).toBe(`${SERVED}/c.pdf`)
    expect(win.document.querySelector('a')?.getAttribute('href')).toBe(
      `chrome-extension://${ID}/d.html`
    )
    expect(count()).toBe(3)
  })

  it('an attribute written past the setters (setAttributeNS) is rewritten by the observer', async () => {
    const { win, count } = page()
    const img = win.document.createElement('img')
    win.document.body.appendChild(img)
    img.setAttributeNS(null, 'src', `chrome-extension://${ID}/late.png`)
    await settle()
    expect(img.getAttribute('src')).toBe(`${SERVED}/late.png`)
    expect(count()).toBe(1)
  })

  it('served and web URLs are untouched, so nothing else the page loads changes', () => {
    const { win, count } = page()
    const frame = win.document.createElement('iframe')
    frame.src = `${SERVED}/already.html`
    const img = win.document.createElement('img')
    img.src = 'https://example.com/x.png'
    expect(frame.getAttribute('src')).toBe(`${SERVED}/already.html`)
    expect(img.getAttribute('src')).toBe('https://example.com/x.png')
    expect(count()).toBe(0)
  })
})

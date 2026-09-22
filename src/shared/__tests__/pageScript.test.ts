// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  fullscreenVideoOf,
  installFullscreenReporter,
  installPageScript,
  isActivatingEvent,
  type PageScriptMessage,
  type PageScriptTransport
} from '../pageScript'

/** happy-dom lets a test mark an event as trusted; browsers only do so for real input. */
function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true, configurable: true })
  return e
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

function install(reportBlockedPopups: boolean): PageScriptMessage[] {
  const sent: PageScriptMessage[] = []
  const transport: PageScriptTransport = {
    send: (m) => {
      sent.push(m)
    },
    onFlags: () => undefined,
    reportBlockedPopups
  }
  installPageScript(transport)
  return sent
}

describe('isActivatingEvent', () => {
  it('counts trusted presses, taps and ordinary keys; never script-made or modifier events', () => {
    expect(isActivatingEvent(new Event('pointerdown'))).toBe(false)
    expect(isActivatingEvent(trusted(new Event('pointerdown')))).toBe(true)
    expect(isActivatingEvent(trusted(new Event('mousedown')))).toBe(true)
    expect(isActivatingEvent(trusted(new Event('touchend')))).toBe(true)
    expect(isActivatingEvent(trusted(new Event('mousemove')))).toBe(false)
    expect(isActivatingEvent(trusted(new Event('scroll')))).toBe(false)
    expect(isActivatingEvent(trusted(new KeyboardEvent('keydown', { key: 'a' })))).toBe(true)
    expect(isActivatingEvent(trusted(new KeyboardEvent('keydown', { key: 'Enter' })))).toBe(true)
    for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])
      expect(isActivatingEvent(trusted(new KeyboardEvent('keydown', { key })))).toBe(false)
  })
})

describe('page script: activation and blocked pop-ups', () => {
  beforeEach(() => {
    setUserActivation(false)
  })

  it('reports a trusted gesture to the browser, at most a few times a second', () => {
    const sent = install(false)
    window.dispatchEvent(new Event('pointerdown'))
    expect(sent).toEqual([])
    window.dispatchEvent(trusted(new Event('pointerdown', { bubbles: true })))
    window.dispatchEvent(trusted(new Event('mousedown', { bubbles: true })))
    expect(sent).toEqual([{ type: 'activation' }])
  })

  it('lists a window.open the engine refused while the page had no activation', () => {
    const originalOpen = window.open
    window.open = () => null
    try {
      const sent = install(true)
      window.open('/next?x=1', '_blank')
      expect(sent).toEqual([
        { type: 'popup-blocked', url: new URL('/next?x=1', location.href).href }
      ])
      // The same null during activation is a noopener window that did open: not a block.
      setUserActivation(true)
      window.open('https://a.example/', '_blank', 'noopener')
      expect(sent.length).toBe(1)
    } finally {
      window.open = originalOpen
    }
  })

  it('leaves a window that did open alone and stays out of the way when not asked', () => {
    const originalOpen = window.open
    const opened = {} as Window
    window.open = () => opened
    try {
      const sent = install(true)
      expect(window.open('https://b.example/')).toBe(opened)
      expect(sent).toEqual([])
    } finally {
      window.open = originalOpen
    }
    window.open = () => null
    try {
      const before = window.open
      install(false)
      expect(window.open).toBe(before)
    } finally {
      window.open = originalOpen
    }
  })
})

describe('page script: OpenSearch discovery', () => {
  function link(rel: string, type: string, href: string, title?: string): HTMLLinkElement {
    const el = document.createElement('link')
    el.setAttribute('rel', rel)
    if (type) el.setAttribute('type', type)
    el.setAttribute('href', href)
    if (title) el.setAttribute('title', title)
    document.head.appendChild(el)
    return el
  }

  function installDiscovery(discoverSearchEngines: boolean): PageScriptMessage[] {
    const sent: PageScriptMessage[] = []
    installPageScript({
      send: (m) => void sent.push(m),
      onFlags: () => undefined,
      discoverSearchEngines
    })
    return sent.filter((m) => m.type === 'opensearch')
  }

  beforeEach(() => {
    document.head.innerHTML = ''
  })

  it('posts the first description link once, resolved, with its title; the XML stays with the browser', () => {
    link('search', 'text/html', '/search', 'Site search')
    link(
      'SEARCH',
      'application/opensearchdescription+xml; charset=utf-8',
      '/opensearch.xml',
      ' Forum '
    )
    link('search', 'application/opensearchdescription+xml', '/second.xml', 'Second')
    const sent = installDiscovery(true)
    expect(sent).toEqual([
      { type: 'opensearch', url: new URL('/opensearch.xml', location.href).href, title: 'Forum' }
    ])
    // The load event takes one more look for late links, but a posted document posts no more.
    window.dispatchEvent(new Event('load'))
    expect(sent.length).toBe(1)
  })

  it('posts nothing without a description link, a non-http link, or when the host did not ask', () => {
    link('search', 'text/html', '/search')
    link('search', 'application/opensearchdescription+xml', 'javascript:void(0)')
    expect(installDiscovery(true)).toEqual([])
    link('search', 'application/opensearchdescription+xml', '/opensearch.xml')
    expect(installDiscovery(false)).toEqual([])
    expect(installDiscovery(true).length).toBe(1)
  })
})

describe('page script: the PDF viewer relay', () => {
  const report = {
    state: 'ready',
    pageCount: 3,
    page: 1,
    zoom: 1,
    fit: 'width',
    title: null,
    find: null,
    outline: []
  }

  function post(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data, source: window }))
  }

  it('relays the viewer’s report with the document’s token, from whatever origin the document runs under', () => {
    const messages = install(false)
    post({ zeniumPdf: report, zeniumPdfToken: 'tok-1' })
    // The document's token under its own name: `token` is the Android bridge's session token.
    expect(messages.filter((m) => m.type === 'pdf')).toEqual([
      { type: 'pdf', pdf: report, pdfToken: 'tok-1' }
    ])
  })

  it('relays nothing without a token, nothing that is no report, and nothing from another window', () => {
    const messages = install(false)
    post({ zeniumPdf: report })
    post({ zeniumPdf: { ...report, state: 'odd' }, zeniumPdfToken: 'tok-1' })
    window.dispatchEvent(
      new MessageEvent('message', { data: { zeniumPdf: report, zeniumPdfToken: 'tok-1' } })
    )
    expect(messages.filter((m) => m.type === 'pdf')).toEqual([])
  })
})

describe('page script: the fullscreen video report (MED-01)', () => {
  /** A video with a natural size (happy-dom's has none): the properties the reporter reads. */
  function video(width: number, height: number): HTMLVideoElement {
    const v = document.createElement('video')
    Object.defineProperty(v, 'videoWidth', { value: width, configurable: true, writable: true })
    Object.defineProperty(v, 'videoHeight', { value: height, configurable: true, writable: true })
    return v
  }

  function fullscreen(element: Element | null): void {
    Object.defineProperty(document, 'fullscreenElement', { value: element, configurable: true })
    document.dispatchEvent(new Event('fullscreenchange'))
  }

  function install(): PageScriptMessage[] {
    const sent: PageScriptMessage[] = []
    installFullscreenReporter({
      send: (m) => {
        sent.push(m)
      }
    })
    return sent
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    fullscreen(null)
  })

  it('reports the fullscreen video with its natural size, and the end of fullscreen', () => {
    const sent = install()
    const v = video(1920, 1080)
    document.body.appendChild(v)
    fullscreen(v)
    expect(sent).toEqual([
      { type: 'fullscreen', active: true, videoWidth: 1920, videoHeight: 1080 }
    ])
    fullscreen(null)
    expect(sent[1]).toEqual({ type: 'fullscreen', active: false, videoWidth: 0, videoHeight: 0 })
  })

  it("finds the video inside a player's wrapper, preferring one with a size", () => {
    const wrapper = document.createElement('div')
    const poster = video(0, 0)
    const main = video(1080, 1920)
    wrapper.append(poster, main)
    document.body.appendChild(wrapper)
    expect(fullscreenVideoOf(wrapper)).toBe(main)
    expect(fullscreenVideoOf(main)).toBe(main)
    expect(fullscreenVideoOf(document.createElement('canvas'))).toBeNull()
    const sent = install()
    fullscreen(wrapper)
    expect(sent).toEqual([
      { type: 'fullscreen', active: true, videoWidth: 1080, videoHeight: 1920 }
    ])
  })

  it('reports an element without a video as 0 × 0, so the screen is left alone', () => {
    const sent = install()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    fullscreen(canvas)
    expect(sent).toEqual([{ type: 'fullscreen', active: true, videoWidth: 0, videoHeight: 0 }])
  })

  it('reports again when a video fullscreen before its metadata learns its size', () => {
    const sent = install()
    const v = video(0, 0)
    document.body.appendChild(v)
    fullscreen(v)
    expect(sent).toEqual([{ type: 'fullscreen', active: true, videoWidth: 0, videoHeight: 0 }])
    Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true })
    v.dispatchEvent(new Event('loadedmetadata'))
    expect(sent[1]).toEqual({
      type: 'fullscreen',
      active: true,
      videoWidth: 1280,
      videoHeight: 720
    })
    // Metadata arriving after fullscreen ended says nothing more.
    fullscreen(null)
    v.dispatchEvent(new Event('loadedmetadata'))
    expect(sent).toHaveLength(3)
  })

  it('is wired by the transport flag alone', () => {
    const sent: PageScriptMessage[] = []
    installPageScript({ send: (m) => void sent.push(m), onFlags: () => undefined })
    const v = video(1920, 1080)
    document.body.appendChild(v)
    fullscreen(v)
    expect(sent.filter((m) => m.type === 'fullscreen')).toEqual([])
    installPageScript({
      send: (m) => void sent.push(m),
      onFlags: () => undefined,
      reportFullscreen: true
    })
    fullscreen(v)
    expect(sent.filter((m) => m.type === 'fullscreen')).toHaveLength(1)
  })
})

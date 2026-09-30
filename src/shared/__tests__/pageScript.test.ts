// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  fullscreenVideoOf,
  installFullscreenReporter,
  installPageScript,
  isActivatingEvent,
  manifestSubset,
  type PageScriptMessage,
  type PageScriptTransport
} from '../pageScript'
import { parseWebAppManifest, type WebAppInfo } from '../webApp'

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
    outline: [],
    form: { fields: 0, modified: false }
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
      { type: 'fullscreen', active: true, video: true, videoWidth: 1920, videoHeight: 1080 }
    ])
    fullscreen(null)
    expect(sent[1]).toEqual({
      type: 'fullscreen',
      active: false,
      video: false,
      videoWidth: 0,
      videoHeight: 0
    })
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
      { type: 'fullscreen', active: true, video: true, videoWidth: 1080, videoHeight: 1920 }
    ])
  })

  it('reports an element without a video as none, 0 × 0, so the screen is left alone and the way out is told (MED-03)', () => {
    const sent = install()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    fullscreen(canvas)
    expect(sent).toEqual([
      { type: 'fullscreen', active: true, video: false, videoWidth: 0, videoHeight: 0 }
    ])
  })

  it('reports again when a video fullscreen before its metadata learns its size', () => {
    const sent = install()
    const v = video(0, 0)
    document.body.appendChild(v)
    fullscreen(v)
    // A video all the same, its size not known yet: no way-out toast for it, no turn of the screen.
    expect(sent).toEqual([
      { type: 'fullscreen', active: true, video: true, videoWidth: 0, videoHeight: 0 }
    ])
    Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true })
    v.dispatchEvent(new Event('loadedmetadata'))
    expect(sent[1]).toEqual({
      type: 'fullscreen',
      active: true,
      video: true,
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

describe("Roll's relay on a web page (ERR-03)", () => {
  it('is not installed off Zenium’s own scheme: a game message on a web page reaches no browser', async () => {
    expect(location.protocol).toBe('http:')
    const sent = install(false)
    window.postMessage({ zeniumGame: { ask: 'best' } }, '*')
    window.postMessage({ zeniumGame: { best: 42 } }, '*')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.filter((m) => m.type === 'game')).toEqual([])
  })
})

describe('page script: the manifest subset the bridge carries (MW-63, share_target)', () => {
  const DOC = 'https://app.example.com/tools/editor?mode=new#top'
  const MANIFEST = 'https://app.example.com/tools/manifest.webmanifest'

  /** The reader's view of a manifest, straight and through the subset. */
  function bothWays(json: Record<string, unknown>): {
    straight: WebAppInfo | null
    viaBridge: WebAppInfo | null
  } {
    return {
      straight: parseWebAppManifest(json, MANIFEST, DOC),
      viaBridge: parseWebAppManifest(manifestSubset(json), MANIFEST, DOC)
    }
  }

  it('carries a share_target with exactly its bounded fields, beside the strings and icons it always carried', () => {
    const subset = manifestSubset({
      name: 'Field Notes',
      short_name: 'Notes',
      start_url: '/tools/notes/',
      icons: [{ src: 'icon.png', sizes: '192x192', type: 'image/png', purpose: 'any', weight: 3 }],
      share_target: {
        action: '/tools/notes/new',
        method: 'POST',
        enctype: 'multipart/form-data',
        params: {
          title: 'subject',
          text: 'body',
          url: 'link',
          files: [
            { name: 'pictures', accept: ['image/*', '.png'], required: true },
            { name: 'doc', accept: '.txt' }
          ],
          extra: 'field'
        },
        target: '_blank'
      },
      related_applications: [{ platform: 'play' }]
    })
    expect(subset).toEqual({
      name: 'Field Notes',
      short_name: 'Notes',
      start_url: '/tools/notes/',
      icons: [{ src: 'icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' }],
      share_target: {
        action: '/tools/notes/new',
        method: 'POST',
        enctype: 'multipart/form-data',
        params: {
          title: 'subject',
          text: 'body',
          url: 'link',
          files: [
            { name: 'pictures', accept: ['image/*', '.png'] },
            { name: 'doc', accept: '.txt' }
          ]
        }
      }
    })
    // Exactly those members: nothing the reader does not take rides along.
    expect(subset?.share_target).toStrictEqual({
      action: '/tools/notes/new',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'subject',
        text: 'body',
        url: 'link',
        files: [
          { name: 'pictures', accept: ['image/*', '.png'] },
          { name: 'doc', accept: '.txt' }
        ]
      }
    })
  })

  it('cuts an over-long action, token and field name, and over-count files and accept entries, at the caps', () => {
    const subset = manifestSubset({
      name: 'App',
      share_target: {
        action: 'https://app.example.com/tools/' + 'a'.repeat(3000),
        method: 'p'.repeat(100),
        enctype: 'e'.repeat(100),
        params: {
          title: 't'.repeat(300),
          text: 'x'.repeat(128),
          files: Array.from({ length: 10 }, (_, i) => ({
            name: `f${i}`.padEnd(200, 'n'),
            accept: Array.from({ length: 20 }, (_, j) => `.${j}`.padEnd(200, 'a'))
          }))
        }
      }
    })
    const target = subset?.share_target as {
      action: string
      method: string
      enctype: string
      params: { title: string; text: string; files: Array<{ name: string; accept: string[] }> }
    }
    expect(target.action).toHaveLength(2048)
    expect(target.action.startsWith('https://app.example.com/tools/aaa')).toBe(true)
    expect(target.method).toHaveLength(64)
    expect(target.enctype).toHaveLength(64)
    expect(target.params.title).toHaveLength(128)
    expect(target.params.text).toHaveLength(128)
    expect(target.params.files).toHaveLength(8)
    expect(target.params.files.map((f) => f.name.slice(0, 2))).toEqual([
      'f0',
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7'
    ])
    for (const file of target.params.files) {
      expect(file.name).toHaveLength(128)
      expect(file.accept).toHaveLength(16)
      for (const accept of file.accept) expect(accept).toHaveLength(128)
    }
  })

  it('drops a share_target that is no object, or whose params is none; carries what the reader would refuse as it would refuse it', () => {
    for (const share_target of ['share', ['share'], null, 7, true, { action: 'share' }])
      expect(manifestSubset({ name: 'App', share_target })).toEqual({ name: 'App' })
    for (const params of ['title', ['url'], null, 3])
      expect(manifestSubset({ name: 'App', share_target: { action: 'share', params } })).toEqual({
        name: 'App'
      })
    // A member of the wrong type is left out; the reader then reads the default, or nothing.
    expect(
      manifestSubset({
        name: 'App',
        share_target: { action: 7, method: ['GET'], params: { title: 1, url: 'link' } }
      })?.share_target
    ).toStrictEqual({ params: { url: 'link' } })
    // A files entry that is no object crosses as null – the reader refuses the target, as it
    // refuses the original – and one entry crosses as a list of one, as the reader takes it.
    expect(
      manifestSubset({
        name: 'App',
        share_target: { action: 'share', params: { files: ['pictures'] } }
      })?.share_target
    ).toStrictEqual({ action: 'share', params: { files: [null] } })
    expect(
      manifestSubset({
        name: 'App',
        share_target: { action: 'share', params: { files: { name: 'doc', accept: ['.txt', 4] } } }
      })?.share_target
    ).toStrictEqual({ action: 'share', params: { files: [{ name: 'doc', accept: ['.txt'] }] } })
  })

  it('round-trips through the reader: an app installed from its page keeps the target its manifest declared', () => {
    const get = bothWays({
      name: 'App',
      start_url: '/tools/',
      icons: [{ src: 'icon.png', sizes: '192x192' }],
      share_target: { action: 'share', params: { title: 'subject', text: 'body', url: 'link' } }
    })
    expect(get.straight?.shareTarget).toEqual({
      action: 'https://app.example.com/tools/share',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'subject', text: 'body', url: 'link', files: [] }
    })
    expect(get.viaBridge).toEqual(get.straight)

    const post = bothWays({
      name: 'App',
      share_target: {
        action: '/tools/receive',
        method: 'post',
        enctype: 'Multipart/Form-Data',
        params: {
          text: 'note',
          files: [
            { name: 'pictures', accept: ['image/*', '.PNG'] },
            { name: 'doc', accept: '.txt' }
          ]
        }
      }
    })
    expect(post.straight?.shareTarget).toMatchObject({
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        files: [
          { name: 'pictures', accept: ['image/*', '.png'] },
          { name: 'doc', accept: ['.txt'] }
        ]
      }
    })
    expect(post.viaBridge?.shareTarget).toEqual(post.straight?.shareTarget)

    // One entry of files, not a list: the reader takes it either way, and the same way.
    const single = bothWays({
      name: 'App',
      share_target: {
        action: 'receive',
        method: 'POST',
        enctype: 'multipart/form-data',
        params: { url: 'link', files: { name: 'doc', accept: '.txt' } }
      }
    })
    expect(single.straight?.shareTarget?.params.files).toEqual([{ name: 'doc', accept: ['.txt'] }])
    expect(single.viaBridge?.shareTarget).toEqual(single.straight?.shareTarget)

    // No params: no target, both ways; none declared: none, both ways.
    const bare = bothWays({ name: 'App', share_target: { action: 'share' } })
    expect(bare.straight?.shareTarget).toBeNull()
    expect(bare.viaBridge?.shareTarget).toBeNull()
    const none = bothWays({ name: 'App' })
    expect(none.straight?.shareTarget).toBeNull()
    expect(none.viaBridge?.shareTarget).toBeNull()
    // A target the reader refuses (files on a GET) is refused through the subset too.
    const refused = bothWays({
      name: 'App',
      share_target: { action: 'share', params: { files: { name: 'doc', accept: '.txt' } } }
    })
    expect(refused.straight?.shareTarget).toBeNull()
    expect(refused.viaBridge?.shareTarget).toBeNull()
  })

  it('leaves the other fields as they were: strings cut at 2048, lists capped with their known members, the rest out', () => {
    expect(manifestSubset(null)).toBeNull()
    expect(manifestSubset('{}')).toBeNull()
    expect(manifestSubset([{ name: 'App' }])).toBeNull()
    const subset = manifestSubset({
      name: 'App',
      description: 'd'.repeat(3000),
      display: 5,
      icons: 'icon.png',
      screenshots: Array.from({ length: 10 }, (_, i) => ({
        src: `s${i}.png`,
        form_factor: 'wide'
      })),
      unknown: 'x'
    })
    expect(subset).toEqual({
      name: 'App',
      description: 'd'.repeat(2048),
      screenshots: Array.from({ length: 8 }, (_, i) => ({ src: `s${i}.png`, form_factor: 'wide' }))
    })
    expect(Object.keys(subset ?? {})).toEqual(['name', 'description', 'screenshots'])
    expect(
      manifestSubset({ icons: [null, 'icon.png', { src: 'a.png', sizes: '48x48', weight: 1 }] })
        ?.icons
    ).toEqual([null, null, { src: 'a.png', sizes: '48x48' }])
    expect(
      (
        manifestSubset({ icons: Array.from({ length: 40 }, () => ({ src: 'a.png' })) })
          ?.icons as unknown[]
      ).length
    ).toBe(32)
  })
})

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
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

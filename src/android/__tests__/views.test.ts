import { describe, expect, it } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import type { Bridge } from '../bridge'
import { AndroidTabView, type ContentRulesResolver } from '../views'
import type { ResolvedContentRules } from '@shared/contentRules'

/** Core-side view events that only record which of them Kotlin's events reached. */
function fakeEvents(): { events: TabViewEvents; reached: string[] } {
  const reached: string[] = []
  const events = new Proxy({} as TabViewEvents, {
    get: (_target, name: string) => (): undefined => {
      reached.push(name)
      return undefined
    }
  })
  return { events, reached }
}

function fakeBridge(): { bridge: Bridge; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      return null
    },
    send: (method: string, args: unknown) => {
      calls.push({ method, args })
    }
  } as unknown as Bridge
  return { bridge, calls }
}

describe('AndroidTabView.executeJavaScript', () => {
  it('passes expressions through and wraps statement lists into a function', async () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    await view.executeJavaScript('document.title')
    await view.executeJavaScript('(() => { for (const el of []) el.remove(); return true })()')
    await view.executeJavaScript(
      "for (const el of document.querySelectorAll('x')) el.style.visibility = 'hidden'"
    )
    await view.executeJavaScript("history.forward(); 'forwarded'")
    const codes = calls.map((c) => (c.args as { code: string }).code)
    expect(codes[0]).toBe('document.title')
    expect(codes[1]).toBe('(() => { for (const el of []) el.remove(); return true })()')
    expect(codes[2]).toMatch(/^\(\(\) => \{ for \(const el of/)
    expect(codes[3]).toMatch(/^\(\(\) => \{ history\.forward\(\); 'forwarded'/)
  })

  it('sends capture requests with the mode, region and format', async () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    await view.capture({
      mode: 'region',
      format: 'png',
      region: { x: 1, y: 2, width: 3, height: 4 }
    })
    await view.capture({ mode: 'fullPage', format: 'jpeg' })
    expect(calls[0]).toEqual({
      method: 'view.capture',
      args: {
        tabId: 'tab_1',
        mode: 'region',
        region: { x: 1, y: 2, width: 3, height: 4 },
        format: 'png'
      }
    })
    expect(calls[1]).toEqual({
      method: 'view.capture',
      args: { tabId: 'tab_1', mode: 'fullPage', region: null, format: 'jpeg' }
    })
  })

  it('starts a download on Kotlin, the menu’s Save As… crossing as the one flag that makes that download ask where it goes (HB-40)', () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    view.downloadURL('https://example.com/report.pdf')
    view.downloadURL('https://example.com/photo.jpg', { saveAs: true })
    view.downloadURL('https://example.com/plain.zip', { saveAs: false })
    view.downloadURL('https://example.com/other.zip', {})
    expect(calls).toEqual([
      { method: 'view.download', args: { tabId: 'tab_1', url: 'https://example.com/report.pdf' } },
      {
        method: 'view.download',
        args: { tabId: 'tab_1', url: 'https://example.com/photo.jpg', saveAs: true }
      },
      { method: 'view.download', args: { tabId: 'tab_1', url: 'https://example.com/plain.zip' } },
      { method: 'view.download', args: { tabId: 'tab_1', url: 'https://example.com/other.zip' } }
    ])
  })

  it('asks Kotlin for the page’s geometry and takes only a full answer', async () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    // Kotlin's `CapturePlan.viewportJson`: the visual viewport of a phone page, pinch-panned; a
    // WebView's scrollbars overlay the page, so the area minus the gutters is the visible area.
    const answer = {
      scrollX: 20,
      scrollY: 1230,
      width: 411,
      height: 700,
      clientWidth: 411,
      clientHeight: 700,
      rtl: false,
      zoom: 1.0011,
      devicePixelRatio: 2.6277,
      documentWidth: 411,
      documentHeight: 3000
    }
    Object.assign(bridge, {
      call: async (method: string, args: unknown) => {
        calls.push({ method, args })
        return method === 'view.viewport' ? answer : null
      }
    })
    await expect(view.viewport()).resolves.toEqual(answer)
    expect(calls[0]).toEqual({ method: 'view.viewport', args: { tabId: 'tab_1' } })
    // An answer from a host before the fields existed: the visible area stands in for them.
    const older: Record<string, unknown> = { ...answer }
    delete older.clientWidth
    delete older.clientHeight
    delete older.rtl
    Object.assign(bridge, { call: async () => older })
    await expect(view.viewport()).resolves.toEqual(answer)
    // No document to read: null, never a made-up geometry.
    Object.assign(bridge, { call: async () => null })
    await expect(view.viewport()).resolves.toBeNull()
    Object.assign(bridge, { call: async () => ({ scrollX: 0, scrollY: 0, width: 0, height: 700 }) })
    await expect(view.viewport()).resolves.toBeNull()
  })
})

describe('AndroidTabView.dispatch', () => {
  const nav = {
    url: 'https://example.org/',
    title: 'Example',
    canGoBack: false,
    canGoForward: false
  }

  it("routes Kotlin's domReady to the core's onDomReady, between startLoading and stopLoading", () => {
    const { bridge } = fakeBridge()
    const { events, reached } = fakeEvents()
    const view = new AndroidTabView('tab_1', bridge)
    view.events = events
    view.dispatch('startLoading', undefined)
    view.dispatch('domReady', undefined)
    view.dispatch('stopLoading', nav)
    expect(reached).toEqual(['onStartLoading', 'onDomReady', 'onStopLoading'])
    expect(view.getURL()).toBe('https://example.org/')
  })

  it('raises onDomReady as often as Kotlin says a document is ready, once per document', () => {
    const { bridge } = fakeBridge()
    const { events, reached } = fakeEvents()
    const view = new AndroidTabView('tab_1', bridge)
    view.events = events
    for (const url of ['https://a.example/', 'https://b.example/']) {
      view.dispatch('startLoading', undefined)
      view.dispatch('navigated', { ...nav, url, inPage: false })
      view.dispatch('domReady', undefined)
      view.dispatch('stopLoading', { ...nav, url })
    }
    expect(reached.filter((name) => name === 'onDomReady')).toHaveLength(2)
    expect(reached.indexOf('onDomReady')).toBeGreaterThan(reached.indexOf('onNavigated'))
  })

  it('drops domReady for a destroyed view, like every other event', () => {
    const { bridge } = fakeBridge()
    const { events, reached } = fakeEvents()
    const view = new AndroidTabView('tab_1', bridge)
    view.events = events
    view.dispatch('destroyed', undefined)
    view.dispatch('domReady', undefined)
    expect(reached).toEqual(['onDestroyed'])
  })

  it("routes Kotlin's redirected (shouldOverrideUrlLoading with isRedirect) to onRedirected with both addresses, before the commit (history-23)", () => {
    const { bridge } = fakeBridge()
    const hops: Array<[string, string]> = []
    const reached: string[] = []
    const events = new Proxy({} as TabViewEvents, {
      get: (_target, name: string) =>
        name === 'onRedirected'
          ? (from: string, to: string) => hops.push([from, to])
          : (): undefined => {
              reached.push(name)
              return undefined
            }
    })
    const view = new AndroidTabView('tab_1', bridge)
    view.events = events
    view.dispatch('redirected', { from: 'https://sho.rt/x', to: 'http://a.example/' })
    view.dispatch('redirected', { from: 'http://a.example/', to: 'https://a.example/' })
    view.dispatch('navigated', { ...nav, url: 'https://a.example/', inPage: false })
    expect(hops).toEqual([
      ['https://sho.rt/x', 'http://a.example/'],
      ['http://a.example/', 'https://a.example/']
    ])
    expect(reached).toEqual(['onNavigated'])
    // Garbage and a redirect onto the same address go nowhere.
    view.dispatch('redirected', { from: 'https://a.example/', to: 'https://a.example/' })
    view.dispatch('redirected', { from: 7, to: 'https://b.example/' } as unknown as {
      from: string
      to: string
    })
    expect(hops).toHaveLength(2)
  })
})

describe('AndroidTabView.sendFormsCommand', () => {
  it('hands fills and the on/off configuration to Kotlin for the page', () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    view.sendFormsCommand({ type: 'config', enabled: false })
    view.sendFormsCommand({
      type: 'fill',
      formId: 'f1',
      values: { username: 'ada', password: 'pw' }
    })
    expect(calls).toEqual([
      {
        method: 'view.forms',
        args: { tabId: 'tab_1', command: { type: 'config', enabled: false } }
      },
      {
        method: 'view.forms',
        args: {
          tabId: 'tab_1',
          command: { type: 'fill', formId: 'f1', values: { username: 'ada', password: 'pw' } }
        }
      }
    ])
  })
})

describe('AndroidTabView and the per-navigation content rules (the core decides, Kotlin applies)', () => {
  const answers: Record<string, boolean> = {
    images: false,
    javascript: true,
    'insecure-content': false,
    sensors: true,
    'third-party-sign-in': true,
    'payment-handler': false
  }
  function resolver(started: boolean): {
    resolver: ContentRulesResolver
    asked: Array<{ url: string; details: unknown }>
  } {
    const asked: Array<{ url: string; details: unknown }> = []
    const resolver: ContentRulesResolver = {
      started,
      resolveAll: (url, details) => {
        asked.push({ url, details })
        return { ...answers } as ResolvedContentRules
      }
    }
    return { resolver, asked }
  }

  it('sends the destination’s resolved rules with a load and a reload, in the tab’s container', () => {
    const { bridge, calls } = fakeBridge()
    const { resolver: rules, asked } = resolver(true)
    const view = new AndroidTabView(
      'tab_1',
      bridge,
      undefined,
      undefined,
      undefined,
      undefined,
      () => rules
    )
    view.events = fakeEvents().events
    view.loadURL('https://a.example/page')
    expect(calls[0]).toEqual({
      method: 'view.load',
      args: { tabId: 'tab_1', url: 'https://a.example/page', rules: answers }
    })
    expect(asked[0]).toEqual({ url: 'https://a.example/page', details: undefined })
    view.containerId = 'private'
    view.dispatch('navigated', {
      url: 'https://a.example/page',
      title: 'a',
      canGoBack: false,
      canGoForward: false,
      inPage: false
    })
    view.reload(false)
    expect(calls[1]).toEqual({
      method: 'view.reload',
      args: { tabId: 'tab_1', ignoreCache: false, url: 'https://a.example/page', rules: answers }
    })
    expect(asked[1]).toEqual({
      url: 'https://a.example/page',
      details: { privateContainerId: 'private' }
    })
  })

  it('answers Kotlin’s question for a navigation it did not start, with the token it holds the navigation by', () => {
    const { bridge, calls } = fakeBridge()
    const { resolver: rules } = resolver(true)
    const view = new AndroidTabView(
      'tab_1',
      bridge,
      undefined,
      undefined,
      undefined,
      undefined,
      () => rules
    )
    view.events = fakeEvents().events
    view.dispatch('resolveRules', { token: 7, url: 'https://b.example/x' })
    expect(calls[0]).toEqual({
      method: 'view.rulesResolved',
      args: { tabId: 'tab_1', token: 7, url: 'https://b.example/x', rules: answers }
    })
  })

  it('sends a load and a reload without rules before the core’s rules service has started (Kotlin reads the pushed document) and for a page without a site, and answers a question with null', () => {
    const { bridge, calls } = fakeBridge()
    const { resolver: rules, asked } = resolver(false)
    const view = new AndroidTabView(
      'tab_1',
      bridge,
      undefined,
      undefined,
      undefined,
      undefined,
      () => rules
    )
    view.events = fakeEvents().events
    view.loadURL('https://a.example/')
    view.reload(true)
    view.dispatch('resolveRules', { token: 1, url: 'https://a.example/' })
    expect(calls).toEqual([
      { method: 'view.load', args: { tabId: 'tab_1', url: 'https://a.example/' } },
      { method: 'view.reload', args: { tabId: 'tab_1', ignoreCache: true } },
      {
        method: 'view.rulesResolved',
        args: { tabId: 'tab_1', token: 1, url: 'https://a.example/', rules: null }
      }
    ])
    expect(asked).toEqual([])
    const unbound = new AndroidTabView('tab_2', bridge)
    unbound.loadURL('https://a.example/')
    expect(calls[3]).toEqual({
      method: 'view.load',
      args: { tabId: 'tab_2', url: 'https://a.example/' }
    })
    const { resolver: started } = resolver(true)
    const siteless = new AndroidTabView(
      'tab_3',
      bridge,
      undefined,
      undefined,
      undefined,
      undefined,
      () => started
    )
    siteless.loadURL('about:blank')
    expect(calls[4]).toEqual({ method: 'view.load', args: { tabId: 'tab_3', url: 'about:blank' } })
  })
})

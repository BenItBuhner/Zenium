import { describe, expect, it } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import type { Bridge } from '../bridge'
import { AndroidTabView } from '../views'

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
})

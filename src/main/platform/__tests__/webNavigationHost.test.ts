import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'

vi.mock('electron', () => ({
  webContents: { fromId: () => undefined, fromFrame: () => null },
  webFrameMain: { fromId: () => null }
}))

import { WebNavigationApi } from '../extensionApi/webNavigation'
import type { ElectronTabView } from '../views'
import type { ApiHost } from '../extensionApi/types'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeFrame {
  processId: number
  routingId: number
  frameTreeNodeId: number
  url: string
  parent: FakeFrame | null
  framesInSubtree: FakeFrame[]
}

/** A page's `WebContents` as the navigation events see it: an emitter with a main frame. */
class FakeContents extends EventEmitter {
  readonly mainFrame: FakeFrame
  constructor(
    readonly id: number,
    url: string
  ) {
    super()
    this.mainFrame = {
      processId: 10 + id,
      routingId: 1,
      frameTreeNodeId: 100 + id,
      url,
      parent: null,
      framesInSubtree: []
    }
    this.mainFrame.framesInSubtree = [this.mainFrame]
  }
  isDestroyed(): boolean {
    return false
  }
}

function view(wc: FakeContents): ElectronTabView {
  return {
    webContents: wc,
    onNavigationTarget: null,
    takeNavigationHint: () => ({})
  } as unknown as ElectronTabView
}

interface Dispatched {
  event: string
  tabId: number
  url: string
}

/**
 * The host with a model that knows only the tabs in `tabs` (keyed by WebContents id): a page
 * outside it is the preloaded new tab page under its placeholder id, not a tab.
 */
function fakeHost(tabs: Map<number, Tab>): { host: ApiHost; dispatched: Dispatched[] } {
  const dispatched: Dispatched[] = []
  const host = {
    allLoaded: () => [{ id: EXT }],
    grants: () => ({ permissions: ['webNavigation'], origins: [] }),
    dispatch: (_ext: string, _ns: string, event: string, args: unknown[]) => {
      const details = args[0] as { tabId: number; url: string }
      dispatched.push({ event, tabId: details.tabId, url: details.url })
    },
    scheduleTick: () => undefined,
    model: {
      zenTab: (id: number) => tabs.get(id),
      chromeTabId: (tab: Tab) => Number(tab.id.replace('tab-', ''))
    }
  } as unknown as ApiHost
  return { host, dispatched }
}

/** The engine's event sequence for a top-level navigation of `wc` to `url`. */
function navigate(wc: FakeContents, url: string): void {
  wc.emit('did-start-navigation', {
    url,
    isSameDocument: false,
    isMainFrame: true,
    frame: wc.mainFrame
  })
  wc.mainFrame.url = url
  wc.emit('did-frame-navigate', {}, url, 200, 'OK', true, wc.mainFrame.processId, 1)
  wc.emit('dom-ready')
  wc.emit('did-frame-finish-load', {}, true, wc.mainFrame.processId, 1)
}

describe('WebNavigationApi events and the pages that are tabs', () => {
  let tabs: Map<number, Tab>

  beforeEach(() => {
    tabs = new Map()
  })

  it('fires the navigation family with the tab id of a tab page', () => {
    const { host, dispatched } = fakeHost(tabs)
    const api = new WebNavigationApi(host)
    const wc = new FakeContents(7, 'about:blank')
    tabs.set(7, { id: 'tab-7', url: 'about:blank' } as Tab)
    api.attach(view(wc))
    navigate(wc, 'https://example.com/')
    expect(dispatched.map((d) => d.event)).toEqual([
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted'
    ])
    expect(new Set(dispatched.map((d) => d.tabId))).toEqual(new Set([7]))
    expect(dispatched.every((d) => d.url === 'https://example.com/')).toBe(true)
  })

  it('stays silent for a page that is not a tab of the model (the preloaded new tab page)', () => {
    const { host, dispatched } = fakeHost(tabs)
    const api = new WebNavigationApi(host)
    const spare = new FakeContents(4, 'about:blank')
    api.attach(view(spare))
    navigate(spare, 'zen://newtab/')
    spare.emit('did-navigate-in-page', {}, 'zen://newtab/#x', true, spare.mainFrame.processId, 1)
    spare.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'zen://newtab/', true, 14, 1)
    expect(dispatched).toEqual([])
  })

  it('reports the page once the model adopts it as a tab, under that tab’s id', () => {
    const { host, dispatched } = fakeHost(tabs)
    const api = new WebNavigationApi(host)
    const spare = new FakeContents(4, 'about:blank')
    api.attach(view(spare))
    navigate(spare, 'zen://newtab/')
    expect(dispatched).toEqual([])
    // The preloaded page became the view of a real tab: from here its navigations are that tab's.
    tabs.set(4, { id: 'tab-4', url: 'zen://newtab/' } as Tab)
    navigate(spare, 'https://example.org/')
    expect(dispatched.map((d) => [d.event, d.tabId])).toEqual([
      ['onBeforeNavigate', 4],
      ['onCommitted', 4],
      ['onDOMContentLoaded', 4],
      ['onCompleted', 4]
    ])
  })

  it('does not remember a window.open from a page that is not a tab as a navigation target', () => {
    const { host, dispatched } = fakeHost(tabs)
    const api = new WebNavigationApi(host)
    const spare = new FakeContents(4, 'zen://newtab/')
    api.navigationTarget(spare as never, 'https://example.com/popup')
    const opened = new FakeContents(9, 'about:blank')
    tabs.set(9, { id: 'tab-9', url: 'https://example.com/popup' } as Tab)
    api.attach(view(opened))
    expect(dispatched.filter((d) => d.event === 'onCreatedNavigationTarget')).toEqual([])
    // From a tab, the new tab's view fires it with both ids from the model.
    const source = new FakeContents(2, 'https://source.example/')
    tabs.set(2, { id: 'tab-2', url: 'https://source.example/' } as Tab)
    api.navigationTarget(source as never, 'https://example.com/second')
    const second = new FakeContents(11, 'about:blank')
    tabs.set(11, { id: 'tab-11', url: 'https://example.com/second' } as Tab)
    api.attach(view(second))
    expect(dispatched.filter((d) => d.event === 'onCreatedNavigationTarget')).toEqual([
      { event: 'onCreatedNavigationTarget', tabId: 11, url: 'https://example.com/second' }
    ])
  })
})

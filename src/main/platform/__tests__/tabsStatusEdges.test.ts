import { describe, expect, it } from 'vitest'
import { type ChromeTab, TAB_GROUP_NONE, TabStatusEdges } from '../../../core/extensions/api/tabs'
import { TabsApi } from '../extensionApi/tabs'
import type { ModelSnapshot, TabSnapshot } from '../extensionApi/model'
import type { ApiHost, LoadedExtension } from '../extensionApi/types'

interface Emit {
  event: string
  args: unknown[]
}

function fakeHost(emits: Emit[]): ApiHost {
  const ext = { id: 'abcdefghijklmnopabcdefghijklmnop' } as unknown as LoadedExtension
  return {
    model: { forgetTab: () => undefined },
    canSeeTab: () => true,
    broadcast: (
      namespace: string,
      event: string,
      argsFor: (extension: LoadedExtension) => unknown[] | null
    ) => {
      if (namespace !== 'tabs') return
      const args = argsFor(ext)
      if (args) emits.push({ event, args })
    }
  } as unknown as ApiHost
}

function chromeTab(over: Partial<ChromeTab> = {}): ChromeTab {
  return {
    id: 3,
    index: 0,
    windowId: 10,
    active: true,
    highlighted: true,
    selected: true,
    pinned: false,
    url: 'http://fixture.test/page-a.html',
    title: 'Probe Page A',
    status: 'complete',
    audible: false,
    mutedInfo: { muted: false },
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    incognito: false,
    groupId: TAB_GROUP_NONE,
    ...over
  }
}

function snap(tabs: ChromeTab[]): ModelSnapshot {
  const map = new Map<string, TabSnapshot>()
  for (const chrome of tabs) {
    map.set(`zen-${chrome.id}`, {
      chrome,
      zenId: `zen-${chrome.id}`,
      windowId: chrome.windowId,
      zoom: 0,
      url: chrome.url ?? ''
    })
  }
  return { tabs: map, windows: new Map(), focused: 10 }
}

const statusEdges = (emits: Emit[]): unknown[] =>
  emits
    .filter((e) => e.event === 'onUpdated')
    .map((e) => (e.args[1] as { status?: string }).status)
    .filter((s) => s !== undefined)

describe('tabs.onUpdated status edges follow navigations, as Chrome’s TabsEventRouter does', () => {
  it('reports nothing for a settled page whose loading flag rises and falls for an inserted iframe', () => {
    // WAVE lays its sidebar into the page as an iframe after the action click and tears every
    // mark down on `onUpdated {status:'loading'}`; Chrome reports no status edge for a frame's
    // first load (an auto-subframe commit carries no navigation entry), so the sidebar stays.
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const settled = snap([chromeTab()])
    const framing = snap([chromeTab({ status: 'loading' })])
    api.diff(settled, framing)
    api.diff(framing, settled)
    expect(emits).toEqual([])
  })

  it('reports loading then complete around an outermost-frame navigation', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const here = snap([chromeTab()])
    api.navigationStarted(3)
    const going = snap([chromeTab({ status: 'loading', url: 'http://fixture.test/page-b.html' })])
    api.diff(here, going)
    api.navigationCommitted(3)
    // The commit lands while the flag is still up: no second loading edge.
    api.diff(going, going)
    const there = snap([chromeTab({ url: 'http://fixture.test/page-b.html', title: 'B' })])
    api.diff(going, there)
    expect(statusEdges(emits)).toEqual(['loading', 'complete'])
    expect(emits[0].args[1]).toEqual({ status: 'loading', url: 'http://fixture.test/page-b.html' })
    expect(emits[emits.length - 1].args[1]).toEqual({ status: 'complete', title: 'B' })
  })

  it('reports the loading edge at the commit when the flag rose before the navigation was heard of', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const here = snap([chromeTab()])
    const going = snap([chromeTab({ status: 'loading' })])
    api.diff(here, going)
    expect(emits).toEqual([])
    api.navigationCommitted(3)
    api.diff(going, going)
    expect(statusEdges(emits)).toEqual(['loading'])
    api.diff(going, here)
    expect(statusEdges(emits)).toEqual(['loading', 'complete'])
  })

  it('reports { status: complete, url } for a same-document navigation of the outermost frame', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const here = snap([chromeTab()])
    api.navigationCommitted(3)
    api.diff(here, snap([chromeTab({ url: 'http://fixture.test/page-a.html#section' })]))
    expect(emits).toHaveLength(1)
    expect(emits[0].args[1]).toEqual({
      status: 'complete',
      url: 'http://fixture.test/page-a.html#section'
    })
  })

  it('does not double the loading edge a new tab was born with', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const born = snap([chromeTab({ status: 'loading' })])
    api.diff(snap([]), born)
    api.navigationCommitted(3)
    api.diff(born, born)
    api.diff(born, snap([chromeTab()]))
    expect(emits.map((e) => e.event)).toEqual(['onCreated', 'onUpdated', 'onUpdated'])
    expect(statusEdges(emits)).toEqual(['loading', 'complete'])
  })

  it('reports a sub-frame’s later navigation when the commit says so', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const settled = snap([chromeTab()])
    const framing = snap([chromeTab({ status: 'loading' })])
    api.diff(settled, framing)
    api.navigationCommitted(3)
    api.diff(framing, framing)
    api.diff(framing, settled)
    expect(statusEdges(emits)).toEqual(['loading', 'complete'])
  })

  it('forgets a tab’s edges with the tab', () => {
    const edges = new TabStatusEdges()
    edges.navigationStarted(7)
    edges.forget(7)
    expect(edges.statusFor(7, 'complete', 'loading')).toBeUndefined()
    // A tab coming back from a discard is navigating by definition.
    expect(edges.statusFor(7, 'unloaded', 'loading')).toBe('loading')
    expect(edges.statusFor(7, 'loading', 'complete')).toBe('complete')
    // A load under way before the tab was followed still reports its end.
    expect(edges.statusFor(8, 'loading', 'complete')).toBe('complete')
    expect(edges.statusFor(8, 'complete', 'unloaded')).toBe('unloaded')
  })
})

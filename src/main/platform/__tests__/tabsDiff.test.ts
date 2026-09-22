import { describe, expect, it } from 'vitest'
import { type ChromeTab, TAB_GROUP_NONE } from '../../../core/extensions/api/tabs'
import { TabsApi } from '../extensionApi/tabs'
import type { ModelSnapshot, TabSnapshot } from '../extensionApi/model'
import type { ApiHost, LoadedExtension } from '../extensionApi/types'

interface Emit {
  event: string
  args: unknown[]
}

/** A host that records `tabs.*` broadcasts, with one loaded extension that may see every URL. */
function fakeHost(emits: Emit[], canSee = true): ApiHost {
  const forgotten: string[] = []
  const ext = { id: 'abcdefghijklmnopabcdefghijklmnop' } as unknown as LoadedExtension
  return {
    model: { forgetTab: (zenId: string) => forgotten.push(zenId) },
    canSeeTab: () => canSee,
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
    id: 1,
    index: 0,
    windowId: 10,
    active: true,
    highlighted: true,
    selected: true,
    pinned: false,
    url: 'http://fixture.test/hls.html',
    title: 'fixture.test',
    status: 'loading',
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

describe('TabsApi.diff new-tab loading edge', () => {
  it('follows onCreated with an onUpdated loading edge for a tab born mid-load, as Chrome does', () => {
    // Chrome fires `onCreated` (status loading) then `onUpdated {status:'loading', url}` for a new
    // tab; media sniffers (Stream Recorder) build their per-tab state only on that loading edge.
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    api.diff(snap([]), snap([chromeTab({ status: 'loading' })]))
    expect(emits.map((e) => e.event)).toEqual(['onCreated', 'onUpdated'])
    const updated = emits[1]
    expect(updated.args[0]).toBe(1)
    expect(updated.args[1]).toEqual({ status: 'loading', url: 'http://fixture.test/hls.html' })
    // The tab object rides along, as with every onUpdated.
    expect((updated.args[2] as ChromeTab).id).toBe(1)
  })

  it('does not synthesize a loading edge for a tab that is already complete at birth', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    api.diff(snap([]), snap([chromeTab({ status: 'complete' })]))
    expect(emits.map((e) => e.event)).toEqual(['onCreated'])
  })

  it('still reports the later loading→complete edge from a subsequent snapshot', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits))
    const loading = snap([chromeTab({ status: 'loading' })])
    api.diff(loading, snap([chromeTab({ status: 'complete', title: 'Zenium HLS fixture' })]))
    const updated = emits.filter((e) => e.event === 'onUpdated')
    expect(updated).toHaveLength(1)
    expect(updated[0].args[1]).toMatchObject({ status: 'complete' })
  })

  it('drops the URL of the loading edge from an extension that may not see the tab', () => {
    const emits: Emit[] = []
    const api = new TabsApi(fakeHost(emits, false))
    api.diff(snap([]), snap([chromeTab({ status: 'loading' })]))
    const updated = emits.find((e) => e.event === 'onUpdated')
    expect(updated?.args[1]).toEqual({ status: 'loading' })
  })
})

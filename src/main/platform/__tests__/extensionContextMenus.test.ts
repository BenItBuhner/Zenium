import { describe, expect, it } from 'vitest'
import {
  ERROR_CANNOT_FIND_ITEM,
  ERROR_DUPLICATE_ID,
  formatMenuError,
  type PersistedMenuItem
} from '../../../core/extensions/api/contextMenus'
import type { MenuItemTemplate, PageContextParams } from '../../../core/platform'
import type { Tab } from '../../../shared/types'
import type { ActiveTabGrants } from '../extensionApi/activeTab'
import { ContextMenusApi } from '../extensionApi/contextMenus'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

const WORKER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const EVENT_PAGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PERSISTENT = 'cccccccccccccccccccccccccccccccc'

const MANIFESTS: Record<string, Record<string, unknown>> = {
  [WORKER]: { manifest_version: 3, name: 'Worker', background: { service_worker: 'bg.js' } },
  [EVENT_PAGE]: {
    manifest_version: 2,
    name: 'Event page',
    background: { scripts: ['bg.js'], persistent: false }
  },
  [PERSISTENT]: { manifest_version: 2, name: 'Persistent', background: { scripts: ['bg.js'] } }
}

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

/** One browser session: the store outlives it (a `Map` handed from one world to the next). */
interface World {
  api: ContextMenusApi
  dispatched: Dispatched[]
  granted: string[]
  loaded(extensionId: string): LoadedExtension
  ctx(extensionId: string, sender?: 'worker' | 'background'): ApiContext
}

const TAB: Tab = { id: 'tab-1', url: 'https://example.com/page', title: 'Example' } as Tab

const PARAMS: PageContextParams = {
  x: 0,
  y: 0,
  linkURL: '',
  srcURL: '',
  pageURL: 'https://example.com/page',
  frameURL: '',
  selectionText: '',
  isEditable: false,
  mediaType: 'none'
} as unknown as PageContextParams

function world(store: Map<string, PersistedMenuItem[]>): World {
  const dispatched: Dispatched[] = []
  const granted: string[] = []
  const loaded = (extensionId: string): LoadedExtension =>
    ({ id: extensionId, manifest: MANIFESTS[extensionId] }) as unknown as LoadedExtension
  const host = {
    store: {
      contextMenuItems: (extensionId: string) => store.get(extensionId) ?? [],
      setContextMenuItems: (extensionId: string, items: PersistedMenuItem[]) => {
        if (items.length === 0) store.delete(extensionId)
        else store.set(extensionId, JSON.parse(JSON.stringify(items)) as PersistedMenuItem[])
      }
    },
    loaded,
    allLoaded: () => Object.keys(MANIFESTS).map(loaded),
    canSeeTab: () => true,
    model: { chromeTab: (tab: Tab) => ({ id: 1, url: tab.url }) },
    dispatch: (extensionId: string, _ns: string, event: string, args: unknown[]) =>
      dispatched.push({ extensionId, event, args }),
    browser: {
      extensions: { list: () => [] },
      tabs: { activeTabFor: () => TAB }
    }
  } as unknown as ApiHost
  const activeTab = {
    grant: (extensionId: string) => granted.push(extensionId)
  } as unknown as ActiveTabGrants
  const api = new ContextMenusApi(host, activeTab)
  return {
    api,
    dispatched,
    granted,
    loaded,
    ctx: (extensionId, sender = 'worker') =>
      ({
        extensionId,
        extension: loaded(extensionId),
        sender: { kind: sender }
      }) as unknown as ApiContext
  }
}

const labels = (items: MenuItemTemplate[]): string[] =>
  items.map((item) => item.label ?? item.type ?? '')

describe('ContextMenusApi persistence (Chrome MenuManager semantics)', () => {
  it('restores a worker extension’s onInstalled items at the next start, before the worker runs', () => {
    const store = new Map<string, PersistedMenuItem[]>()
    const first = world(store)
    first.api.load(first.loaded(WORKER))
    first.api.handlers.create(first.ctx(WORKER), { id: 'block-elements', title: 'Block element' })
    first.api.handlers.create(first.ctx(WORKER), {
      id: 'pause',
      type: 'checkbox',
      title: 'Pause on this site',
      contexts: ['action']
    })
    expect(store.get(WORKER)?.map((item) => item.id)).toEqual(['block-elements', 'pause'])

    // Restart: a new router, the same store. The worker has not run yet.
    const second = world(store)
    second.api.load(second.loaded(WORKER))
    expect(labels(second.api.pageMenuItems(TAB, PARAMS))).toEqual(['Block element'])
    // Stands AdBlocker's start: `update` of the onInstalled item finds it.
    expect(() =>
      second.api.handlers.update(second.ctx(WORKER), 'block-elements', {
        title: 'Block an element'
      })
    ).not.toThrow()
    expect(store.get(WORKER)?.[0].title).toBe('Block an element')
    // Recreating it at worker start is Chrome's duplicate-id error.
    expect(() =>
      second.api.handlers.create(second.ctx(WORKER), { id: 'block-elements', title: 'Again' })
    ).toThrow(formatMenuError(ERROR_DUPLICATE_ID, 'block-elements'))
  })

  it('keeps items across an unload and drops them only when the extension removes them', () => {
    const store = new Map<string, PersistedMenuItem[]>()
    const w = world(store)
    w.api.load(w.loaded(EVENT_PAGE))
    w.api.handlers.create(w.ctx(EVENT_PAGE, 'background'), { id: 'a', title: 'A' })
    w.api.handlers.create(w.ctx(EVENT_PAGE, 'background'), { id: 'b', title: 'B', parentId: 'a' })
    // Disabled or the browser closing: memory goes, the store stays.
    w.api.forget(EVENT_PAGE)
    expect(w.api.pageMenuItems(TAB, PARAMS)).toEqual([])
    expect(store.get(EVENT_PAGE)?.map((item) => item.id)).toEqual(['a', 'b'])
    w.api.load(w.loaded(EVENT_PAGE))
    const [entry] = w.api.pageMenuItems(TAB, PARAMS)
    expect(entry.label).toBe('A')
    expect(labels(entry.submenu ?? [])).toEqual(['B'])
    // `remove` of the parent takes the child with it, in memory and in the store.
    w.api.handlers.remove(w.ctx(EVENT_PAGE, 'background'), 'a')
    expect(store.has(EVENT_PAGE)).toBe(false)
    expect(() => w.api.handlers.update(w.ctx(EVENT_PAGE, 'background'), 'b', {})).toThrow(
      formatMenuError(ERROR_CANNOT_FIND_ITEM, 'b')
    )
    w.api.handlers.create(w.ctx(EVENT_PAGE, 'background'), { id: 'c', title: 'C' })
    expect(store.get(EVENT_PAGE)?.length).toBe(1)
    w.api.handlers.removeAll(w.ctx(EVENT_PAGE, 'background'))
    expect(store.has(EVENT_PAGE)).toBe(false)
  })

  it('writes a checkbox toggle from the menu, as Chrome does on ExecuteCommand', () => {
    const store = new Map<string, PersistedMenuItem[]>()
    const w = world(store)
    w.api.load(w.loaded(WORKER))
    w.api.handlers.create(w.ctx(WORKER), { id: 'box', type: 'checkbox', title: 'Box' })
    expect(store.get(WORKER)?.[0].checked).toBe(false)
    const [item] = w.api.pageMenuItems(TAB, PARAMS)
    item.click?.()
    expect(store.get(WORKER)?.[0].checked).toBe(true)
    expect(w.dispatched[0]).toMatchObject({
      extensionId: WORKER,
      event: 'onClicked',
      args: [{ menuItemId: 'box', wasChecked: false, checked: true }, { id: 1 }]
    })
    expect(w.granted).toEqual([WORKER])
    // The toggled state is what the next session restores.
    const next = world(store)
    next.api.load(next.loaded(WORKER))
    expect(next.api.pageMenuItems(TAB, PARAMS)[0].checked).toBe(true)
  })

  it('persists nothing for a persistent background page, which recreates its items itself', () => {
    const store = new Map<string, PersistedMenuItem[]>()
    const w = world(store)
    w.api.load(w.loaded(PERSISTENT))
    // A persistent page may omit the id (Chrome numbers it); the shim's generated id arrives.
    expect(w.api.handlers.create(w.ctx(PERSISTENT, 'background'), { title: 'Mine' }, 1)).toBe(1)
    expect(labels(w.api.pageMenuItems(TAB, PARAMS))).toEqual(['Mine'])
    expect(store.size).toBe(0)
    // Whatever is in the store for it (a manifest that changed to persistent) is not restored.
    store.set(PERSISTENT, [
      {
        id: 'stale',
        type: 'normal',
        title: 'Stale',
        checked: false,
        contexts: ['all'],
        visible: true,
        enabled: true,
        parentId: null,
        documentUrlPatterns: [],
        targetUrlPatterns: []
      }
    ])
    const next = world(store)
    next.api.load(next.loaded(PERSISTENT))
    expect(next.api.pageMenuItems(TAB, PARAMS)).toEqual([])
  })
})

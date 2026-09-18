import { describe, expect, it } from 'vitest'
import { BookmarkService } from '../../bookmarks'
import type { BrowserState } from '../../state'
import { createBookmarkRoots } from '../../../shared/bookmarks'
import type { BookmarkNode } from '../../../shared/types'
import { BookmarksApi } from '../../../main/platform/extensionApi/bookmarks'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'
import { ERROR_FOLDER_NOT_EMPTY, ERROR_NO_PERMISSION } from '../api/bookmarks'

/** The slice of `BrowserState` the bookmark service touches. */
function fakeState(): BrowserState {
  const state = {
    bookmarks: createBookmarkRoots(1_000) as BookmarkNode[],
    platform: 'linux',
    model: { tabs: {} },
    commits: 0,
    commit(): void {
      this.commits += 1
    }
  }
  return state as unknown as BrowserState
}

interface Delivery {
  extensionId: string
  event: string
  args: unknown[]
}

function harness(grants: Record<string, string[]>): {
  api: BookmarksApi
  service: BookmarkService
  ctx: (id: string) => ApiContext
  deliveries: Delivery[]
  ticks: number
} {
  const service = new BookmarkService(fakeState())
  const deliveries: Delivery[] = []
  const loaded = new Map<string, LoadedExtension>()
  for (const id of Object.keys(grants)) {
    loaded.set(id, { id, sessions: [] } as unknown as LoadedExtension)
  }
  const counters = { ticks: 0 }
  const host = {
    browser: { bookmarks: service },
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ) {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) deliveries.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    },
    scheduleTick(): void {
      counters.ticks += 1
    }
  }
  const api = new BookmarksApi(host as unknown as ApiHost)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  return {
    api,
    service,
    ctx,
    deliveries,
    get ticks() {
      return counters.ticks
    }
  }
}

describe('BookmarksApi over the bookmark service', () => {
  it('requires the bookmarks permission', () => {
    const h = harness({ ext: [] })
    expect(() => h.api.handlers.getTree(h.ctx('ext'))).toThrow(ERROR_NO_PERMISSION)
  })

  it('creates, reads back through the root, updates, moves and removes', () => {
    const h = harness({ ext: ['bookmarks'] })
    const ctx = h.ctx('ext')
    const folder = h.api.handlers.create(ctx, { parentId: '1', title: 'Work' }) as { id: string }
    const created = h.api.handlers.create(ctx, {
      parentId: folder.id,
      title: 'A',
      url: 'https://a.example'
    }) as Record<string, unknown>
    expect(created).toMatchObject({
      parentId: folder.id,
      index: 0,
      title: 'A',
      url: 'https://a.example/',
      syncing: false
    })
    expect(typeof created.dateAdded).toBe('number')

    const [root] = h.api.handlers.getTree(ctx) as Array<{
      id: string
      children: Array<{ id: string; children: Array<{ id: string }> }>
    }>
    expect(root.id).toBe('0')
    expect(root.children.map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(root.children[0].children.map((c) => c.id)).toEqual([folder.id])

    expect(h.api.handlers.get(ctx, ['0', folder.id])).toHaveLength(2)
    expect(h.api.handlers.getChildren(ctx, '0')).toHaveLength(3)
    expect(h.api.handlers.getSubTree(ctx, folder.id)).toMatchObject([
      { id: folder.id, children: [{ id: created.id }] }
    ])
    expect(h.api.handlers.getRecent(ctx, 5)).toMatchObject([{ id: created.id }])
    expect(h.api.handlers.search(ctx, 'A')).toMatchObject([{ id: created.id }])
    expect(h.api.handlers.search(ctx, { url: 'https://a.example' })).toMatchObject([
      { id: created.id }
    ])

    expect(h.api.handlers.update(ctx, created.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed'
    })
    expect(h.api.handlers.move(ctx, created.id, { parentId: '2' })).toMatchObject({
      parentId: '2',
      index: 0
    })
    expect(() => h.api.handlers.remove(ctx, '1')).toThrow(/root bookmark folders/)
    h.api.handlers.remove(ctx, created.id)
    expect(h.service.get(created.id as string)).toBeNull()
    h.api.handlers.create(ctx, { parentId: folder.id, title: 'B', url: 'https://b.example/' })
    expect(() => h.api.handlers.remove(ctx, folder.id)).toThrow(ERROR_FOLDER_NOT_EMPTY)
    h.api.handlers.removeTree(ctx, folder.id)
    expect(h.service.getChildren('1')).toEqual([])
    expect(h.ticks).toBeGreaterThan(0)
  })

  it('fans model changes out to permission holders only, after a baseline tick', () => {
    const h = harness({ withPerm: ['bookmarks'], without: ['tabs'] })
    h.api.tick()
    expect(h.deliveries).toEqual([])
    const node = h.service.create({ parentId: '2', title: 'Z', url: 'https://z.example/' })!
    h.api.tick()
    expect(h.deliveries).toEqual([
      {
        extensionId: 'withPerm',
        event: 'bookmarks.onCreated',
        args: [node.id, expect.objectContaining({ id: node.id, url: 'https://z.example/' })]
      }
    ])
    h.api.tick()
    expect(h.deliveries).toHaveLength(1)
    h.service.update(node.id, { title: 'Zed' })
    h.service.removeTree(node.id)
    h.api.tick()
    expect(h.deliveries.slice(1).map((d) => d.event)).toEqual(['bookmarks.onRemoved'])
  })

  it('starts over from a fresh baseline after reset', () => {
    const h = harness({ ext: ['bookmarks'] })
    h.api.tick()
    h.api.reset()
    h.service.create({ parentId: '2', title: 'Q', url: 'https://q.example/' })
    h.api.tick()
    expect(h.deliveries).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageApi } from '../../../main/platform/extensionApi/storage'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'
import type { StorageItems } from '../api/storage'

/** Stands in for Electron's `Session`; the module only compares and passes it on. */
type Session = FakeSession

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
  session?: (session: Session) => boolean
}

const EXT = 'a'.repeat(32)

interface FakeSession {
  name: string
}

function harness(manifestVersion: 2 | 3 = 3): {
  api: StorageApi
  out: Dispatched[]
  sync: Map<string, StorageItems>
  managed: StorageItems
  primary: FakeSession
  other: FakeSession
  live: { frames: FakeSession[]; workers: FakeSession[] }
  /** The partitions the registry was asked to start the extension's worker in (`wakeIn`). */
  woken: FakeSession[]
  ctx: (session?: FakeSession) => ApiContext
  flush: () => Promise<void>
} {
  const sync = new Map<string, StorageItems>()
  const managed: StorageItems = {}
  const out: Dispatched[] = []
  const primary: FakeSession = { name: 'primary' }
  const other: FakeSession = { name: 'other' }
  const live = { frames: [] as FakeSession[], workers: [] as FakeSession[] }
  const woken: FakeSession[] = []
  const loaded: LoadedExtension = {
    id: EXT,
    extension: {} as LoadedExtension['extension'],
    manifest: { manifest_version: manifestVersion, name: 'Probe', version: '1' },
    path: '/tmp/ext',
    sessions: [primary, other] as unknown as LoadedExtension['sessions'],
    unpacked: false,
    withheld: { required: [], optional: [] }
  }
  const host = {
    store: {
      syncItems: (id: string) => sync.get(id) ?? {},
      setSyncItems: (id: string, items: StorageItems) => {
        sync.set(id, items)
      },
      managedItems: () => managed
    },
    registry: {
      framesOf: () => live.frames.map((session) => ({ session })),
      workersOf: () => live.workers.map((session) => ({ session })),
      wakeIn: vi.fn((extensionId: string, session: FakeSession): Promise<void> => {
        expect(extensionId).toBe(EXT)
        woken.push(session)
        return Promise.resolve()
      })
    },
    loaded: (id: string) => (id === EXT ? loaded : undefined),
    dispatch(
      extensionId: string,
      namespace: string,
      event: string,
      args: unknown[],
      options?: { session?: (session: Session) => boolean }
    ): void {
      const entry: Dispatched = { extensionId, event: `${namespace}.${event}`, args }
      if (options?.session) entry.session = options.session
      out.push(entry)
    }
  }
  const api = new StorageApi(host as unknown as ApiHost)
  const ctx = (session: FakeSession = primary): ApiContext =>
    ({
      extensionId: EXT,
      extension: loaded,
      session,
      sender: { kind: 'worker' },
      tabId: null,
      window: undefined
    }) as unknown as ApiContext
  return {
    api,
    out,
    sync,
    managed,
    primary,
    other,
    live,
    woken,
    ctx,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('StorageApi sync mirror', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it('starts a context from a numbered snapshot of sync and managed', () => {
    h.sync.set(EXT, { theme: 'dark' })
    h.managed.policy = true
    expect(h.api.handlers.syncMirror(h.ctx())).toEqual({
      seq: 0,
      sync: { theme: 'dark' },
      managed: { policy: true }
    })
  })

  it('numbers every sync change and pushes it to every context of the extension', async () => {
    h.live.workers.push(h.primary)
    expect(h.api.handlers.set(h.ctx(), 'sync', { theme: 'dark' })).toBeUndefined()
    expect(h.sync.get(EXT)).toEqual({ theme: 'dark' })
    expect(h.out.map((d) => d.event)).toEqual([
      'storage.onChanged',
      'storage.sync.onChanged',
      '__zen.sync-mirror'
    ])
    const mirror = h.out[2]
    expect(mirror.args).toEqual([{ seq: 1, sync: { theme: { newValue: 'dark' } } }])
    // Every partition, not only the caller's: sync is shared by all of them.
    expect(mirror.session).toBeUndefined()
    // A write that changes nothing is not a change.
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'dark' })
    expect(h.out).toHaveLength(3)
    expect(h.api.handlers.syncMirror(h.ctx())).toMatchObject({ seq: 1 })
    h.api.handlers.remove(h.ctx(), 'sync', 'theme')
    expect(h.out[h.out.length - 1].args).toEqual([
      { seq: 2, sync: { theme: { oldValue: 'dark' } } }
    ])
    h.api.handlers.set(h.ctx(), 'sync', { a: 1, b: 2 })
    h.api.handlers.clear(h.ctx(), 'sync')
    expect(h.out[h.out.length - 1].args).toEqual([
      { seq: 4, sync: { a: { oldValue: 1 }, b: { oldValue: 2 } } }
    ])
    // local and session changes are not mirrored (they are the partition's own).
    h.out.length = 0
    h.api.handlers.set(h.ctx(), 'local', { x: 1 })
    expect(h.out.map((d) => d.event)).toEqual(['storage.onChanged', 'storage.local.onChanged'])
    expect(h.out[0].session).toBeDefined()
    await h.flush()
  })

  it('commits a content script write relayed by the shim and answers with the change', async () => {
    h.live.workers.push(h.primary)
    expect(h.api.handlers.syncWrite(h.ctx(), 'set', [{ theme: 'dark', size: 2 }])).toEqual({
      seq: 1,
      sync: { theme: { newValue: 'dark' }, size: { newValue: 2 } }
    })
    expect(h.api.handlers.syncWrite(h.ctx(), 'remove', [['size', 'missing']])).toEqual({
      seq: 2,
      sync: { size: { oldValue: 2 } }
    })
    // Nothing changed: the current number, no change.
    expect(h.api.handlers.syncWrite(h.ctx(), 'remove', ['missing'])).toEqual({ seq: 2 })
    expect(h.api.handlers.syncWrite(h.ctx(), 'clear', [])).toEqual({
      seq: 3,
      sync: { theme: { oldValue: 'dark' } }
    })
    expect(h.sync.get(EXT)).toEqual({})
    // Pages and workers heard every change as sync.onChanged too.
    expect(h.out.filter((d) => d.event === 'storage.sync.onChanged')).toHaveLength(3)
    expect(h.out.filter((d) => d.event === '__zen.sync-mirror').map((d) => d.args[0])).toEqual([
      { seq: 1, sync: { theme: { newValue: 'dark' }, size: { newValue: 2 } } },
      { seq: 2, sync: { size: { oldValue: 2 } } },
      { seq: 3, sync: { theme: { oldValue: 'dark' } } }
    ])
    await h.flush()
  })

  it('refuses malformed relayed writes and enforces the sync quota on them', () => {
    expect(() => h.api.handlers.syncWrite(h.ctx(), 'get', [null])).toThrow('Invalid sync write')
    expect(() => h.api.handlers.syncWrite(h.ctx(), 'set', ['x'])).toThrow('Invalid items')
    expect(() => h.api.handlers.syncWrite(h.ctx(), 'remove', [42])).toThrow('Invalid keys')
    expect(() => h.api.handlers.syncWrite(h.ctx(), 'set', [{ big: 'x'.repeat(9000) }])).toThrow(
      /QUOTA_BYTES_PER_ITEM/
    )
    expect(h.out).toEqual([])
  })

  it('asks the registry to wake the worker of every partition with no live context', async () => {
    h.live.frames.push(h.primary)
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'dark' })
    await h.flush()
    expect(h.woken).toEqual([h.other])
    // Every idle partition, in one go; a live worker or frame in it is enough to skip it.
    h.live.frames.length = 0
    h.live.workers.push(h.other)
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'light' })
    await h.flush()
    expect(h.woken).toEqual([h.other, h.primary])
    // A write that changes nothing wakes nothing.
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'light' })
    await h.flush()
    expect(h.woken).toHaveLength(2)
  })

  it('does not wake workers for an MV2 extension', async () => {
    h = harness(2)
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'dark' })
    await h.flush()
    expect(h.woken).toEqual([])
    expect(h.out.map((d) => d.event)).toContain('__zen.sync-mirror')
  })

  it('keeps the sequence across an unload of the extension', () => {
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'dark' })
    h.api.forget(EXT)
    expect(h.api.handlers.syncMirror(h.ctx())).toMatchObject({ seq: 1 })
    h.api.handlers.set(h.ctx(), 'sync', { theme: 'light' })
    expect(h.out[h.out.length - 1].args).toEqual([
      { seq: 2, sync: { theme: { oldValue: 'dark', newValue: 'light' } } }
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { isFolderLost } from '../../core/sync/transport'
import type { Bridge } from '../bridge'
import {
  ANDROID_POLL_MS,
  AndroidSyncHost,
  AndroidSyncTransport,
  FOLDER_LOST_PREFIX,
  ForegroundSignal
} from '../sync'

/**
 * The Kotlin side as the bridge sees it: `SyncFolder.kt` behind `Host.kt`'s `sync.*` methods,
 * here a map of documents per tree URI plus the rejections Kotlin raises.
 */
function fakeBridge(): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
  trees: Map<string, Map<string, string>>
  lost: Set<string>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const trees = new Map<string, Map<string, string>>()
  const lost = new Set<string>()
  const docs = (folder: string): Map<string, string> => {
    if (lost.has(folder)) throw new Error(`${FOLDER_LOST_PREFIX} the tree's permission is gone`)
    let d = trees.get(folder)
    if (!d) {
      d = new Map()
      trees.set(folder, d)
    }
    return d
  }
  const bridge = {
    async call(method: string, args: Record<string, unknown> = {}) {
      calls.push({ method, args })
      const folder = args.folder as string
      switch (method) {
        case 'sync.chooseFolder':
          return 'content://com.android.externalstorage.documents/tree/primary%3ASync'
        case 'sync.folderName':
          return folder.endsWith('%3ASync') ? 'Sync' : ''
        case 'sync.list':
          return [...docs(folder).keys()]
        case 'sync.read':
          return docs(folder).get(args.name as string) ?? null
        case 'sync.write':
          docs(folder).set(args.name as string, args.text as string)
          return undefined
        case 'sync.remove':
          docs(folder).delete(args.name as string)
          return undefined
        case 'sync.removeAll':
          docs(folder).clear()
          return undefined
        default:
          throw new Error(`unknown method ${method}`)
      }
    }
  } as unknown as Bridge
  return { bridge, calls, trees, lost }
}

const TREE = 'content://com.android.externalstorage.documents/tree/primary%3ASync'

describe('AndroidSyncTransport', () => {
  it('routes list / read / write / remove / removeAll to the sync.* bridge methods with the tree', async () => {
    const { bridge, calls } = fakeBridge()
    const t = new AndroidSyncTransport(bridge, TREE, new ForegroundSignal())
    expect(await t.list()).toEqual([])
    expect(await t.read('device_a.zensync')).toBeNull()
    await t.write('device_a.zensync', '{"deviceId":"a"}')
    await t.write('README.txt', 'Zenium sync data.')
    expect((await t.list()).sort()).toEqual(['README.txt', 'device_a.zensync'])
    expect(await t.read('device_a.zensync')).toBe('{"deviceId":"a"}')
    await t.remove('device_a.zensync')
    expect(await t.list()).toEqual(['README.txt'])
    await t.removeAll()
    expect(await t.list()).toEqual([])
    expect(calls.map((c) => c.method)).toEqual([
      'sync.list',
      'sync.read',
      'sync.write',
      'sync.write',
      'sync.list',
      'sync.read',
      'sync.remove',
      'sync.list',
      'sync.removeAll',
      'sync.list'
    ])
    expect(calls.every((c) => c.args.folder === TREE)).toBe(true)
    expect(calls[2].args).toEqual({
      folder: TREE,
      name: 'device_a.zensync',
      text: '{"deviceId":"a"}'
    })
  })

  it('tolerates a Kotlin answer of the wrong shape', async () => {
    const bridge = {
      call: async (method: string) => (method === 'sync.list' ? [1, 'ok.zensync', null] : 42)
    } as unknown as Bridge
    const t = new AndroidSyncTransport(bridge, TREE, new ForegroundSignal())
    expect(await t.list()).toEqual(['ok.zensync'])
    expect(await t.read('x')).toBeNull()
  })

  it("turns Kotlin's folder-lost rejection into SyncFolderLostError, other errors pass through", async () => {
    const { bridge, lost } = fakeBridge()
    const t = new AndroidSyncTransport(bridge, TREE, new ForegroundSignal())
    await t.write('a.zensync', '1')
    lost.add(TREE)
    await expect(t.list()).rejects.toSatisfy(isFolderLost)
    await expect(t.read('a.zensync')).rejects.toSatisfy(isFolderLost)
    await expect(t.write('a.zensync', '2')).rejects.toSatisfy(isFolderLost)
    await expect(t.remove('a.zensync')).rejects.toSatisfy(isFolderLost)
    await expect(t.removeAll()).rejects.toSatisfy(isFolderLost)
    await expect(t.list()).rejects.toThrow(/permission is gone/)

    const other = new AndroidSyncTransport(
      { call: async () => Promise.reject(new Error('io: disk full')) } as unknown as Bridge,
      TREE,
      new ForegroundSignal()
    )
    const error = await other.list().catch((e: unknown) => e)
    expect(isFolderLost(error)).toBe(false)
    expect((error as Error).message).toBe('io: disk full')
  })

  it('watch fires when the activity comes back to the foreground, not while it stays there', () => {
    const signal = new ForegroundSignal()
    const t = new AndroidSyncTransport(fakeBridge().bridge, TREE, signal)
    let fired = 0
    const stop = t.watch(() => fired++)
    signal.setFocused(true)
    expect(fired).toBe(0)
    signal.setFocused(false)
    expect(fired).toBe(0)
    signal.setFocused(true)
    expect(fired).toBe(1)
    stop()
    signal.setFocused(false)
    signal.setFocused(true)
    expect(fired).toBe(1)
  })
})

describe('AndroidSyncHost', () => {
  it('picks the tree through the system picker and names it; the device is its model', async () => {
    const { bridge, calls } = fakeBridge()
    const host = new AndroidSyncHost(bridge, 'Pixel 9')
    expect(await host.chooseFolder()).toBe(TREE)
    expect(calls[0].method).toBe('sync.chooseFolder')
    expect(await host.folderName(TREE)).toBe('Sync')
    expect(await host.folderName('content://other/tree/x')).toBe('')
    expect(host.deviceNameDefault()).toBe('Pixel 9')
    expect(new AndroidSyncHost(bridge, '   ').deviceNameDefault()).toBe('Android phone')
  })

  it('a dismissed picker is null', async () => {
    const bridge = { call: async () => null } as unknown as Bridge
    expect(await new AndroidSyncHost(bridge, 'Pixel 9').chooseFolder()).toBeNull()
    const empty = { call: async () => '' } as unknown as Bridge
    expect(await new AndroidSyncHost(empty, 'Pixel 9').chooseFolder()).toBeNull()
  })

  it('polls every 30 s in the foreground only and hands the transport the same signal', () => {
    const host = new AndroidSyncHost(fakeBridge().bridge, 'Pixel 9')
    expect(host.pollMs).toBe(ANDROID_POLL_MS)
    expect(ANDROID_POLL_MS).toBe(30_000)
    expect(host.foreground()).toBe(true)
    host.signal.setFocused(false)
    expect(host.foreground()).toBe(false)
    let fired = 0
    host.createTransport(TREE).watch!(() => fired++)
    host.signal.setFocused(true)
    expect(fired).toBe(1)
  })
})

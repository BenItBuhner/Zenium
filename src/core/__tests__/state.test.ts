import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import type { StoreIO } from '../platform'
import { BrowserState } from '../state'
import { createSpace, createTabRecord } from '../model'
import { closedTabEntry } from '../session'

function fakeIo(): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => null,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function state(io: StoreIO): BrowserState {
  const s = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return s
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('BrowserState commits', () => {
  it('persists a commit even when a volatile commit was scheduled first in the same tick', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    s.commit()
    await tick()
    await s.flush()
    expect(io.writes.length).toBeGreaterThan(0)
  })

  it('does not persist for volatile commits alone', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    await tick()
    // flush() writes unconditionally, so look at the store directly: nothing was scheduled.
    expect(io.writes).toEqual([])
  })

  it('notifies listeners once per tick for any mix of commits', async () => {
    const io = fakeIo()
    const s = state(io)
    let calls = 0
    s.subscribe(() => calls++)
    s.commitVolatile()
    s.commit()
    s.commitVolatile()
    await tick()
    expect(calls).toBe(1)
  })

  it('runs afterBroadcast callbacks once the pending broadcast has gone out', async () => {
    const io = fakeIo()
    const s = state(io)
    const order: string[] = []
    s.subscribe(() => order.push('broadcast'))
    s.commit()
    s.afterBroadcast(() => order.push('after'))
    expect(order).toEqual([])
    await tick()
    expect(order).toEqual(['broadcast', 'after'])
  })

  it('runs afterBroadcast callbacks right away when nothing is pending', async () => {
    const io = fakeIo()
    const s = state(io)
    let calls = 0
    s.subscribe(() => calls++)
    let ran = false
    s.afterBroadcast(() => (ran = true))
    expect(ran).toBe(true)
    await tick()
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Recently closed persistence (state.json v3) and "restore previous session" off
// ---------------------------------------------------------------------------

function profile(): { doc: Record<string, unknown>; spaceId: string; ids: string[] } {
  const space = createSpace('Work', '')
  const pinned = createTabRecord({
    spaceId: space.id,
    containerId: 'default',
    url: 'https://p.test/',
    pinned: true
  })
  const a = createTabRecord({ spaceId: space.id, containerId: 'default', url: 'https://a.test/' })
  const b = createTabRecord({ spaceId: space.id, containerId: 'default', url: 'https://b.test/' })
  const essential = createTabRecord({
    spaceId: null,
    containerId: 'default',
    url: 'https://e.test/',
    essential: true
  })
  space.tabIds = [pinned.id, a.id, b.id]
  space.activeTabId = b.id
  const doc = {
    version: 2,
    spaces: [space],
    tabs: [pinned, a, b, essential],
    essentialTabIds: [essential.id],
    activeSpaceId: space.id,
    settings: {},
    windows: [
      {
        id: 'w1',
        bounds: null,
        maximized: false,
        activeSpaceId: space.id,
        selection: { [space.id]: b.id },
        compact: false
      },
      {
        id: 'w2',
        bounds: null,
        maximized: false,
        activeSpaceId: space.id,
        selection: {},
        compact: false
      }
    ]
  }
  return { doc, spaceId: space.id, ids: [pinned.id, a.id, b.id, essential.id] }
}

function stateFrom(doc: unknown): { s: BrowserState; io: ReturnType<typeof fakeIo> } {
  const io = fakeIo()
  io.readSync = () => JSON.stringify(doc)
  const s = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return { s, io }
}

describe('recently closed persistence', () => {
  it('starts empty for profiles written before v3 and round-trips v3 entries', async () => {
    const { doc } = profile()
    const { s, io } = stateFrom(doc)
    expect(s.recentlyClosed).toEqual([])
    const tab = createTabRecord({ spaceId: null, containerId: 'default', url: 'https://c.test/' })
    s.recentlyClosed = [
      closedTabEntry(tab, { spaceId: null, folderId: null, index: 0, windowId: null }, null, 5)
    ]
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      version: number
      recentlyClosed: unknown[]
    }
    expect(written.version).toBe(3)
    expect(written.recentlyClosed).toHaveLength(1)
    const reloaded = stateFrom(written).s
    expect(reloaded.recentlyClosed).toHaveLength(1)
    expect(reloaded.recentlyClosed[0]).toMatchObject({ kind: 'tab', closedAt: 5 })
  })

  it('ignores a corrupt recentlyClosed list', () => {
    const { doc } = profile()
    const { s } = stateFrom({ ...doc, version: 3, recentlyClosed: 'oops' })
    expect(s.recentlyClosed).toEqual([])
  })
})

describe('tab navigation persistence', () => {
  const stack = {
    entries: [
      { url: 'https://a.test/', title: 'A', pageState: 'c2Nyb2xs' },
      { url: 'https://a.test/two', title: 'A two' }
    ],
    index: 1
  }

  it('writes the stacks of the open tabs with the page state and reads them back', async () => {
    const { doc, ids } = profile()
    const [, a] = ids
    const { s, io } = stateFrom(doc)
    expect(s.tabNavigation.size).toBe(0)
    s.tabNavigation.set(a, stack)
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      navigation: Record<string, unknown>
    }
    expect(written.navigation).toEqual({ [a]: stack })
    const reloaded = stateFrom(written).s
    expect(reloaded.tabNavigation.get(a)).toEqual(stack)
  })

  it('leaves out stacks whose tab is gone or private, and drops garbage on load', async () => {
    const { doc, ids } = profile()
    const [, a, b] = ids
    const { s, io } = stateFrom({
      ...doc,
      version: 3,
      navigation: {
        [a]: stack,
        [b]: { entries: [{ url: '' }, { title: 'no url' }, 7], index: 0 },
        ghost: stack,
        nonsense: 'oops'
      }
    })
    expect([...s.tabNavigation.keys()]).toEqual([a, 'ghost'])
    s.model.tabs[b].containerId = 'private'
    s.tabNavigation.set(b, stack)
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      navigation: Record<string, unknown>
    }
    expect(Object.keys(written.navigation)).toEqual([a])
    expect(s.tabNavigation.has('ghost')).toBe(false)
    expect(s.tabNavigation.has(b)).toBe(false)
  })
})

describe('forgetSession', () => {
  it('drops regular tabs, keeps pinned tabs and essentials, and leaves one window without a selection', () => {
    const { doc, ids } = profile()
    const [pinned, a, b, essential] = ids
    const { s } = stateFrom(doc)
    expect(Object.keys(s.model.tabs)).toHaveLength(4)
    expect(s.restoredWindows).toHaveLength(2)
    s.forgetSession()
    expect(Object.keys(s.model.tabs).sort()).toEqual([pinned, essential].sort())
    expect(s.model.tabs[a]).toBeUndefined()
    expect(s.model.tabs[b]).toBeUndefined()
    expect(s.model.spaces[0].tabIds).toEqual([pinned])
    expect(s.model.essentialTabIds).toEqual([essential])
    expect(s.restoredWindows).toHaveLength(1)
    expect(s.restoredWindows[0].selection).toEqual({})
  })
})

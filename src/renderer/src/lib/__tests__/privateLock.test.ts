// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'

/*
 * The chrome's half of "Lock private tabs when you leave Zenium" (INC-05 / SET-17): the host's
 * word on the lock is kept and read against the tab in front, the cover's Unlock asks the host
 * once and keeps the lock as the host answers it, a released lock lifts the cover before the
 * page comes back, and the Settings switch is confirmed by the device before the core keeps it.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const {
  LIFT_MAX_MS,
  PRIVATE_LOCK_SWITCH_REASON,
  PRIVATE_UNLOCK_REASON,
  applyPrivateLock,
  liftLanded,
  privateCoverUp,
  privateLockStore,
  privateTabLocked,
  resetPrivateLock,
  setPrivateLockHost,
  setPrivateLockOnLeave,
  unlockPrivateTabs
} = await import('../privateLock')
const { browserStore } = await import('../ui')

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's1',
    containerId: 'default',
    url: `https://${id}.example`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    fromIntent: false,
    webApp: null,
    ...patch
  } as Tab
}

function stateWith(activeTabId: 'r1' | 'x1'): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: ['r1', 'x1'],
    activeTabId,
    pinnedCollapsed: false
  }
  return {
    tabs: { r1: tab('r1'), x1: tab('x1', { containerId: PRIVATE_CONTAINER_ID }) },
    essentialTabIds: [],
    spaces: [space],
    activeSpaceId: 's1',
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

/** A host whose prompt answers as scripted. */
function host(answers: { unlock?: boolean; verify?: boolean } = {}): {
  unlock: ReturnType<typeof vi.fn>
  verify: ReturnType<typeof vi.fn>
} {
  const h = {
    unlock: vi.fn(async () => ({ locked: !(answers.unlock ?? true) })),
    verify: vi.fn(async () => answers.verify ?? true)
  }
  setPrivateLockHost(h)
  return h
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPrivateLock()
  invoke.mockClear()
  browserStore.set({ state: stateWith('x1') })
})

afterEach(() => {
  resetPrivateLock()
  vi.useRealTimers()
})

describe("the host's word on the lock", () => {
  it('is kept as it arrives, the screen lock with it, and read against the tab in front', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    expect(privateLockStore.get()).toMatchObject({ locked: true, screenLock: true, lifting: false })
    // A private tab in front is covered; a regular one is not, whatever the lock.
    expect(privateTabLocked(stateWith('x1'))).toBe(true)
    expect(privateTabLocked(stateWith('r1'))).toBe(false)
    expect(privateCoverUp(stateWith('x1'))).toBe(true)
    expect(privateCoverUp(stateWith('r1'))).toBe(false)
    // A word that says nothing of the lock leaves it: only the screen lock changes.
    applyPrivateLock({ screenLock: false })
    expect(privateLockStore.get()).toMatchObject({ locked: true, screenLock: false })
    // Nonsense is not taken.
    applyPrivateLock({ locked: 'yes', screenLock: 1 })
    expect(privateLockStore.get()).toMatchObject({ locked: true, screenLock: false })
  })

  it('a lock that came off under the cover lifts it: the page stays hidden until the lift lands, or LIFT_MAX_MS', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    applyPrivateLock({ locked: false })
    expect(privateLockStore.get()).toMatchObject({ locked: false, lifting: true })
    // Lifting, the cover is still up over the private tab: the page view is hidden under it.
    expect(privateCoverUp(stateWith('x1'))).toBe(true)
    expect(privateTabLocked(stateWith('x1'))).toBe(false)
    // The cover lands: the page comes back.
    liftLanded()
    expect(privateLockStore.get().lifting).toBe(false)
    expect(privateCoverUp(stateWith('x1'))).toBe(false)

    // A cover that never lands (none was up to run the lift) is not waited on past the limit.
    applyPrivateLock({ locked: true })
    applyPrivateLock({ locked: false })
    expect(privateLockStore.get().lifting).toBe(true)
    vi.advanceTimersByTime(LIFT_MAX_MS - 1)
    expect(privateLockStore.get().lifting).toBe(true)
    vi.advanceTimersByTime(1)
    expect(privateLockStore.get().lifting).toBe(false)
  })

  it('a lock that came off with a regular tab in front has nothing to lift: no lifting, the page never hid', () => {
    browserStore.set({ state: stateWith('r1') })
    applyPrivateLock({ locked: true })
    applyPrivateLock({ locked: false })
    expect(privateLockStore.get()).toMatchObject({ locked: false, lifting: false })
  })

  it('a lock again during a lift ends the lift: the cover is at rest', () => {
    applyPrivateLock({ locked: true })
    applyPrivateLock({ locked: false })
    expect(privateLockStore.get().lifting).toBe(true)
    applyPrivateLock({ locked: true })
    expect(privateLockStore.get()).toMatchObject({ locked: true, lifting: false })
  })
})

describe("the cover's Unlock", () => {
  it('asks the host for the prompt once, busy meanwhile, and a pass lifts the cover', async () => {
    const h = host({ unlock: true })
    applyPrivateLock({ locked: true, screenLock: true })
    const first = unlockPrivateTabs()
    expect(privateLockStore.get().prompting).toBe(true)
    // A second press while the prompt is up asks nothing more.
    await unlockPrivateTabs()
    expect(h.unlock).toHaveBeenCalledTimes(1)
    expect(h.unlock).toHaveBeenCalledWith(PRIVATE_UNLOCK_REASON)
    await first
    expect(privateLockStore.get()).toMatchObject({ locked: false, prompting: false, lifting: true })
  })

  it('a cancel or a failure keeps the lock: the cover stays, the prompt carried its own message', async () => {
    const h = host({ unlock: false })
    applyPrivateLock({ locked: true, screenLock: true })
    await unlockPrivateTabs()
    expect(h.unlock).toHaveBeenCalledTimes(1)
    expect(privateLockStore.get()).toMatchObject({ locked: true, prompting: false, lifting: false })
    // The bridge failing the call is the same: the lock stands.
    h.unlock.mockRejectedValueOnce(new Error('bridge'))
    await unlockPrivateTabs()
    expect(privateLockStore.get()).toMatchObject({ locked: true, prompting: false })
  })

  it('asks nothing without a lock, and nothing without a host (a desktop, the preview)', async () => {
    const h = host({ unlock: true })
    await unlockPrivateTabs()
    expect(h.unlock).not.toHaveBeenCalled()
    setPrivateLockHost(null)
    applyPrivateLock({ locked: true })
    await unlockPrivateTabs()
    expect(privateLockStore.get().locked).toBe(true)
  })
})

describe('the Settings switch', () => {
  it('is confirmed by the device first, on and off, then kept by the core, device-local (private.setLockOnLeave)', async () => {
    const h = host({ verify: true })
    applyPrivateLock({ screenLock: true })
    await expect(setPrivateLockOnLeave(true)).resolves.toBe(true)
    expect(h.verify).toHaveBeenCalledWith(PRIVATE_LOCK_SWITCH_REASON)
    expect(invoke).toHaveBeenCalledWith('private.setLockOnLeave', { enabled: true })
    // Off is confirmed the same way: else turning the lock off would be the way past it.
    await expect(setPrivateLockOnLeave(false)).resolves.toBe(true)
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('private.setLockOnLeave', { enabled: false })
    expect(privateLockStore.get().confirming).toBe(false)
  })

  it('a cancelled confirmation changes nothing', async () => {
    host({ verify: false })
    applyPrivateLock({ screenLock: true })
    await expect(setPrivateLockOnLeave(true)).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does nothing without a screen lock (the row is disabled), nor while a confirmation is up', async () => {
    const h = host({ verify: true })
    applyPrivateLock({ screenLock: false })
    await expect(setPrivateLockOnLeave(true)).resolves.toBe(false)
    expect(h.verify).not.toHaveBeenCalled()
    applyPrivateLock({ screenLock: true })
    const first = setPrivateLockOnLeave(true)
    expect(privateLockStore.get().confirming).toBe(true)
    await expect(setPrivateLockOnLeave(false)).resolves.toBe(false)
    await first
    expect(h.verify).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('a chrome with no host to ask is taken at its word (the preview)', async () => {
    applyPrivateLock({ screenLock: true })
    await expect(setPrivateLockOnLeave(true)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('private.setLockOnLeave', { enabled: true })
  })
})

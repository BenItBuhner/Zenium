// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space, UIState } from '@shared/types'

vi.mock('../../api', () => ({
  cmd: vi.fn(async () => 'data:image/png;base64,captured'),
  run: vi.fn()
}))
vi.mock('../../portals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../portals')>()
  return { ...actual, openPopover: vi.fn(() => vi.fn()) }
})

import { cmd } from '../../api'
import { browserStore, holdFloatingChrome, uiStore } from '../../ui'
import { closeExtensionPopup, openExtensionPopup } from '../popup'

const TAB = 'tab_1'
const PUZZLE = {
  x: 274,
  y: 44,
  width: 28,
  height: 28,
  bar: { x: 8, y: 42, width: 324, height: 32 }
}

/** One space with one tab, active. */
function stateWith(tabId: string): UIState {
  const space: Space = {
    id: 's1',
    name: 'Default',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [tabId],
    activeTabId: tabId,
    pinnedCollapsed: false
  }
  return {
    tabs: { [tabId]: { id: tabId } },
    essentialTabIds: [],
    spaces: [space],
    activeSpaceId: 's1',
    folders: {},
    glance: null,
    settings: {}
  } as unknown as UIState
}

const snapshotCalls = (): number =>
  vi.mocked(cmd).mock.calls.filter(([name]) => name === 'overlay.snapshot').length

describe('openExtensionPopup and the page capture', () => {
  beforeEach(() => {
    vi.mocked(cmd).mockClear()
    browserStore.set({ state: stateWith(TAB) })
    uiStore.set({ snapshot: null, snapshotTabId: null, floatingChrome: 0, extensionPopup: null })
  })
  afterEach(() => {
    closeExtensionPopup()
  })

  it('from a toolbar button: the page is captured first, then the frame goes up', async () => {
    openExtensionPopup('ext', PUZZLE, true)
    expect(uiStore.get().extensionPopup).toBeNull()
    expect(snapshotCalls()).toBe(1)
    await vi.waitFor(() => expect(uiStore.get().extensionPopup?.id).toBe('ext'))
    expect(uiStore.get().snapshot).toBe('data:image/png;base64,captured')
    expect(uiStore.get().snapshotTabId).toBe(TAB)
  })

  it('from the puzzle panel: the frame takes over the capture the panel holds, in the same turn', async () => {
    // The panel: a floating popover holding the page's capture.
    const panel = holdFloatingChrome(TAB)
    await panel.ready
    expect(uiStore.get().floatingChrome).toBe(1)
    expect(snapshotCalls()).toBe(1)

    // A row's press: the popup opens and the panel closes. Its release runs in React's flush of
    // that close – a microtask away – so the popup's entry must be in the store before then.
    openExtensionPopup('ext', PUZZLE, true)
    expect(uiStore.get().extensionPopup?.id).toBe('ext')
    panel.release()

    expect(uiStore.get().floatingChrome).toBe(0)
    expect(uiStore.get().snapshot).toBe('data:image/png;base64,captured')
    expect(uiStore.get().snapshotTabId).toBe(TAB)
    // No second capture: the view is hidden behind the panel and could not give one.
    expect(snapshotCalls()).toBe(1)
  })

  it("keeps the puzzle panel's alignment on its store entry, and none from a pinned button", async () => {
    // From the panel: the popup replaces it on the same button and takes its resolved alignment
    // (§9.20's continuity clause); the frame re-places with it on every render.
    const panel = holdFloatingChrome(TAB)
    await panel.ready
    openExtensionPopup('ext', PUZZLE, true, { alignment: 'start' })
    expect(uiStore.get().extensionPopup?.alignment).toBe('start')
    panel.release()
    closeExtensionPopup()
    // From a pinned toolbar button: nothing to inherit, §9.20's order decides.
    openExtensionPopup('ext', PUZZLE, true)
    await vi.waitFor(() => expect(uiStore.get().extensionPopup?.id).toBe('ext'))
    expect(uiStore.get().extensionPopup?.alignment).toBeUndefined()
  })

  it('closing the popup drops the capture once nothing is over the content', async () => {
    openExtensionPopup('ext', PUZZLE, true)
    await vi.waitFor(() => expect(uiStore.get().extensionPopup?.id).toBe('ext'))
    closeExtensionPopup()
    expect(uiStore.get().extensionPopup).toBeNull()
    expect(uiStore.get().snapshot).toBeNull()
  })
})

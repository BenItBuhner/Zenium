import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { MenuDescriptor, MenuItemDescriptor, Tab, UIState } from '@shared/types'
import { run } from '../api'
import { browserStore } from '../browserStore'
import { viewportStore } from '../formFactor'
import { applyDrawn, applyLayout, pageViewStore } from '../pageView'
import { readerCrossingStore } from '../readerTransition'
import { pickMenuItem, uiStore } from '../ui'

/*
 * The menu's Reader View row (the app menu's, the page menu's; `action: 'page.readerMode'` on
 * its descriptor) picked on the phone: `pickMenuItem` begins the reader crossing (MOT-36,
 * `lib/readerTransition.ts`) on the sheet's own picture of the page in the same turn – before
 * the menu's clearing would let the live page back – and the core's `menu.click` runs inside
 * it, once the page is off the screen. Off the phone the pick is as it was: the item runs two
 * frames after the pick, nothing else.
 */

const frames: Array<() => void> = []

function paintTwice(): void {
  for (let i = 0; i < 2; i++) {
    const batch = frames.splice(0)
    for (const cb of batch) cb()
  }
}

function item(
  id: string,
  label: string,
  patch: Partial<MenuItemDescriptor> = {}
): MenuItemDescriptor {
  return { id, type: 'normal', label, enabled: true, checked: false, submenu: null, ...patch }
}

function appMenu(): MenuDescriptor {
  return {
    id: 'menu_3',
    source: 'app',
    x: null,
    y: null,
    items: [
      item('menu_3_1', 'Find in Page…', { action: 'find.open' }),
      item('menu_3_2', 'Reader View', { action: 'page.readerMode' })
    ]
  }
}

function state(platform: UIState['platform']): UIState {
  const tab = { id: 't1', url: 'https://news.example.com/story', loading: false } as Tab
  return {
    platform,
    tabs: { t1: tab },
    spaces: [{ id: 's1', activeTabId: 't1' }],
    activeSpaceId: 's1',
    settings: { reader: { theme: 'light' } }
  } as unknown as UIState
}

const calls = (name: string): unknown[][] => vi.mocked(run).mock.calls.filter(([n]) => n === name)

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb)
    return frames.length
  })
  readerCrossingStore.set({ crossing: null })
  pageViewStore.set({ phases: new Map(), lastApplied: null })
})

afterEach(() => {
  uiStore.set({ menu: null, snapshot: null, snapshotTabId: null })
  readerCrossingStore.set({ crossing: null })
  browserStore.set({ state: null })
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
})

describe('the Reader View row’s pick', () => {
  it('on a desktop chassis runs the item two frames later, as any pick, and begins no crossing', () => {
    browserStore.set({ state: state('linux') })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    uiStore.set({ menu: appMenu() })
    pickMenuItem('menu_3_2')
    expect(uiStore.get().menu).toBeNull()
    expect(readerCrossingStore.get().crossing).toBeNull()
    expect(calls('menu.click')).toEqual([])
    paintTwice()
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_3', itemId: 'menu_3_2' }]])
  })

  it('on the phone begins the crossing on the sheet’s picture in the same turn, the click running once the page is off the screen', async () => {
    browserStore.set({ state: state('android') })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    // The sheet holds the page's picture (the page is under it, off the screen).
    uiStore.set({ menu: appMenu(), snapshot: 'data:sheet-picture', snapshotTabId: 't1' })
    pageViewStore.set(
      applyDrawn(
        applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] }),
        't1',
        false
      )
    )
    pickMenuItem('menu_3_2')
    // Synchronously: the crossing stands on the held picture, so the page never comes back
    // between the sheet's going and the surface's coming.
    expect(readerCrossingStore.get().crossing).toMatchObject({
      tabId: 't1',
      crossing: 'enter',
      phase: 'covering',
      picture: 'data:sheet-picture'
    })
    expect(uiStore.get().menu).toBeNull()
    expect(calls('menu.click')).toEqual([])
    await flush()
    // Covered already: the surface fades and the core is asked to cross, two frames on.
    expect(readerCrossingStore.get().crossing?.phase).toBe('loading')
    expect(calls('menu.click')).toEqual([])
    paintTwice()
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_3', itemId: 'menu_3_2' }]])
  })

  it('another row of the same menu on the phone is the plain pick', () => {
    browserStore.set({ state: state('android') })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    uiStore.set({ menu: appMenu() })
    pickMenuItem('menu_3_1')
    expect(readerCrossingStore.get().crossing).toBeNull()
    paintTwice()
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_3', itemId: 'menu_3_1' }]])
  })
})

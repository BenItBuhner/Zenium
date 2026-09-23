import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { run } from '../api'
import { pickMenuItem, showLocalMenu, uiStore } from '../ui'

/*
 * A pick of a renderer-drawn menu (`pickMenuItem`): the page gets the focus back at the pick
 * (`focus.content`) and the item runs two frames later (`menu.click`) – except for an item whose
 * action mounts a field of the chrome's own (`keepsKeyboard`: Rename Group…, Rename Tab…), whose
 * pick leaves the keyboard in the chrome: the host's focus move would otherwise land on the page
 * while the field is mounting and blur it away before the user could type (the tablet's rename,
 * nightly `tablet-groups` §6). Every other pick, a local menu's included, keeps today's hand-back.
 */

const frames: Array<() => void> = []

/** Both frames the pick defers its action by. */
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

function groupMenu(): MenuDescriptor {
  return {
    id: 'menu_7',
    source: 'folder',
    x: 120,
    y: 240,
    items: [
      item('menu_7_1', 'Rename Group…', { keepsKeyboard: true }),
      item('menu_7_2', 'Colour', {
        submenu: [
          item('menu_7_3', 'Grey', { type: 'radio' }),
          item('menu_7_4', 'Rename Deep…', { keepsKeyboard: true })
        ]
      }),
      item('menu_7_5', 'New Tab in Group'),
      item('menu_7_6', 'Delete Group', { danger: true })
    ]
  }
}

const calls = (name: string): unknown[][] => vi.mocked(run).mock.calls.filter(([n]) => n === name)

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb)
    return frames.length
  })
})

afterEach(() => {
  uiStore.set({ menu: null })
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
})

describe('pickMenuItem and the keyboard', () => {
  it('an ordinary pick hands the focus back to the page at once and runs the item two frames later', () => {
    uiStore.set({ menu: groupMenu() })
    pickMenuItem('menu_7_5')
    expect(uiStore.get().menu).toBeNull()
    expect(calls('focus.content')).toEqual([['focus.content', undefined]])
    expect(calls('menu.click')).toEqual([])
    paintTwice()
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_7', itemId: 'menu_7_5' }]])
  })

  it('a pick that mounts a chrome field (keepsKeyboard) fires no focus.content – the item still runs', () => {
    uiStore.set({ menu: groupMenu() })
    pickMenuItem('menu_7_1')
    expect(uiStore.get().menu).toBeNull()
    expect(calls('focus.content')).toEqual([])
    paintTwice()
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_7', itemId: 'menu_7_1' }]])
    expect(calls('focus.content')).toEqual([])
  })

  it('the flag is read at any depth: a submenu item that keeps the keyboard keeps it, its sibling does not', () => {
    uiStore.set({ menu: groupMenu() })
    pickMenuItem('menu_7_4')
    paintTwice()
    expect(calls('focus.content')).toEqual([])
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_7', itemId: 'menu_7_4' }]])
    vi.mocked(run).mockClear()

    uiStore.set({ menu: groupMenu() })
    pickMenuItem('menu_7_3')
    paintTwice()
    expect(calls('focus.content')).toEqual([['focus.content', undefined]])
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_7', itemId: 'menu_7_3' }]])
  })

  it('a pick of an item the menu does not hold hands the focus back as an ordinary pick does', () => {
    uiStore.set({ menu: groupMenu() })
    pickMenuItem('menu_7_99')
    paintTwice()
    expect(calls('focus.content')).toEqual([['focus.content', undefined]])
    expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_7', itemId: 'menu_7_99' }]])
  })

  it('a local menu’s pick is unchanged: the focus goes back to the page and its handler runs, the host told nothing', async () => {
    const onSelect = vi.fn()
    await showLocalMenu('bookmark', [{ label: 'Open in New Tab', onSelect }], null)
    const menu = uiStore.get().menu
    expect(menu).not.toBeNull()
    vi.mocked(run).mockClear()
    pickMenuItem(menu!.items[0]!.id)
    expect(calls('focus.content')).toEqual([['focus.content', undefined]])
    expect(onSelect).not.toHaveBeenCalled()
    paintTwice()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(calls('menu.click')).toEqual([])
  })
})

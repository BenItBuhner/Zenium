// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { MenuSheet } from '../MenuSheet'
import { MENU_LIFT_SCALE } from '../menuReorder'
import { auditNames, formatNameFindings } from '@renderer/lib/a11yNames'
import { applyAccessibilityState, resetAccessibilityState } from '@renderer/lib/accessibilityState'
import { viewportStore } from '@renderer/lib/formFactor'
import { SheetPresence } from '@renderer/lib/motion/presence'
import { uiStore } from '@renderer/lib/ui'

/*
 * The phone app menu's edit mode (Edge's Change menu, TB-22; MOT-23), rendered for real in
 * happy-dom: the Change Menu row swaps the sheet's body for the edit pose in place – the same
 * items with the same glyphs under the title "Change Menu" and a Done control – where a hold
 * lifts an item (scale 1.02 over 120 ms, its cell out of the FLIP set and marked held), the
 * finger carries it over its section's slots, the draft follows the slot its centre is nearest
 * and the neighbours glide, the drop glides home and Done writes `settings.menuOrder`; a cut
 * under reduced motion. Without the gesture (A11Y-10): under touch exploration every item
 * carries its place in its name and is followed by Move up / Move down / Move to start, read
 * back through the live region. Reset puts the default back; every way out of the pose saves.
 * The frame loop is cranked by hand and the layout given sizes (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class Frames {
  now = 1000
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => undefined)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const frame = (): void => {
  act(() => frames.run(1))
}

/** Run every scheduled frame to quiet; a drag in flight keeps its scroll loop scheduled, so only after the drop. */
function runAll(max = 200): number {
  let n = 0
  for (; n < max && frames.scheduled; n++) frame()
  return n
}

const elapse = (ms: number): void => {
  act(() => void vi.advanceTimersByTime(ms))
}

// --- the menu ---------------------------------------------------------------------------------

let n = 0
function item(label: string, patch: Partial<MenuItemDescriptor> = {}): MenuItemDescriptor {
  return {
    id: `menu_1_${++n}`,
    type: 'normal',
    label,
    enabled: true,
    checked: false,
    submenu: null,
    ...patch
  }
}
const sep = (key?: string): MenuItemDescriptor =>
  item('', { type: 'separator', ...(key ? { key } : {}) })

const DEFAULT_ORDER = [
  'icon.forward',
  'icon.bookmark',
  'icon.reload',
  'row.newTab',
  'row.newPrivateTab',
  'sep.1',
  'row.history',
  'row.settings'
]

/** The phone app menu as the core composes it, in the default order unless `order` says otherwise. */
function appMenu(order: readonly string[] = DEFAULT_ORDER): MenuDescriptor {
  n = 0
  const byKey: Record<string, MenuItemDescriptor> = {
    'icon.forward': item('Forward', { glyph: 'forward', enabled: false, key: 'icon.forward' }),
    'icon.bookmark': item('Bookmark', { glyph: 'star', key: 'icon.bookmark' }),
    'icon.reload': item('Reload', { glyph: 'reload', key: 'icon.reload' }),
    'row.newTab': item('New Tab', { key: 'row.newTab' }),
    'row.newPrivateTab': item('New Private Tab', { key: 'row.newPrivateTab' }),
    'sep.1': sep('sep.1'),
    'row.history': item('History', { key: 'row.history' }),
    'row.settings': item('Settings', { key: 'row.settings' })
  }
  const row = order.filter((k) => k.startsWith('icon.')).map((k) => byKey[k])
  const list = order.filter((k) => !k.startsWith('icon.')).map((k) => byKey[k])
  return {
    id: 'menu_1',
    source: 'app',
    x: null,
    y: null,
    defaultOrder: DEFAULT_ORDER,
    items: [...row, sep(), ...list, sep(), item('Change Menu', { key: 'menu.change' })]
  }
}

const layer = (m: MenuDescriptor): ReactElement => (
  <SheetPresence>
    <MenuSheet key={m.id} menu={m} />
  </SheetPresence>
)

async function show(m: MenuDescriptor): Promise<void> {
  uiStore.set({ menu: m })
  render(layer(m))
  await settle()
  frames.run(60)
}

// --- reading the sheet --------------------------------------------------------------------------

const sheetRows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.zen-sheet-item')
]
const rowByText = (text: string): HTMLButtonElement =>
  sheetRows().find((b) => b.textContent === text)!
const textRows = (): string[] => sheetRows().map((b) => b.textContent ?? '')
const iconButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.zen-menu-icon-row .zen-v2-icon-button')
]
const title = (): string => document.querySelector('.zen-sheet-title')?.textContent ?? ''
const editor = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-menu-edit]')
const done = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-menu-done]')
const reset = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-menu-reset]')!
const editItems = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-menu-edit] [data-menu-key]')
]
const editItem = (label: string): HTMLButtonElement =>
  editItems().find((b) => b.dataset.menuKey && b.getAttribute('aria-label')?.startsWith(label))!
const cellOf = (label: string): HTMLElement => editItem(label).parentElement!
const keyOfCell = (li: HTMLElement): string =>
  li.dataset.cell ?? li.querySelector<HTMLElement>('[data-menu-key]')?.dataset.menuKey ?? '?'
const rowKeys = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>('[data-menu-edit] ul[aria-label="Page actions"] > li')
  ].map(keyOfCell)
const listKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-menu-edit] ul[aria-label="Menu"] > li')].map(
    keyOfCell
  )
const moveControl = (label: string, which: 'up' | 'down' | 'start'): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>(`[data-menu-move="${which}"]`)].find((b) =>
    b.textContent?.includes(` ${label} `)
  )!
const announcement = (): string =>
  document.querySelector('[data-menu-edit-announcement]')?.textContent ?? ''
const commands = (name: string): unknown[] =>
  invoke.mock.calls.filter(([nm]) => nm === name).map(([, args]) => args)
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const escape = (): void => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
}
const translateY = (el: HTMLElement): number => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? Number(m[2]) : 0
}

// --- the geometry, by hand ------------------------------------------------------------------------

const ROW_H = 44
const SEP_H = 17
const LIST_Y = 160
const ICON_Y = 100
const ICON_X = 16
const ICON_STEP = 60
const heightOf = (li: HTMLElement): number =>
  li.classList.contains('zen-sheet-sep') ? (li.hasAttribute('data-collapsed') ? 0 : SEP_H) : ROW_H

/**
 * Every cell of the edit pose measures at its slot in DOM order – the icon row's side by side
 * at 60 from x 16, the list's one under another from y 160, rows 44 and hairlines 17 (0 when
 * collapsed) – and an item's button at its cell's slot, grown about its centre by a scale its
 * own transform carries; the sheet's body is a tall box the finger never reaches the edge of.
 */
function layOut(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('zen-sheet-scroll')) return new DOMRect(0, 0, 400, 800)
    const cell = this.closest<HTMLElement>('[data-menu-edit] li')
    const list = cell?.parentElement
    if (!cell || !list || !list.hasAttribute('aria-label')) return new DOMRect(0, 0, 0, 0)
    const siblings = [...list.children] as HTMLElement[]
    const index = siblings.indexOf(cell)
    let slot: DOMRect
    if (list.classList.contains('zen-menu-icon-row')) {
      slot = new DOMRect(ICON_X + index * ICON_STEP, ICON_Y, ROW_H, ROW_H)
    } else {
      let y = LIST_Y
      for (let i = 0; i < index; i++) y += heightOf(siblings[i])
      slot = new DOMRect(0, y, 400, heightOf(cell))
    }
    const scale = /scale\(([\d.]+)\)/.exec((this as HTMLElement).style?.transform ?? '')
    if (!scale || this === cell) return slot
    const k = Number(scale[1])
    return new DOMRect(
      slot.x - (slot.width * (k - 1)) / 2,
      slot.y - (slot.height * (k - 1)) / 2,
      slot.width * k,
      slot.height * k
    )
  })
}
/** The centre of the list's slot at `index`, in DOM order as laid out now. */
function listSlotCentre(index: number): { x: number; y: number } {
  const cells = [
    ...document.querySelectorAll<HTMLElement>('[data-menu-edit] ul[aria-label="Menu"] > li')
  ]
  let y = LIST_Y
  for (let i = 0; i < index; i++) y += heightOf(cells[i])
  return { x: 200, y: y + heightOf(cells[index]) / 2 }
}

const POINTER = 7
function pointer(type: string, target: EventTarget, x: number, y: number): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    isPrimary: true
  })
  Object.defineProperty(event, 'timeStamp', { value: frames.now })
  act(() => void target.dispatchEvent(event))
  return event
}
/** Hold the item until it lifts; the finger at its slot's centre. */
function pickUp(label: string): { x: number; y: number } {
  const el = editItem(label)
  const r = el.parentElement!.getBoundingClientRect()
  const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  el.setPointerCapture = vi.fn()
  pointer('pointerdown', el, at.x, at.y)
  elapse(380)
  return at
}

async function openEditor(m: MenuDescriptor = appMenu()): Promise<void> {
  await show(m)
  click(rowByText('Change Menu'))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  frames.install()
  frames.now = 1000
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
  invoke.mockClear()
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
  viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
  layOut()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ menu: null })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as { matchMedia?: unknown }).matchMedia
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
  act(() => resetAccessibilityState())
})

describe('the Change Menu row and the edit pose', () => {
  it('Change Menu is the sheet’s last row; picking it opens the edit pose in place – no pick reaches the core, the sheet stays – under the title "Change Menu" with a Done control, the same items in the same order with their glyphs, each named with its place, the hairline a slot', async () => {
    await show(appMenu())
    expect(textRows().at(-1)).toBe('Change Menu')
    expect(iconButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Forward',
      'Bookmark',
      'Reload'
    ])
    click(rowByText('Change Menu'))
    await settle()
    expect(commands('menu.click')).toEqual([])
    expect(uiStore.get().menu).not.toBeNull()
    expect(editor()).not.toBeNull()
    expect(title()).toBe('Change Menu')
    expect(done()?.textContent).toBe('Done')
    expect(done()?.matches('.zen-sheet-header-control[data-side="trailing"][data-text]')).toBe(true)
    // The icon row's items stay icon buttons in the row's own rule, their glyphs kept, enabled
    // whatever the item's own state (a disabled control is nothing a finger can hold).
    expect(rowKeys()).toEqual(['icon.forward', 'icon.bookmark', 'icon.reload'])
    const rowButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-menu-edit] .zen-menu-icon-row .zen-v2-icon-button'
      )
    ]
    expect(rowButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Forward, 1 of 3',
      'Bookmark, 2 of 3',
      'Reload, 3 of 3'
    ])
    expect(rowButtons.map((b) => b.dataset.glyph)).toEqual(['forward', 'star', 'reload'])
    expect(rowButtons.every((b) => !b.disabled && b.querySelector('svg'))).toBe(true)
    // The list's rows in their order, the group hairline a cell between them.
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-menu-edit] .zen-sheet-item[data-menu-key]'
        )
      ].map((b) => b.getAttribute('aria-label'))
    ).toEqual(['New Tab, 1 of 4', 'New Private Tab, 2 of 4', 'History, 3 of 4', 'Settings, 4 of 4'])
    expect(editItem('History').querySelector('.zen-menu-edit-grip')).not.toBeNull()
    // No row of the pose is a command: nothing lists the Change Menu row, no chevron, no check.
    expect(editItems().some((b) => b.getAttribute('aria-label')?.startsWith('Change Menu'))).toBe(
      false
    )
    // Reset has nothing to put back at the default; every control is named (A11Y-10).
    expect(reset().disabled).toBe(true)
    expect(reset().textContent).toBe('Reset to Default')
    expect(formatNameFindings(auditNames(document.body))).toBe('')
    // A tap on an item runs nothing.
    click(editItem('History'))
    runAll()
    expect(commands('menu.click')).toEqual([])
    expect(editor()).not.toBeNull()
  })

  it('Done with nothing moved writes nothing and returns to the normal pose, its names as they were', async () => {
    await openEditor()
    click(done()!)
    await settle()
    expect(editor()).toBeNull()
    expect(done()).toBeNull()
    expect(title()).toBe('Zenium')
    expect(commands('settings.update')).toEqual([])
    expect(iconButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Forward',
      'Bookmark',
      'Reload'
    ])
    expect(document.querySelector('.zen-menu-icon-row')?.getAttribute('aria-label')).toBe(
      'Page actions'
    )
    expect(textRows()).toEqual(['New Tab', 'New Private Tab', 'History', 'Settings', 'Change Menu'])
    expect(uiStore.get().menu).not.toBeNull()
  })

  it('the pose’s rules draw in tokens alone and the Done control is the header control’s own box', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const held = /\.zen-menu-edit li\[data-held\] > \.zen-menu-edit-item \{([^}]*)\}/.exec(css)![1]
    expect(held).toContain('background: var(--v2-panel)')
    expect(held).toContain('box-shadow: var(--zen-shadow-2)')
    expect(held).toContain('opacity: 0.9')
    const block = css.slice(
      css.indexOf('.zen-menu-edit li {'),
      css.indexOf('.zen-menu-edit .zen-sheet-sep[data-collapsed]')
    )
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    const text = /\.zen-sheet-header-control\[data-text\] \{([^}]*)\}/.exec(css)![1]
    expect(text).toContain('color: var(--v2-accent)')
    expect(text).toContain('font-weight: var(--v2-weight-button)')
    expect(text).toContain('padding: 0 12px')
  })

  it('the card in the hand is one look from the hold on: the icon card’s press fill yields to the panel while its cell is held (an unlayered rule, as the press rule is), and the row’s card paints inset on its pseudo-element so its 1.02 lands on the row’s edges inside the scroll box', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const press =
      /\.zen-menu-edit li\[data-held\] > \.zen-v2-icon-button\.zen-menu-edit-item:active:not\(:disabled\) \{([^}]*)\}/.exec(
        css
      )
    expect(press).not.toBeNull()
    expect(press![1]).toContain('background: var(--v2-panel)')
    // Outside every @layer: the press rule it answers is unlayered, and an unlayered rule wins
    // over a layered one whatever the specificity.
    const at = css.indexOf(press![0])
    const opened = (css.slice(0, at).match(/@layer\s+\w+\s*\{/g) ?? []).length
    const closedBlocks = css.slice(0, at)
    let depth = 0
    for (const ch of closedBlocks) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    expect(opened).toBeGreaterThan(0)
    expect(depth).toBe(0)
    const row =
      /\.zen-menu-edit li\[data-held\] > \.zen-sheet-item\.zen-menu-edit-item \{([^}]*)\}/.exec(
        css
      )![1]
    expect(row).toContain('background: transparent')
    expect(row).toContain('box-shadow: none')
    const card =
      /\.zen-menu-edit li\[data-held\] > \.zen-sheet-item\.zen-menu-edit-item::before \{([^}]*)\}/.exec(
        css
      )![1]
    expect(card).toContain('inset: 0 4px')
    expect(card).toContain('background: var(--v2-panel)')
    expect(card).toContain('box-shadow: var(--zen-shadow-2)')
  })
})

describe('without the gesture (A11Y-10)', () => {
  it('under touch exploration each item is followed by Move up / Move down / Move to start, disabled at the ends; a move reorders the draft, renames the places and is read back; Done saves the order', async () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    await openEditor()
    // The icon row in its list pose, as the normal pose has it under TalkBack (A11Y-04).
    expect(document.querySelector('[data-menu-edit] .zen-menu-icon-list')).not.toBeNull()
    expect(formatNameFindings(auditNames(document.body))).toBe('')
    const up = moveControl('Settings', 'up')
    expect(up.textContent).toBe('Move Settings up')
    expect(up.classList.contains('sr-only')).toBe(true)
    expect(cellOf('Settings').contains(up)).toBe(true)
    expect(moveControl('Settings', 'down').disabled).toBe(true)
    expect(moveControl('New Tab', 'up').disabled).toBe(true)
    expect(moveControl('New Tab', 'start').disabled).toBe(true)
    expect(moveControl('Forward', 'up').disabled).toBe(true)
    expect(moveControl('Reload', 'down').disabled).toBe(true)
    click(up)
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.settings',
      'row.history'
    ])
    expect(editItem('Settings').getAttribute('aria-label')).toBe('Settings, 3 of 4')
    expect(editItem('History').getAttribute('aria-label')).toBe('History, 4 of 4')
    expect(announcement()).toBe('Settings moved to 3 of 4.')
    // Up again, past the hairline: the same place among the rows, the group above.
    click(moveControl('Settings', 'up'))
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'row.settings',
      'sep.1',
      'row.history'
    ])
    expect(announcement()).toBe('Settings moved to the group above, 3 of 4.')
    click(moveControl('Reload', 'start'))
    expect(rowKeys()).toEqual(['icon.reload', 'icon.forward', 'icon.bookmark'])
    expect(announcement()).toBe('Reload moved to the start, 1 of 3.')
    expect(reset().disabled).toBe(false)
    expect(commands('settings.update')).toEqual([])
    click(done()!)
    await settle()
    expect(commands('settings.update')).toEqual([
      {
        menuOrder: [
          'icon.reload',
          'icon.forward',
          'icon.bookmark',
          'row.newTab',
          'row.newPrivateTab',
          'row.settings',
          'sep.1',
          'row.history'
        ]
      }
    ])
    // The normal pose shows the saved order ahead of the core's next composition.
    expect(editor()).toBeNull()
    expect(textRows()).toEqual([
      'Reload',
      'Forward',
      'Bookmark',
      'New Tab',
      'New Private Tab',
      'Settings',
      'History',
      'Change Menu'
    ])
  })

  it('Reset puts the default back into the draft and Done saves it as the setting’s absence; a menu shown in a saved order starts with Reset live', async () => {
    await openEditor(
      appMenu([
        'icon.reload',
        'icon.forward',
        'icon.bookmark',
        'row.settings',
        'row.newTab',
        'sep.1',
        'row.newPrivateTab',
        'row.history'
      ])
    )
    expect(rowKeys()).toEqual(['icon.reload', 'icon.forward', 'icon.bookmark'])
    expect(reset().disabled).toBe(false)
    click(reset())
    expect(rowKeys()).toEqual(['icon.forward', 'icon.bookmark', 'icon.reload'])
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    expect(reset().disabled).toBe(true)
    expect(announcement()).toBe('Menu order reset to the default.')
    click(done()!)
    await settle()
    expect(commands('settings.update')).toEqual([{ menuOrder: [] }])
    expect(textRows()).toEqual(['New Tab', 'New Private Tab', 'History', 'Settings', 'Change Menu'])
  })

  it('Escape ends the pose and saves, the sheet staying; the sheet dismissed from the pose saves too', async () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    await openEditor()
    click(moveControl('History', 'up'))
    escape()
    await settle()
    expect(editor()).toBeNull()
    expect(uiStore.get().menu).not.toBeNull()
    expect(commands('settings.update')).toEqual([
      {
        menuOrder: [
          'icon.forward',
          'icon.bookmark',
          'icon.reload',
          'row.newTab',
          'row.newPrivateTab',
          'row.history',
          'sep.1',
          'row.settings'
        ]
      }
    ])
    // Back in, moved back to where it was: the pose ends on the order last saved – no write.
    click(rowByText('Change Menu'))
    await settle()
    click(moveControl('History', 'down'))
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    // A press on the scrim dismisses the sheet from the pose: the draft is saved on the way out.
    act(() => {
      document
        .querySelector('.zen-sheet-scrim')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 3 }))
    })
    runAll()
    expect(uiStore.get().menu).toBeNull()
    expect(commands('menu.close')).toEqual([{ menuId: 'menu_1' }])
    expect(commands('settings.update')).toHaveLength(2)
    expect(commands('settings.update')[1]).toEqual({ menuOrder: [] })
  })
})

describe('the hold and the drag (MOT-23)', () => {
  it('a hold lifts the item over 120 ms at scale 1.02 on its cell, out of the FLIP set; the finger lifting puts it down and runs nothing', async () => {
    await openEditor()
    for (const li of document.querySelectorAll<HTMLElement>(
      '[data-menu-edit] ul[aria-label] > li'
    )) {
      expect(li.dataset.cell).toBeDefined()
    }
    const at = pickUp('New Private Tab')
    const el = editItem('New Private Tab')
    expect(el.style.transform).toBe(`scale(${MENU_LIFT_SCALE})`)
    expect(el.style.transition).toBe('transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(cellOf('New Private Tab').dataset.held).toBe('true')
    expect(cellOf('New Private Tab').dataset.cell).toBeUndefined()
    expect(cellOf('New Tab').dataset.cell).toBe('row.newTab')
    pointer('pointerup', el, at.x, at.y)
    expect(el.style.transform).toBe('')
    expect(cellOf('New Private Tab').dataset.held).toBeUndefined()
    expect(cellOf('New Private Tab').dataset.cell).toBe('row.newPrivateTab')
    click(el)
    runAll()
    expect(commands('menu.click')).toEqual([])
    expect(commands('settings.update')).toEqual([])
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
  })

  it('carries the row 1:1 with the finger, moves the draft as its centre nears another slot – past two siblings and the hairline, the others gliding on one spring – and the drop glides home; Done saves the order', async () => {
    await openEditor()
    const start = pickUp('New Tab')
    const a = editItem('New Tab')
    // Past the slop: the drag begins from this move, the row drawn where it lifted, scaled.
    pointer('pointermove', a, start.x, start.y + 12)
    expect(a.style.transition).toBe('')
    expect(translateY(a)).toBeCloseTo(0, 5)
    expect(a.style.transform).toContain(`scale(${MENU_LIFT_SCALE})`)
    // 1:1 with the finger from there.
    pointer('pointermove', a, start.x, start.y + 32)
    expect(translateY(a)).toBeCloseTo(20, 5)
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    // Carried down until its centre is History's: New Tab's cell takes History's place, past
    // New Private Tab and the hairline (a slot like a row's) – and those two are drawn where
    // they were (inverted), to glide.
    const history = listSlotCentre(3)
    const travel = history.y - start.y
    pointer('pointermove', a, start.x, start.y + 12 + travel)
    expect(listKeys()).toEqual([
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.newTab',
      'row.settings'
    ])
    expect(translateY(cellOf('New Private Tab'))).toBeCloseTo(ROW_H, 5)
    expect(translateY(cellOf('History'))).toBeCloseTo(ROW_H, 5)
    expect(cellOf('Settings').style.transform).toBe('')
    // New Tab is drawn at the finger from its new cell: its centre on the slot's.
    expect(translateY(a)).toBeCloseTo(0, 5)
    // The neighbours glide home together.
    for (let i = 0; i < 4; i++) frame()
    const t = translateY(cellOf('New Private Tab'))
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(ROW_H)
    expect(translateY(cellOf('History'))).toBeCloseTo(t, 6)
    // A hand's breadth further: still nearest History's old slot; the row is 10 below it.
    pointer('pointermove', a, start.x, start.y + 12 + travel + 10)
    expect(listKeys()[3]).toBe('row.newTab')
    expect(translateY(a)).toBeCloseTo(10, 5)
    expect(commands('settings.update')).toEqual([])
    // The drop, the finger at rest: the row glides the 10 home on the spring, in the hand to
    // the end of the glide.
    frames.now += 200
    pointer('pointerup', a, start.x, start.y + 12 + travel + 10)
    expect(cellOf('New Tab').dataset.held).toBe('true')
    expect(cellOf('New Tab').dataset.cell).toBeUndefined()
    frame()
    const home = translateY(a)
    expect(home).toBeGreaterThan(0)
    expect(home).toBeLessThan(10)
    runAll()
    expect(a.style.transform).toBe('')
    expect(cellOf('New Tab').dataset.held).toBeUndefined()
    expect(cellOf('New Tab').dataset.cell).toBe('row.newTab')
    expect(cellOf('New Private Tab').style.transform).toBe('')
    expect(editItem('New Tab').getAttribute('aria-label')).toBe('New Tab, 3 of 4')
    // The reorder is the draft's until Done.
    expect(commands('settings.update')).toEqual([])
    click(done()!)
    await settle()
    expect(commands('settings.update')).toEqual([
      {
        menuOrder: [
          'icon.forward',
          'icon.bookmark',
          'icon.reload',
          'row.newPrivateTab',
          'sep.1',
          'row.history',
          'row.newTab',
          'row.settings'
        ]
      }
    ])
    expect(textRows()).toEqual(['New Private Tab', 'History', 'New Tab', 'Settings', 'Change Menu'])
  })

  it('the icon row reorders along x, and never takes a row of the list', async () => {
    await openEditor()
    const start = pickUp('Forward')
    const f = editItem('Forward')
    pointer('pointermove', f, start.x + 12, start.y)
    const third = { x: ICON_X + 2 * ICON_STEP + ROW_H / 2, y: ICON_Y + ROW_H / 2 }
    pointer('pointermove', f, third.x + 12, third.y)
    expect(rowKeys()).toEqual(['icon.bookmark', 'icon.reload', 'icon.forward'])
    // Carried far down over the list: the row keeps it – its travel along y is not read.
    pointer('pointermove', f, third.x + 12, LIST_Y + 3 * ROW_H)
    expect(rowKeys()).toEqual(['icon.bookmark', 'icon.reload', 'icon.forward'])
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    pointer('pointerup', f, third.x + 12, third.y)
    runAll()
    expect(f.style.transform).toBe('')
    expect(editItem('Forward').getAttribute('aria-label')).toBe('Forward, 3 of 3')
  })

  it('the touch taken away mid-drag puts the order back; Done then writes nothing', async () => {
    await openEditor()
    const start = pickUp('New Tab')
    const a = editItem('New Tab')
    pointer('pointermove', a, start.x, start.y + 12)
    const last = listSlotCentre(4)
    pointer('pointermove', a, start.x, start.y + 12 + (last.y - start.y))
    expect(listKeys().at(-1)).toBe('row.newTab')
    pointer('pointercancel', a, start.x, last.y)
    expect(listKeys()).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.settings'
    ])
    runAll()
    expect(a.style.transform).toBe('')
    expect(cellOf('New Tab').dataset.held).toBeUndefined()
    click(done()!)
    await settle()
    expect(commands('settings.update')).toEqual([])
  })

  it('under reduced motion the dropped row is at its slot at once and out of the hand at once (§11.3)', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('reduce'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
    const animate = vi.fn(() => ({ cancel: () => undefined, finished: Promise.resolve() }))
    HTMLElement.prototype.animate = animate as unknown as HTMLElement['animate']
    await openEditor()
    const start = pickUp('New Tab')
    const a = editItem('New Tab')
    pointer('pointermove', a, start.x, start.y + 12)
    const history = listSlotCentre(3)
    pointer('pointermove', a, start.x, start.y + 12 + (history.y - start.y))
    expect(listKeys()[3]).toBe('row.newTab')
    // No glide for the neighbours: no inverted transform written.
    expect(cellOf('New Private Tab').style.transform).toBe('')
    pointer('pointerup', a, start.x, start.y + 12 + (history.y - start.y) + 20)
    expect(a.style.transform).toBe('')
    expect(cellOf('New Tab').dataset.held).toBeUndefined()
    expect(cellOf('New Tab').dataset.cell).toBe('row.newTab')
    expect(
      animate.mock.calls.some(
        (call) => ((call as unknown[])[1] as { duration?: number } | undefined)?.duration === 120
      )
    ).toBe(true)
    Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  })

  it('under reduced motion the lift and the put-down are cuts: the scale written with no transition, cleared at once when the finger lifts (§11.3)', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('reduce'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
    await openEditor()
    const at = pickUp('New Private Tab')
    const el = editItem('New Private Tab')
    expect(el.style.transform).toBe(`scale(${MENU_LIFT_SCALE})`)
    expect(el.style.transition).toBe('')
    expect(cellOf('New Private Tab').dataset.held).toBe('true')
    pointer('pointerup', el, at.x, at.y)
    // No `transitionend` to wait for: down at once.
    expect(el.style.transform).toBe('')
    expect(el.style.transition).toBe('')
    expect(cellOf('New Private Tab').dataset.held).toBeUndefined()
    expect(cellOf('New Private Tab').dataset.cell).toBe('row.newPrivateTab')
  })
})

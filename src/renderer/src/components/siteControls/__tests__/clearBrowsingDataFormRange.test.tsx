// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BrowsingDataCount, BrowsingDataRange, BrowsingDataType, UIState } from '@shared/types'

/*
 * The Delete browsing data form's time range on the desktop layout (W8-12, the lead's item): the
 * form is the Settings dialog's there, and its range row is the builder's §10.5 value row – the
 * 32 px menulist the desktop dialog and the settings page trail – whose popup is the shared §9.13
 * popover (`MenulistPopover`) with §9.20's keyboard, not a §9.13 sheet inside a dialog. The same
 * `RANGE_OPTIONS` words; a pick lands in `useClearForm`'s range (the counts re-read for it, the
 * clear sent with it); a busy form's control opens nothing (§9.30). The layouts a finger drives
 * keep the §10.4 value row and its sheet.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ClearBrowsingDataForm } = await import('../ClearBrowsingDataForm')
const { QUICK_DELETE_FORM } = await import('../useClearForm')
const { RANGE_OPTIONS } = await import('@renderer/lib/browsingData')
const { browserStore } = await import('@renderer/lib/browserStore')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { FrameDialogHost } = await import('@renderer/lib/portals')

const LABELS = RANGE_OPTIONS.map((o) => o.label)
const label = (range: BrowsingDataRange): string =>
  RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range

/** A hand-cranked animation frame for the phone picker sheet's spring (as `settings/__tests__/sheets.test.tsx`). */
class Frames {
  now = 0
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

/** Run a sheet's spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
}

function counts(): BrowsingDataCount[] {
  const row = (
    type: BrowsingDataType,
    count: number,
    unit: BrowsingDataCount['unit']
  ): BrowsingDataCount => ({ type, count, unit, rangeApplies: true, unavailable: null })
  return [row('history', 4, 'visits'), row('cookies', 2, 'sites'), row('cache', 4_096, 'bytes')]
}

let root: Root | null = null
let mount: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
let rect: typeof HTMLElement.prototype.getBoundingClientRect
let scroll: typeof Element.prototype.scrollIntoView

/** The form in the frame's dialog host, where the phone's range picker (a hosted sheet) mounts. */
function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<FrameDialogHost>{el}</FrameDialogHost>))
  return mount
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(target: Element | null | undefined): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function key(k: string, target: Element | null = document.activeElement): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

/**
 * A key that activates a focused button (Enter, Space) as the platform does: the keydown goes
 * out and, unless a handler took it (`preventDefault`), the button is clicked – so the test also
 * pins that no listener in the popover swallows the pick (type-ahead leaves Space alone).
 */
function activate(k: 'Enter' | ' ', target: Element | null = document.activeElement): void {
  act(() => {
    if (!(target instanceof HTMLElement)) throw new Error('nothing focused')
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    const taken = !target.dispatchEvent(event) || event.defaultPrevented
    if (!taken) target.click()
  })
}

const row = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-row="${id}"]`)
const menulist = (host: HTMLElement): HTMLButtonElement | null =>
  row(host, 'clear-data-range')?.querySelector<HTMLButtonElement>('.zen-settings-menulist') ?? null
const listbox = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="listbox"][aria-label="Time range"]')
const options = (): HTMLElement[] => [
  ...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
]
const sheet = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Time range"]')
const submit = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('[data-testid="clear-data-submit"]')

async function open(host: HTMLElement): Promise<void> {
  const trigger = menulist(host)
  act(() => trigger?.focus())
  click(trigger)
  await settle()
}

const desktop = viewportStore.get()
const layout = (formFactor: 'phone' | 'tablet' | 'desktop'): void =>
  viewportStore.set({ ...desktop, formFactor, coarse: formFactor !== 'desktop' })

beforeEach(() => {
  frames.install()
  sizes = ['clientHeight', 'offsetHeight', 'offsetWidth'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall; a sheet's content 300 px; the popover's list 152 × 200 (happy-dom
  // lays nothing out, so the sizes the popover places itself by are given by hand).
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-v2-menulist-popup') ? 152 : 300
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 200
  })
  rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const trigger = this.classList.contains('zen-v2-menulist')
    const width = trigger ? 160 : 200
    const height = trigger ? 32 : 152
    return {
      x: 100,
      y: 300,
      left: 100,
      top: 300,
      width,
      height,
      right: 100 + width,
      bottom: 300 + height,
      toJSON: () => ({})
    } as DOMRect
  }
  scroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = () => undefined
  layout('desktop')
  invoke.mockClear()
  invoke.mockImplementation(async (name, args) => {
    if (name === 'privacy.clearBrowsingDataCounts') return counts()
    if (name === 'privacy.clearBrowsingData')
      return { status: 'ok', value: { cleared: (args as { types: BrowsingDataType[] }).types } }
    return null
  })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.body.innerHTML = ''
  act(() => viewportStore.set(desktop))
  browserStore.set({ state: null })
  vi.unstubAllGlobals()
  frames.now = 0
  HTMLElement.prototype.getBoundingClientRect = rect
  Element.prototype.scrollIntoView = scroll
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the desktop layout’s range row is the menulist (W8-12, §9.13 / §9.20 / §10.5)', () => {
  it('trails the settings page’s menulist, named by the row’s label, reading the range; its popup is the listbox popover in the chrome layer, not a sheet', async () => {
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()

    const range = row(host, 'clear-data-range')!
    // The builder's control row (§10.5), not the phone's pressable row named "label, value".
    expect(range.tagName).toBe('DIV')
    expect(range.hasAttribute('data-static')).toBe(true)
    expect(range.classList.contains('zen-settings-control-row')).toBe(true)
    expect(range.hasAttribute('aria-label')).toBe(false)
    expect(range.querySelector('.zen-settings-label')?.textContent).toBe('Time range')
    const trigger = menulist(host)!
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.classList.contains('zen-v2-menulist')).toBe(true)
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.hasAttribute('aria-expanded')).toBe(false)
    expect(trigger.disabled).toBe(false)
    expect(trigger.hasAttribute('aria-readonly')).toBe(false)
    expect(trigger.textContent).toBe(label('hour'))
    const labelledBy = trigger.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Time range')
    expect(listbox()).toBeNull()
    expect(sheet()).toBeNull()

    await open(host)
    const list = listbox()!
    expect(list.closest('#zen-chrome-layer')).not.toBeNull()
    expect(list.classList.contains('zen-v2-menulist-popup')).toBe(true)
    expect(list.classList.contains('zen-v2-panel')).toBe(true)
    // Flush under the control's box (300 + 32), start-aligned on it, the control's width riding.
    expect(list.style.top).toBe('332px')
    expect(list.style.left).toBe('100px')
    expect(list.style.getPropertyValue('--zen-anchor-width')).toBe('160px')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // The same words as the dialog's and the phone sheet's: `RANGE_OPTIONS`, in its order.
    const rows = options()
    expect(rows.map((r) => r.textContent)).toEqual(LABELS)
    expect(rows.every((r) => r.tagName === 'BUTTON')).toBe(true)
    // The current range checked (the trailing check) and focused as the list opens.
    const current = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true')
    expect(rows[current]?.textContent).toBe(label('hour'))
    expect(rows[current]?.querySelector('svg')).not.toBeNull()
    expect(rows.filter((r) => r.querySelector('svg'))).toHaveLength(1)
    expect(document.activeElement).toBe(rows[current])
    // No §9.13 sheet in the dialog.
    expect(sheet()).toBeNull()
    expect(document.querySelector('.zen-sheet')).toBeNull()
  })

  it('a pick lands in the form’s range: the counts are read for it, the control reads it, the clear is sent with it', async () => {
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'hour' })

    await open(host)
    click(options().find((r) => r.textContent === label('all')))
    await settle()

    expect(listbox()).toBeNull()
    expect(menulist(host)?.getAttribute('aria-expanded')).toBeNull()
    expect(menulist(host)?.textContent).toBe(label('all'))
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'all' })

    click(submit(host))
    await settle()
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingData', {
      range: 'all',
      types: ['history', 'cookies', 'cache']
    })
  })

  it('keeps §9.20’s keyboard: Down on the control opens it on the current range, the arrows move, Enter picks and hands the focus back to the control', async () => {
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    const trigger = menulist(host)!

    act(() => trigger.focus())
    key('ArrowDown', trigger)
    await settle()
    let rows = options()
    expect(rows).toHaveLength(LABELS.length)
    const current = rows.findIndex((r) => r.textContent === label('hour'))
    expect(document.activeElement).toBe(rows[current])

    key('ArrowDown')
    expect(document.activeElement).toBe(rows[current + 1])
    key('ArrowDown')
    expect(document.activeElement).toBe(rows[current + 2])
    key('ArrowUp')
    expect(document.activeElement).toBe(rows[current + 1])
    expect(rows[current + 1]?.textContent).toBe(label('day'))

    activate('Enter')
    await settle()
    expect(listbox()).toBeNull()
    expect(trigger.textContent).toBe(label('day'))
    expect(document.activeElement).toBe(trigger)
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'day' })

    // Space picks as Enter does (type-ahead leaves it to the button); the list opens on the
    // range just picked.
    key('ArrowUp', trigger)
    await settle()
    rows = options()
    expect(document.activeElement).toBe(rows.find((r) => r.textContent === label('day')))
    key('ArrowDown')
    activate(' ')
    await settle()
    expect(listbox()).toBeNull()
    expect(trigger.textContent).toBe(label('week'))
    expect(document.activeElement).toBe(trigger)
  })

  it('Escape closes the list back to the control, the range as it was', async () => {
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    const trigger = menulist(host)!

    await open(host)
    key('ArrowDown')
    expect(document.activeElement).not.toBe(trigger)
    key('Escape')
    await settle()

    expect(listbox()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBeNull()
    expect(trigger.textContent).toBe(label('hour'))
    expect(invoke).not.toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'day' })
  })

  it('a busy form’s control keeps its value at full ink and opens nothing (§9.30), as the dialog’s does', async () => {
    let finish: (value: unknown) => void = () => undefined
    invoke.mockImplementation(async (name) => {
      if (name === 'privacy.clearBrowsingDataCounts') return counts()
      if (name === 'privacy.clearBrowsingData')
        return new Promise((resolve) => {
          finish = resolve
        })
      return null
    })
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    const trigger = menulist(host)!

    click(submit(host))
    await settle()
    expect(
      host.querySelector('[data-testid="clear-browsing-data-form"]')?.hasAttribute('data-busy')
    ).toBe(true)
    expect(trigger.getAttribute('aria-readonly')).toBe('true')
    expect(trigger.disabled).toBe(false)
    expect(row(host, 'clear-data-range')?.classList.contains('zen-settings-row-disabled')).toBe(
      false
    )
    expect(trigger.textContent).toBe(label('hour'))
    await open(host)
    expect(listbox()).toBeNull()
    key('ArrowDown', trigger)
    await settle()
    expect(listbox()).toBeNull()

    act(() => finish({ status: 'ok', value: { cleared: ['history'] } }))
    await settle()
  })
})

describe('the layouts a finger drives keep the §9.13 sheet', () => {
  for (const formFactor of ['phone', 'tablet'] as const) {
    it(`on the ${formFactor}: the pressable value row named "label, value" opens the picker sheet over the form, no menulist`, async () => {
      layout(formFactor)
      // The phone's form is Quick Delete (#624): it opens on the last 15 minutes; the tablet's
      // is the dialog's, on its remembered range – the last hour, nothing deleted yet.
      const opens: BrowsingDataRange =
        formFactor === 'phone' ? (QUICK_DELETE_FORM.initialRange ?? 'hour') : 'hour'
      const host = render(<ClearBrowsingDataForm close={() => undefined} />)
      await settle()

      const range = row(host, 'clear-data-range')!
      expect(range.tagName).toBe('BUTTON')
      expect(range.getAttribute('aria-label')).toBe(`Time range, ${label(opens)}`)
      expect(range.getAttribute('aria-haspopup')).toBe('dialog')
      expect(menulist(host)).toBeNull()
      expect(sheet()).toBeNull()

      click(range)
      await settle()
      rest()
      const group = sheet()!
      expect(group).not.toBeNull()
      expect(listbox()).toBeNull()
      const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
      expect(radios.map((r) => r.textContent)).toEqual(LABELS)
      expect(radios.find((r) => r.getAttribute('aria-checked') === 'true')?.textContent).toBe(
        label(opens)
      )

      // The pick lands in the same range and closes the sheet.
      click(radios.find((r) => r.textContent === label('all')))
      await settle()
      rest()
      expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'all' })
      expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe(
        `Time range, ${label('all')}`
      )
    })
  }
})

describe('the remembered range on each layout (services pass 13, seed #20)', () => {
  /**
   * The chrome's mirror of the core's state, the remembered range filled in – and the one
   * space the back state (`lib/back.ts`, wired by the frame dialog host) reads on every set.
   */
  const remembered = (range: BrowsingDataRange): void =>
    browserStore.set({
      state: {
        spaces: [{ id: 's1', activeTabId: null, tabIds: [] }],
        activeSpaceId: 's1',
        tabs: {},
        essentialTabIds: [],
        glance: null,
        settings: { clearBrowsingDataRange: range }
      } as unknown as UIState
    })

  it('the desktop layout opens on the range last deleted with: the menulist reads it, the counts are read for it, and a Delete with another range writes that one', async () => {
    remembered('week')
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(menulist(host)?.textContent).toBe(label('week'))
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'week' })
    expect(invoke).not.toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'hour' })

    await open(host)
    click(options().find((r) => r.textContent === label('all')))
    await settle()
    expect(invoke).not.toHaveBeenCalledWith('settings.update', expect.anything())
    click(submit(host))
    await settle()
    expect(invoke).toHaveBeenCalledWith('settings.update', { clearBrowsingDataRange: 'all' })
  })

  // The state goes in before the layout: `formFactor.ts` recomputes the viewport on every set.
  it('the tablet’s form is the dialog’s: it opens on the remembered range too', async () => {
    remembered('month')
    layout('tablet')
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe(
      `Time range, ${label('month')}`
    )
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'month' })
  })

  it('the phone’s Quick Delete form ignores it: the 15 minutes whatever was remembered, and its Delete writes nothing', async () => {
    remembered('week')
    layout('phone')
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe(
      `Time range, ${label('15min')}`
    )
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: '15min' })
    expect(invoke).not.toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'week' })

    click(submit(host))
    await settle()
    expect(invoke).toHaveBeenCalledWith(
      'privacy.clearBrowsingData',
      expect.objectContaining({ range: '15min' })
    )
    expect(invoke).not.toHaveBeenCalledWith('settings.update', expect.anything())
  })
})

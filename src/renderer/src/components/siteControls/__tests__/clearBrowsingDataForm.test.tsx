// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BrowsingDataCount, BrowsingDataRange, BrowsingDataType } from '@shared/types'

/*
 * The Delete browsing data form as Chrome Android's Quick Delete on the phone (HB-07, the UI half
 * of MOT-24): it opens on the last 15 minutes, carries the Tabs row after Cached images and files
 * (Chrome's Delete browsing data page's seat, `clear_browsing_data_preferences.xml:32–39`) with
 * Chrome's count line under it and OFF from the start (Chrome's `kCloseTabs` starts false on
 * Android, `pref_names.cc:66–68`; ADDENDUM D), and sends `'tabs'` with the range once the row is
 * on; the same form on the wide layout is the dialog's – the last hour, no Tabs row. The toast on
 * either layout is W8-7's `clearedToast(range, cleared)` – the period's words, not this change's.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ClearBrowsingDataForm } = await import('../ClearBrowsingDataForm')
const { uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { clearedToast } = await import('@renderer/lib/browsingData')

/** A hand-cranked animation frame for the picker sheet's spring (as `settings/__tests__/sheets.test.tsx`). */
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
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

/** Run a sheet's spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
}

let tabsInRange = 3

function counts(range: BrowsingDataRange): BrowsingDataCount[] {
  const row = (
    type: BrowsingDataType,
    count: number,
    unit: BrowsingDataCount['unit']
  ): BrowsingDataCount => ({ type, count, unit, rangeApplies: true, unavailable: null })
  return [
    row('history', range === 'all' ? 1200 : 4, 'visits'),
    row('tabs', tabsInRange, 'tabs'),
    row('cookies', 2, 'sites'),
    row('cache', 4_096, 'bytes')
  ]
}

let root: Root | null = null
let mount: HTMLElement | null = null

/** The form in the frame's dialog host, where its range picker (a hosted sheet) mounts. */
function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<FrameDialogHost>{el}</FrameDialogHost>))
  return mount
}

function click(target: Element | null | undefined): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function typeOrder(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-browsing-data]')).map(
    (el) => el.dataset.browsingData!
  )
}

function row(host: HTMLElement, id: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`[data-row="${id}"]`)
}

const desktop = viewportStore.get()
const phone = (): void => viewportStore.set({ ...desktop, formFactor: 'phone' })

beforeEach(() => {
  frames.install()
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall and a sheet's content 300 px: a picker sheet with room to stand.
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
  tabsInRange = 3
  invoke.mockClear()
  invoke.mockImplementation(async (name, args) => {
    if (name === 'privacy.clearBrowsingDataCounts')
      return counts((args as { range: BrowsingDataRange }).range)
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
  uiStore.set({ toasts: [] })
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the phone form is Quick Delete (HB-07)', () => {
  it('opens on the last 15 minutes with the Tabs row after Cached images and files, OFF, counted in Chrome’s words', async () => {
    phone()
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()

    expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe(
      'Time range, Last 15 minutes'
    )
    // Chrome's page order: history, cookies, cache, tabs (`clear_browsing_data_preferences.xml`
    // :20, :26, :32, :37); the three the form ticks by default, then the switch that starts off.
    expect(typeOrder(host)).toEqual(['history', 'cookies', 'cache', 'tabs'])
    const tabs = row(host, 'clear-data-type:tabs')
    expect(tabs?.getAttribute('role')).toBe('switch')
    expect(tabs?.getAttribute('aria-checked')).toBe('false')
    expect(tabs?.textContent).toContain('Tabs')
    // The count line is the row's description whether the switch is on or off (ADDENDUM D (3)).
    expect(tabs?.textContent).toContain('3 tabs on this device')
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: '15min' })
  })

  it('keeps the Tabs row after Cached images and files in Advanced too', async () => {
    phone()
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    click(advancedRadio(host))
    await settle()
    expect(typeOrder(host).slice(0, 5)).toEqual([
      'history',
      'cookies',
      'cache',
      'tabs',
      'downloads'
    ])
    expect(typeOrder(host)).toContain('recentlyClosed')
    expect(row(host, 'clear-data-type:tabs')?.getAttribute('aria-checked')).toBe('false')
  })

  it('reads an empty period as Chrome does – "No tabs from the last 15 minutes"', async () => {
    tabsInRange = 0
    phone()
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(row(host, 'clear-data-type:tabs')?.textContent).toContain(
      'No tabs from the last 15 minutes'
    )
  })

  it('sends the tabs with the range once the row is on, and reports in W8-7’s period words', async () => {
    phone()
    const close = vi.fn()
    const host = render(<ClearBrowsingDataForm close={close} />)
    await settle()
    click(row(host, 'clear-data-type:tabs'))
    expect(row(host, 'clear-data-type:tabs')?.getAttribute('aria-checked')).toBe('true')
    click(host.querySelector('[data-testid="clear-data-submit"]'))
    await settle()

    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingData', {
      range: '15min',
      types: ['history', 'cookies', 'cache', 'tabs']
    })
    // "Last 15 minutes deleted" – the period from the one range list, never the types.
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual([
      clearedToast('15min', ['history', 'cookies', 'cache', 'tabs'])
    ])
    expect(uiStore.get().toasts[0]?.message).toBe('Last 15 minutes deleted')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the tabs open while the row stays off, all time chosen', async () => {
    phone()
    const host = render(<ClearBrowsingDataForm close={() => undefined} />)
    await settle()
    expect(row(host, 'clear-data-type:tabs')?.getAttribute('aria-checked')).toBe('false')

    // The range picker is the §9.13 sheet over the form: its options are Chrome's six, the last
    // 15 minutes first; choosing All time re-reads the counts for it.
    click(row(host, 'clear-data-range'))
    await settle()
    rest()
    const options = Array.from(
      host.querySelectorAll<HTMLElement>(
        '[role="radiogroup"][aria-label="Time range"] [role="radio"]'
      )
    )
    expect(options.map((o) => o.textContent)).toEqual([
      'Last 15 minutes',
      'Last hour',
      'Last 24 hours',
      'Last 7 days',
      'Last 4 weeks',
      'All time'
    ])
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    click(options[5])
    await settle()
    rest()
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingDataCounts', { range: 'all' })
    expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe('Time range, All time')
    expect(row(host, 'clear-data-type:tabs')?.textContent).toContain('3 tabs on this device')

    click(host.querySelector('[data-testid="clear-data-submit"]'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingData', {
      range: 'all',
      types: ['history', 'cookies', 'cache']
    })
    // All time: "Deleted" alone (W8-7, `IDS_QUICK_DELETE_SNACKBAR_ALL_TIME_MESSAGE`).
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual([
      clearedToast('all', ['history', 'cookies', 'cache'])
    ])
    expect(uiStore.get().toasts[0]?.message).toBe('Deleted')
  })
})

describe('the wide layout shows the dialog’s form', () => {
  it('opens on the last hour without a Tabs row and reports "Last hour deleted"', async () => {
    const close = vi.fn()
    const host = render(<ClearBrowsingDataForm close={close} />)
    await settle()

    expect(row(host, 'clear-data-range')?.getAttribute('aria-label')).toBe('Time range, Last hour')
    expect(typeOrder(host)).toEqual(['history', 'cookies', 'cache'])
    expect(row(host, 'clear-data-type:tabs')).toBeNull()

    click(host.querySelector('[data-testid="clear-data-submit"]'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('privacy.clearBrowsingData', {
      range: 'hour',
      types: ['history', 'cookies', 'cache']
    })
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual(['Last hour deleted'])
    expect(close).toHaveBeenCalledTimes(1)
  })
})

function advancedRadio(host: HTMLElement): Element | null {
  return (
    Array.from(host.querySelectorAll('[role="radio"]')).find((el) =>
      el.textContent?.includes('Advanced')
    ) ?? null
  )
}

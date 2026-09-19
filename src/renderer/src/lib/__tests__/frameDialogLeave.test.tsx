// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PageDialog, UIState } from '@shared/types'
import { PageDialogs } from '@renderer/components/dialogs/PageDialog'
import { viewportStore } from '../formFactor'
import { REDUCED_MOTION_FADE_MS } from '../motion/sheet'
import { FrameDialogHost, useFrameDialog } from '../portals'
import { uiStore } from '../ui'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => undefined),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The frame dialog host's leave on a phone (lib/portals.tsx, design language v2 draft §11.1: the
 * store's `null` means "leave", never "vanish"). A dialog's panel is rendered by its request and
 * goes with it, in the commit that clears it – the icon picker's Cancel, a prompt leaving `state`
 * when the page or the core drops it – while the host's sheet is only setting out on its way
 * down. The host keeps the node: a panel taken out of the slot while the sheet is on its way
 * down is put back where it stood, inert and marked `data-leaving`, rides the slide down and is
 * dropped when the spring lands, when the chrome comes back and focus returns to the opener
 * (§9.22); under reduced motion the way down is the 120 ms fade in place (§11.3). The desktop
 * host retains nothing: its pose (the panel's own §9.5 pop) is not this mechanism's. Rendered for
 * real in happy-dom, the frame loop cranked by hand, the layout given sizes: the slot is 800 px
 * tall and a panel stands 300 px above its bottom edge, so the slide is 300.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null
let now = 0
let queue = new Map<number, (now: number) => void>()
let seq = 0
const SLOT_HEIGHT = 800
const PANEL_TOP = 500
const TRAVEL = SLOT_HEIGHT - PANEL_TOP
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
/** Window chrome with the control that opened the dialog, focused before it mounts. */
let chrome: HTMLElement
let opener: HTMLButtonElement

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

const frames = (n: number): void => {
  for (let i = 0; i < n; i++) {
    now += 16
    const pending = [...queue.values()]
    queue.clear()
    for (const cb of pending) cb(now)
  }
}
const scheduled = (): boolean => queue.size > 0
/** Let the microtasks run: the wait for the page's cover, and the slot's mutation records. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}
const host = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-frame-dialogs')!
const slot = (): HTMLElement => host().querySelector<HTMLElement>('.zen-frame-dialogs-slot')!
const scrim = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-frame-scrim')!
const panel = (name: string): HTMLElement | null =>
  slot().querySelector<HTMLElement>(`[data-dialog="${name}"]`)
const recedeVar = (): string => document.documentElement.style.getPropertyValue('--zen-recede')
const opacity = (el: HTMLElement | null): number => Number(el?.style.opacity)
const translateY = (): number => {
  const m = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(slot().style.transform)
  expect(m, `a translation in ${slot().style.transform}`).not.toBeNull()
  return Number(m![1])
}
const active = (): Element | null => document.activeElement

/** A dialog panel placed through the host, as the picker and the prompts are. */
function Dialog({ name, onScrimPress }: { name: string; onScrimPress?: () => void }): JSX.Element {
  useFrameDialog({ onScrimPress })
  return (
    <div data-dialog={name}>
      <button type="button" data-cancel>
        Cancel
      </button>
    </div>
  )
}

/** Run the way down to its landing, judging every frame with `each`; returns the frames it took. */
function runDown(each?: (p: number) => void, max = 120): number {
  let n = 0
  for (; n < max && scheduled(); n++) {
    frames(1)
    each?.(opacity(scrim()))
  }
  return n
}

beforeEach(() => {
  now = 0
  queue = new Map()
  seq = 0
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    const id = ++seq
    queue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id)
  })
  vi.stubGlobal('performance', { now: () => now })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetTop'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-frame-dialogs-slot') ? SLOT_HEIGHT : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-dialog') || this.hasAttribute('data-page-dialog')
        ? PANEL_TOP
        : 0
    }
  })
  chrome = document.createElement('nav')
  chrome.dataset.shellChrome = ''
  opener = document.createElement('button')
  opener.textContent = 'Change icon'
  chrome.appendChild(opener)
  document.body.appendChild(chrome)
  opener.focus()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  chrome.remove()
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the frame dialog host keeps a panel for the way down (§11.1)', () => {
  it('the picker’s Cancel: the panel its owner unmounted is still in the slot at p .5 – inert, marked leaving, riding the slide – and gone at 0', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="picker" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    expect(translateY()).toBe(0)
    const node = panel('picker')!
    expect(node.hasAttribute('inert')).toBe(false)

    // Cancel: the store's write unmounts the panel in the same commit.
    rerender(<FrameDialogHost />)
    expect(host().hasAttribute('data-open')).toBe(false)
    await settle()
    // Kept: the same node, back in the slot, inert and marked, before the first frame down.
    expect(panel('picker')).toBe(node)
    expect(node.hasAttribute('inert')).toBe(true)
    expect(node.hasAttribute('data-leaving')).toBe(true)
    expect(recedeVar()).toBe('1.0000')

    let atHalf = false
    let judged = 0
    let last = 1
    runDown((p) => {
      if (p > 0) {
        // Still there, riding the slide: the slot's travel is the panel's, as measured.
        expect(panel('picker')).toBe(node)
        expect(translateY()).toBeCloseTo((1 - p) * TRAVEL, 1)
        expect(Number(recedeVar())).toBeCloseTo(p, 4)
        expect(p).toBeLessThanOrEqual(last + 1e-9)
        if (Math.abs(p - 0.5) < 0.15) atHalf = true
        judged++
      }
      last = p
    })
    expect(judged).toBeGreaterThan(5)
    expect(atHalf).toBe(true)
    // Landed: dropped with the layer's release, the page let back.
    expect(panel('picker')).toBeNull()
    expect(slot().childElementCount).toBe(0)
    expect(opacity(scrim())).toBe(0)
    expect(document.documentElement.dataset.receding).toBeUndefined()
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('a prompt leaving `state` (the page’s own dialog, owned by the main process) rides the same way down', async () => {
    const dialog: PageDialog = {
      id: 'd1',
      kind: 'alert',
      tabId: 't1',
      site: 'news.example',
      embedded: false,
      message: 'Saved.',
      defaultValue: ''
    }
    const state = (dialogs: PageDialog[]): UIState =>
      ({
        platform: 'android',
        tabs: { t1: { id: 't1', url: 'https://news.example/' } },
        spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
        activeSpaceId: 's1',
        pageDialogs: dialogs
      }) as unknown as UIState
    render(
      <FrameDialogHost>
        <PageDialogs state={state([dialog])} />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    const node = slot().querySelector<HTMLElement>('[data-page-dialog="alert"]')!
    expect(node).not.toBeNull()

    // The page dismissed it (or navigated): the next state has no dialog for the tab.
    rerender(
      <FrameDialogHost>
        <PageDialogs state={state([])} />
      </FrameDialogHost>
    )
    await settle()
    expect(slot().querySelector('[data-page-dialog]')).toBe(node)
    expect(node.hasAttribute('inert')).toBe(true)
    expect(node.hasAttribute('data-leaving')).toBe(true)
    let judged = 0
    runDown((p) => {
      if (p > 0) {
        expect(slot().querySelector('[data-page-dialog]')).toBe(node)
        expect(translateY()).toBeCloseTo((1 - p) * TRAVEL, 1)
        judged++
      }
    })
    expect(judged).toBeGreaterThan(5)
    expect(slot().querySelector('[data-page-dialog]')).toBeNull()
    expect(recedeVar()).toBe('')
  })

  it('the chrome stays inert to the landing, and focus returns to the opener then – not at the write that took the panel', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="picker" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(chrome.hasAttribute('inert')).toBe(true)
    act(() => mount!.querySelector<HTMLElement>('[data-cancel]')!.focus())
    expect(active()).not.toBe(opener)

    rerender(<FrameDialogHost />)
    await settle()
    // The panel's control still holds the focus in happy-dom (a browser drops it with `inert`);
    // either way it is not back on the opener while the sheet is on its way down.
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(active()).not.toBe(opener)
    frames(2)
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(active()).not.toBe(opener)
    runDown()
    expect(chrome.hasAttribute('inert')).toBe(false)
    expect(active()).toBe(opener)
  })

  it('a panel going while another dialog stays open is not kept: the host is up', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
        <Dialog name="prompt" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    await settle()
    expect(panel('prompt')).toBeNull()
    expect(panel('edit')).not.toBeNull()
    expect(recedeVar()).toBe('1.0000')
  })

  it('a dialog opening on the way down takes the slot: what was kept is dropped, the spring turns round', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="picker" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    const kept = panel('picker')!
    rerender(<FrameDialogHost />)
    await settle()
    frames(4)
    expect(panel('picker')).toBe(kept)
    const midway = opacity(scrim())
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1)
    rerender(
      <FrameDialogHost>
        <Dialog name="prompt" />
      </FrameDialogHost>
    )
    await settle()
    expect(panel('picker')).toBeNull()
    expect(panel('prompt')).not.toBeNull()
    expect(panel('prompt')!.hasAttribute('data-leaving')).toBe(false)
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    expect(slot().childElementCount).toBe(1)
  })

  it('under reduced motion the way down is the 120 ms fade in place, the panel still in the slot, then the drop (§11.3)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false
    }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(
      <FrameDialogHost>
        <Dialog name="picker" />
      </FrameDialogHost>
    )
    await settle()
    // The spring jumps: up at once.
    expect(recedeVar()).toBe('1.0000')
    expect(slot().style.opacity).toBe('1')
    const node = panel('picker')!

    rerender(<FrameDialogHost />)
    await settle()
    // Faded in place: the slot and the scrim step to 0 on main.css's transition, the panel
    // still in the slot, nothing sliding, the recede value untouched until the fade is over.
    expect(panel('picker')).toBe(node)
    expect(slot().style.opacity).toBe('0')
    expect(scrim().style.opacity).toBe('0')
    expect(translateY()).toBe(0)
    expect(scheduled()).toBe(false)
    expect(recedeVar()).toBe('1.0000')
    act(() => {
      vi.advanceTimersByTime(REDUCED_MOTION_FADE_MS - 1)
    })
    expect(panel('picker')).toBe(node)
    expect(recedeVar()).toBe('1.0000')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(panel('picker')).toBeNull()
    expect(recedeVar()).toBe('')
    expect(document.documentElement.dataset.receding).toBeUndefined()
  })
})

describe('the desktop host is not this mechanism’s (the §9.5 pose stays as it is)', () => {
  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  })

  it('a panel its owner unmounts goes as rendered: nothing kept, nothing marked, the scrim animating in as before', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    expect(host().hasAttribute('data-sheet')).toBe(false)
    expect(scrim().classList.contains('zen-animate-in')).toBe(true)
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(document.documentElement.dataset.receding).toBeUndefined()
    rerender(<FrameDialogHost />)
    await settle()
    expect(panel('edit')).toBeNull()
    expect(slot().childElementCount).toBe(0)
    expect(slot().style.transform).toBe('')
    expect(slot().style.opacity).toBe('')
    expect(mount!.querySelector('.zen-frame-scrim')).toBeNull()
    expect(mount!.querySelector('[data-leaving]')).toBeNull()
    expect(chrome.hasAttribute('inert')).toBe(false)
    expect(scheduled()).toBe(false)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'

/*
 * The pill's hold (GN-10): a stationary press picks the pill up for the carry (#27); a pick-up
 * let go in place puts the pill back and, once it has landed, opens the address surface –
 * Chrome's long-press on its address bar offers the clipboard, and the omnibox's clipboard row
 * carries Paste and Paste and go. A pick-up that carried the bar to the other edge opens nothing;
 * a tap (no pick-up) is the tap it always was.
 */

const dockState = {
  phase: 'idle' as 'idle' | 'lifted' | 'settling' | 'landing',
  from: 'bottom' as 'top' | 'bottom',
  target: null as 'top' | 'bottom' | null
}
const listeners = new Set<() => void>()
const dockStore = {
  get: () => dockState,
  set: (patch: Partial<typeof dockState>) => {
    Object.assign(dockState, patch)
    for (const l of listeners) l()
  },
  subscribe: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}
let carried = 0
vi.mock('@renderer/lib/gestures/dock', () => ({
  dockStore,
  beginDock: vi.fn(() => {
    dockStore.set({ phase: 'lifted', from: 'bottom', target: null })
    return true
  }),
  catchDock: vi.fn(() => false),
  dockAlong: () => 0,
  dragDock: vi.fn((_dx: number, dy: number) => {
    carried = dy
  }),
  releaseDock: vi.fn(() => {
    dockStore.set({ phase: 'settling', target: Math.abs(carried) > 100 ? 'top' : 'bottom' })
  })
}))
vi.mock('@renderer/lib/gestures/stage', () => ({
  beginOverviewDrag: () => false,
  beginTabSwitch: () => false,
  catchOverview: () => false,
  catchTabSwitch: () => false,
  dragOverview: () => undefined,
  dragTabSwitch: () => undefined,
  overviewIsOpen: () => false,
  prepareStage: () => undefined,
  releaseOverview: () => undefined,
  releaseTabSwitch: () => undefined
}))

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { usePillGestures } = await import('../usePillGestures')
const { browserStore } = await import('@renderer/lib/ui')
const { catchDock } = await import('@renderer/lib/gestures/dock')

const onTap = vi.fn()
const onHold = vi.fn()

function Pill(): JSX.Element {
  const pill = usePillGestures({ edge: 'bottom', onTap, onHold })
  const { style, ...handlers } = pill
  return <div data-testid="pill" style={style} {...handlers} />
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Pill />))
  return mount.querySelector<HTMLElement>('[data-testid="pill"]')!
}

const pointer = (
  el: HTMLElement,
  type: string,
  x: number,
  y: number,
  t: number,
  init: PointerEventInit = {}
): void => {
  const event = new PointerEvent(type, {
    bubbles: true,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
    ...init
  })
  Object.defineProperty(event, 'timeStamp', { value: t })
  act(() => {
    el.dispatchEvent(event)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  onTap.mockClear()
  onHold.mockClear()
  carried = 0
  Object.assign(dockState, { phase: 'idle', from: 'bottom', target: null })
  browserStore.set({ state: { platform: 'android' } as unknown as UIState })
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  vi.useRealTimers()
})

describe('the pill hold (GN-10)', () => {
  it('a pick-up let go in place opens the address surface once the pill has landed', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    expect(dockState.phase).toBe('lifted')
    // A finger that holds still still jitters by a pixel or two.
    pointer(pill, 'pointermove', 202, 801, 420)
    pointer(pill, 'pointerup', 202, 801, 440)
    expect(dockState.phase).toBe('settling')
    expect(dockState.target).toBe('bottom')
    // Nothing yet: the pill is on its way back.
    expect(onHold).not.toHaveBeenCalled()
    act(() => dockStore.set({ phase: 'landing' }))
    expect(onHold).not.toHaveBeenCalled()
    act(() => dockStore.set({ phase: 'idle', target: null }))
    expect(onHold).toHaveBeenCalledTimes(1)
    expect(onTap).not.toHaveBeenCalled()
    // The landing is heard once: a later move of the store opens nothing again.
    act(() => dockStore.set({ phase: 'idle' }))
    expect(onHold).toHaveBeenCalledTimes(1)
  })

  it('a pick-up that carried the bar to the other edge opens nothing', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    pointer(pill, 'pointermove', 200, 500, 600)
    pointer(pill, 'pointerup', 200, 400, 700)
    expect(dockState.target).toBe('top')
    act(() => dockStore.set({ phase: 'landing' }))
    act(() => dockStore.set({ phase: 'idle', target: null }))
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a pick-up moved past the slop and put back is a carry put back, not a hold', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    pointer(pill, 'pointermove', 200, 780, 500)
    pointer(pill, 'pointerup', 200, 780, 520)
    expect(dockState.target).toBe('bottom')
    act(() => dockStore.set({ phase: 'idle', target: null }))
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a cancelled pick-up opens nothing', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    pointer(pill, 'pointercancel', 200, 800, 450)
    act(() => dockStore.set({ phase: 'idle', target: null }))
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a tap is a tap: no pick-up, no hold', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(150))
    pointer(pill, 'pointerup', 200, 800, 150)
    act(() => {
      pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(dockState.phase).toBe('idle')
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a new finger on the landing pill keeps the surface closed', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    pointer(pill, 'pointerup', 200, 800, 450)
    expect(dockState.phase).toBe('settling')
    // The next touch lands while the pill is still settling.
    pointer(pill, 'pointerdown', 200, 800, 600)
    act(() => dockStore.set({ phase: 'idle', target: null }))
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a finger that catches the put-back pill and carries it to the other edge opens nothing where it lands', () => {
    const pill = render()
    pointer(pill, 'pointerdown', 200, 800, 0)
    act(() => vi.advanceTimersByTime(400))
    pointer(pill, 'pointerup', 200, 800, 450)
    expect(dockState.phase).toBe('settling')
    expect(dockState.target).toBe('bottom')
    // The catch: the pill on its way back down is taken by a new finger, which lifts it again.
    vi.mocked(catchDock).mockImplementationOnce(() => {
      dockStore.set({ phase: 'lifted', target: null })
      return true
    })
    pointer(pill, 'pointerdown', 200, 800, 600)
    expect(dockState.phase).toBe('lifted')
    // ... and carries it to the top: the finger has lifted before the pill lands there.
    pointer(pill, 'pointermove', 200, 500, 700)
    pointer(pill, 'pointerup', 200, 400, 800)
    expect(dockState.phase).toBe('settling')
    expect(dockState.target).toBe('top')
    act(() => dockStore.set({ phase: 'landing' }))
    act(() => dockStore.set({ phase: 'idle', target: null }))
    // The hold's landing was taken from it; the pill at the edge the user just moved it to opens nothing.
    expect(onHold).not.toHaveBeenCalled()
    expect(onTap).not.toHaveBeenCalled()
  })
})

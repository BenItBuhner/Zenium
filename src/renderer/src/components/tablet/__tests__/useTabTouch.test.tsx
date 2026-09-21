// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { liftTabByTouch, type TouchTabDrag } from '@renderer/lib/drag'
import { TAB_LONG_PRESS_MS, useTabTouch } from '../useTabTouch'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

vi.mock('@renderer/lib/drag', () => ({
  liftTabByTouch: vi.fn()
}))

/*
 * TABLET-02: a finger on a sidebar tab row. A tap stays the row's click; a hold lifts the row
 * into the drag session with a haptic tick, and from there a release in place is the tab's menu
 * sheet (on the click that follows, or after a moment without one) while a move is the reorder,
 * ended by the release or the touch being taken away. Rendered for real so the pointer events
 * go through React; the drag session itself is `lib/drag.ts`'s and is stood in for here.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tab = { id: 't1', title: 'One', url: 'https://one.test/' } as unknown as Tab

const rowClick = vi.fn()
const rowContextMenu = vi.fn()
const rowPointerDown = vi.fn()
const handle = {
  move: vi.fn<TouchTabDrag['move']>(),
  release: vi.fn<TouchTabDrag['release']>(),
  cancel: vi.fn<TouchTabDrag['cancel']>()
}
const vibrate = vi.fn()

function Row({ enabled }: { enabled: boolean }): JSX.Element {
  const touch = useTabTouch(tab, enabled)
  return (
    <div
      data-testid="row"
      onPointerDown={(e) => {
        if (touch.onPointerDown(e)) return
        rowPointerDown()
      }}
      onPointerMove={touch.onPointerMove}
      onPointerUp={touch.onPointerUp}
      onPointerCancel={touch.onPointerCancel}
      onClick={() => {
        if (touch.swallowsClick()) return
        rowClick()
      }}
      onContextMenu={(e) => {
        if (touch.onContextMenu(e)) return
        rowContextMenu()
      }}
    >
      <span>One</span>
      <button type="button" data-testid="close">
        x
      </button>
    </div>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(enabled = true): void {
  act(() => {
    root!.render(<Row enabled={enabled} />)
  })
}

const row = (): HTMLElement => host!.querySelector('[data-testid="row"]') as HTMLElement

type PointerType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'

function pointer(
  type: PointerType,
  x: number,
  y: number,
  {
    pointerType = 'touch',
    pointerId = 1,
    button = 0,
    on = row() as EventTarget
  }: { pointerType?: string; pointerId?: number; button?: number; on?: EventTarget } = {}
): void {
  act(() => {
    on.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId,
        pointerType,
        button
      })
    )
  })
}

function click(): void {
  act(() => {
    row().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The browser's own long-press context menu, raised on the held element; whether it was taken. */
function contextMenu(): boolean {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  act(() => {
    row().dispatchEvent(e)
  })
  return e.defaultPrevented
}

/** A touch's touchmove on the document, as the browser raises it before scrolling; whether it was cancelled. */
function touchMove(): boolean {
  const e = new Event('touchmove', { bubbles: true, cancelable: true })
  document.dispatchEvent(e)
  return e.defaultPrevented
}

const hold = (): void => {
  act(() => {
    vi.advanceTimersByTime(TAB_LONG_PRESS_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(liftTabByTouch).mockReturnValue(handle)
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  host?.remove()
  host = null
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('a tap', () => {
  it('is the row\u2019s click, and the hook takes the touch without lifting', () => {
    mount()
    pointer('pointerdown', 40, 20)
    // The hook owns the touch: the row's own pointerdown (the mouse's drag) does not run.
    expect(rowPointerDown).not.toHaveBeenCalled()
    pointer('pointerup', 40, 20)
    click()
    expect(rowClick).toHaveBeenCalledTimes(1)
    expect(liftTabByTouch).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves the row\u2019s buttons their taps', () => {
    mount()
    const close = host!.querySelector('[data-testid="close"]') as HTMLElement
    pointer('pointerdown', 40, 20, { on: close })
    // Not the hook's: the row's own handling ran.
    expect(rowPointerDown).toHaveBeenCalledTimes(1)
    hold()
    expect(liftTabByTouch).not.toHaveBeenCalled()
  })
})

describe('a hold', () => {
  it('lifts the row into the drag session with a haptic tick', () => {
    mount()
    pointer('pointerdown', 40, 20)
    expect(liftTabByTouch).not.toHaveBeenCalled()
    hold()
    expect(liftTabByTouch).toHaveBeenCalledTimes(1)
    expect(liftTabByTouch).toHaveBeenCalledWith(tab, row(), 40, 20, expect.any(Number))
    expect(vibrate).toHaveBeenCalledWith(8)
  })

  it('released in place puts the row down and opens the tab menu on the click that follows', () => {
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    pointer('pointerup', 42, 21, { on: window })
    expect(handle.cancel).toHaveBeenCalledTimes(1)
    expect(handle.release).not.toHaveBeenCalled()
    // The menu waits for the click, so the sheet's scrim cannot receive that click.
    expect(run).not.toHaveBeenCalled()
    click()
    expect(rowClick).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith('tab.contextMenu', { tabId: 't1', x: 42, y: 21 })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('opens the menu after a moment when no click comes', () => {
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    pointer('pointerup', 40, 20, { on: window })
    expect(run).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(run).toHaveBeenCalledWith('tab.contextMenu', { tabId: 't1', x: 40, y: 20 })
    // A click straggling in afterwards is swallowed and opens nothing more.
    click()
    expect(rowClick).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('moved past the slop is the reorder: the finger\u2019s moves and its release go to the session', () => {
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    // Within the slop nothing moves yet: the row stands lifted under the finger.
    pointer('pointermove', 44, 24, { on: window })
    expect(handle.move).not.toHaveBeenCalled()
    pointer('pointermove', 40, 60, { on: window })
    pointer('pointermove', 40, 100, { on: window })
    expect(handle.move).toHaveBeenCalledTimes(2)
    expect(handle.move).toHaveBeenLastCalledWith(40, 100, expect.any(Number))
    pointer('pointerup', 40, 104, { on: window })
    expect(handle.release).toHaveBeenCalledWith(40, 104, expect.any(Number))
    expect(handle.cancel).not.toHaveBeenCalled()
    // A drag opens no menu, now or later.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    click()
    expect(rowClick).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('a touch taken away mid-drag sends the row home', () => {
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    pointer('pointermove', 40, 80, { on: window })
    pointer('pointercancel', 40, 80, { on: window })
    expect(handle.cancel).toHaveBeenCalledTimes(1)
    expect(handle.release).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('blocks the list\u2019s touch scrolling while the row is in the hand, and lets go with it', () => {
    mount()
    pointer('pointerdown', 40, 20)
    expect(touchMove()).toBe(false)
    hold()
    expect(touchMove()).toBe(true)
    pointer('pointerup', 40, 20, { on: window })
    expect(touchMove()).toBe(false)
  })

  it('a second finger during the hold is nobody\u2019s', () => {
    mount()
    pointer('pointerdown', 40, 20)
    pointer('pointerdown', 80, 20, { pointerId: 2 })
    expect(rowPointerDown).not.toHaveBeenCalled()
    pointer('pointerup', 80, 20, { pointerId: 2 })
    hold()
    // The first finger's hold went on regardless.
    expect(liftTabByTouch).toHaveBeenCalledTimes(1)
    pointer('pointermove', 80, 90, { pointerId: 2, on: window })
    expect(handle.move).not.toHaveBeenCalled()
  })

  it('when another drag has the rows, the hold is nothing and the release stays a tap', () => {
    vi.mocked(liftTabByTouch).mockReturnValue(null)
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    expect(liftTabByTouch).toHaveBeenCalledTimes(1)
    expect(vibrate).not.toHaveBeenCalled()
    pointer('pointerup', 40, 20)
    click()
    expect(rowClick).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('is cancelled by the row going away, without a menu', () => {
    mount()
    pointer('pointerdown', 40, 20)
    hold()
    act(() => {
      root!.unmount()
    })
    root = createRoot(host!)
    expect(handle.cancel).toHaveBeenCalledTimes(1)
    expect(touchMove()).toBe(false)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('a scroll', () => {
  it('a finger that moves before the hold is up is not a hold', () => {
    mount()
    pointer('pointerdown', 40, 20)
    pointer('pointermove', 40, 40)
    hold()
    expect(liftTabByTouch).not.toHaveBeenCalled()
    pointer('pointerup', 40, 40)
    // The browser sends no click after a scroll; were one to come it would be the row's.
    click()
    expect(rowClick).toHaveBeenCalledTimes(1)
  })

  it('a touch the browser takes over before the hold is up leaves nothing behind', () => {
    mount()
    pointer('pointerdown', 40, 20)
    pointer('pointercancel', 40, 20)
    hold()
    expect(liftTabByTouch).not.toHaveBeenCalled()
    expect(touchMove()).toBe(false)
  })
})

describe('the browser\u2019s own long-press menu', () => {
  it('is taken while a finger holds or has lifted the row', () => {
    mount()
    pointer('pointerdown', 40, 20)
    expect(contextMenu()).toBe(true)
    expect(rowContextMenu).not.toHaveBeenCalled()
    hold()
    expect(contextMenu()).toBe(true)
    expect(rowContextMenu).not.toHaveBeenCalled()
    pointer('pointerup', 40, 20, { on: window })
    click()
    // The hold's own menu, once.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('tab.contextMenu', expect.objectContaining({ tabId: 't1' }))
  })

  it('goes to the row when no finger is on it (the keyboard\u2019s menu, a button\u2019s hold)', () => {
    mount()
    expect(contextMenu()).toBe(false)
    expect(rowContextMenu).toHaveBeenCalledTimes(1)
  })
})

describe('off the tablet', () => {
  it('takes nothing: the row keeps its pointerdown, its click and its context menu', () => {
    mount(false)
    pointer('pointerdown', 40, 20)
    expect(rowPointerDown).toHaveBeenCalledTimes(1)
    hold()
    expect(liftTabByTouch).not.toHaveBeenCalled()
    expect(contextMenu()).toBe(false)
    expect(rowContextMenu).toHaveBeenCalledTimes(1)
    pointer('pointerup', 40, 20)
    click()
    expect(rowClick).toHaveBeenCalledTimes(1)
  })

  it('a mouse is never a finger', () => {
    mount()
    pointer('pointerdown', 40, 20, { pointerType: 'mouse' })
    expect(rowPointerDown).toHaveBeenCalledTimes(1)
    hold()
    expect(liftTabByTouch).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSidebarSwipe } from '../useSidebarSwipe'

/*
 * TABLET-02: a sideways swipe of a finger across the docked sidebar flips it between the
 * expanded list and the icon rail – towards the window's edge it sits at collapses, away from
 * it expands. Rendered for real so the pointer events go through React: a tap, a vertical pan
 * (the list's scroll) and a mouse must all leave the sidebar alone, a swipe counts once per
 * touch, and the click the finger's lift may produce is swallowed so the row under it does not
 * also activate.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const onCollapse = vi.fn()
const onExpand = vi.fn()
const onRowClick = vi.fn()

function Sidebar({
  side,
  collapsed
}: {
  side: 'left' | 'right'
  collapsed: boolean
}): JSX.Element {
  const swipe = useSidebarSwipe({ side, collapsed, onCollapse, onExpand })
  return (
    <div data-testid="sidebar" {...swipe}>
      <button type="button" data-testid="row" onClick={onRowClick}>
        Tab
      </button>
    </div>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(side: 'left' | 'right', collapsed: boolean): void {
  act(() => {
    root!.render(<Sidebar side={side} collapsed={collapsed} />)
  })
}

const row = (): HTMLElement => host!.querySelector('[data-testid="row"]') as HTMLElement

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  { pointerType = 'touch', pointerId = 1, button = 0 } = {}
): void {
  act(() => {
    row().dispatchEvent(
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

/** The click a browser sends after a finger lifts, on the element under it. */
function click(): void {
  act(() => {
    row().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A finger down at (x, y), a move to (x + dx, y + dy), then up – and the click that follows. */
function swipe(dx: number, dy: number, opts: { pointerType?: string } = {}): void {
  pointer('pointerdown', 100, 300, opts)
  pointer('pointermove', 100 + dx, 300 + dy, opts)
  pointer('pointerup', 100 + dx, 300 + dy, opts)
  click()
}

beforeEach(() => {
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
})

describe('useSidebarSwipe', () => {
  it('a swipe towards the left edge collapses a left sidebar and swallows the click', () => {
    mount('left', false)
    swipe(-60, 4)
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(onExpand).not.toHaveBeenCalled()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('a swipe away from the edge expands a collapsed left sidebar', () => {
    mount('left', true)
    swipe(60, 0)
    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(onCollapse).not.toHaveBeenCalled()
  })

  it('mirrors for a sidebar on the right', () => {
    mount('right', false)
    swipe(60, 0)
    expect(onCollapse).toHaveBeenCalledTimes(1)
    mount('right', true)
    swipe(-60, 0)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('a swipe in the direction the sidebar already is does nothing', () => {
    mount('left', true)
    swipe(-60, 0)
    expect(onCollapse).not.toHaveBeenCalled()
    expect(onExpand).not.toHaveBeenCalled()
    mount('left', false)
    swipe(60, 0)
    expect(onCollapse).not.toHaveBeenCalled()
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('a tap and a short move leave the row its click', () => {
    mount('left', false)
    swipe(0, 0)
    swipe(-30, 0)
    expect(onCollapse).not.toHaveBeenCalled()
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('a vertical pan (the list scrolling) is not a swipe, however far it also drifts sideways', () => {
    mount('left', false)
    swipe(-60, 120)
    expect(onCollapse).not.toHaveBeenCalled()
    // A pan the browser cancels on its own way also leaves nothing behind.
    pointer('pointerdown', 100, 300)
    pointer('pointermove', 60, 500)
    pointer('pointercancel', 60, 500)
    swipe(-60, 0)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('counts a swipe once per touch, even as the finger keeps moving', () => {
    mount('left', false)
    pointer('pointerdown', 200, 300)
    pointer('pointermove', 140, 300)
    pointer('pointermove', 80, 300)
    pointer('pointermove', 20, 300)
    pointer('pointerup', 20, 300)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('a second finger does not start a swipe of its own', () => {
    mount('left', false)
    pointer('pointerdown', 200, 300, { pointerId: 1 })
    pointer('pointerdown', 220, 300, { pointerId: 2 })
    pointer('pointermove', 140, 300, { pointerId: 2 })
    expect(onCollapse).not.toHaveBeenCalled()
    pointer('pointermove', 140, 300, { pointerId: 1 })
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('a mouse is left alone: dragging with it is the desktop tab drag, not a swipe', () => {
    mount('left', false)
    swipe(-80, 0, { pointerType: 'mouse' })
    expect(onCollapse).not.toHaveBeenCalled()
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('reads the props as they stand at the time of the swipe', () => {
    mount('left', false)
    pointer('pointerdown', 100, 300)
    // The sidebar collapsed under the finger (the toolbar's button): the same leftward move now
    // has nothing to do, and a rightward one expands.
    mount('left', true)
    pointer('pointermove', 40, 300)
    expect(onCollapse).not.toHaveBeenCalled()
    pointer('pointerup', 40, 300)
    swipe(60, 0)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})

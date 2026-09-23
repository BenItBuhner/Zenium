// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The bar hold's release (GN-08; v2 §9.13's popover exception, granted on "the finger never
 * lifts – it drags to a row and releases"): the finger that opened a surface with a hold may
 * drag to a row marked `data-hold-pick` and release on it – the row is picked without a lift –
 * or lift anywhere else and leave the surface for a tap, as Chrome Android's popup is used. The
 * click the release itself would produce is eaten either way, and a touch the system takes away
 * (pointercancel) picks nothing.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useBarHold, HOLD_PICK_ATTR } = await import('../useBarHold')

const onHold = vi.fn()
const onRow = vi.fn()

function Bar(): JSX.Element {
  const hold = useBarHold({ onHold })
  return (
    <div data-testid="bar" {...hold}>
      <button type="button" data-bar-item="back" data-testid="back">
        Back
      </button>
    </div>
  )
}

let root: Root | null = null
let mount: HTMLElement | null = null
let row: HTMLElement | null = null

function render(): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Bar />))
  return mount.querySelector<HTMLElement>('[data-testid="back"]')!
}

/** The surface the hold opened: one row that may be picked, elsewhere in the document (the chrome layer). */
function openRow(): HTMLElement {
  row = document.createElement('button')
  row.setAttribute(HOLD_PICK_ATTR, '')
  row.addEventListener('click', onRow)
  document.body.appendChild(row)
  return row
}

const pointer = (el: HTMLElement, type: string, x: number, y: number): void => {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: 'touch',
        button: 0,
        clientX: x,
        clientY: y
      })
    )
  })
}

const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A hold on Back that has fired, the finger still down. */
function holdBack(): HTMLElement {
  const back = render()
  pointer(back, 'pointerdown', 30, 780)
  act(() => vi.advanceTimersByTime(400))
  expect(onHold).toHaveBeenCalledTimes(1)
  expect(onHold.mock.calls[0]![0]).toBe('back')
  return back
}

beforeEach(() => {
  vi.useFakeTimers()
  onHold.mockClear()
  onRow.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  row?.remove()
  row = null
  vi.useRealTimers()
})

describe("the bar hold's release (GN-08, §9.13)", () => {
  it('a finger that drags to a row and releases on it picks the row without a lift', () => {
    const back = holdBack()
    const picked = openRow()
    // The finger stands over the row when it lets go; the event's target is still the button.
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(picked)
    pointer(back, 'pointerup', 40, 700)
    expect(onRow).toHaveBeenCalledTimes(1)
    // The platform's click for the release, should one follow, is eaten: the pick is one pick.
    click(picked)
    expect(onRow).toHaveBeenCalledTimes(1)
  })

  it('a release over nothing to pick leaves the surface for a tap', () => {
    const back = holdBack()
    const waiting = openRow()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(back)
    pointer(back, 'pointerup', 30, 780)
    expect(onRow).not.toHaveBeenCalled()
    // The release's own click is swallowed wherever it lands ...
    click(waiting)
    expect(onRow).not.toHaveBeenCalled()
    // ... and a tap after the grace picks the row as any tap does.
    act(() => vi.advanceTimersByTime(400))
    click(waiting)
    expect(onRow).toHaveBeenCalledTimes(1)
  })

  it('a touch the system takes away picks nothing, wherever the finger was', () => {
    const back = holdBack()
    const under = openRow()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(under)
    pointer(back, 'pointercancel', 40, 700)
    expect(onRow).not.toHaveBeenCalled()
  })

  it("another pointer's release picks nothing for the hold", () => {
    const back = holdBack()
    const under = openRow()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(under)
    act(() => {
      back.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 2,
          pointerType: 'touch',
          button: 0,
          clientX: 40,
          clientY: 700
        })
      )
    })
    expect(onRow).not.toHaveBeenCalled()
  })
})

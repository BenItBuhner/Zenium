// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The slider wrapper (components/ui/slider.tsx) over Radix's: `onValueCommit` receives the value
 * `onValueChange` last reported – where the pointer let go, though React had not drawn the last
 * move when it lifted, and though that move was the slide's only one, for which Radix commits
 * nothing – once per slide; a key's step is reported as a change and then committed, once each.
 * Rendered for real in happy-dom, the slider 100 px wide over 0–100, a pixel a unit; the
 * pointer's events go to the track, where Radix takes pointer capture (happy-dom keeps it).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Slider } = await import('../ui/slider')

/** What the consumer heard, in order: each report of a change and each commit. */
type Entry = ['change' | 'commit', number[]]

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  unmount()
})

function unmount(): void {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
}

/** The slider as its consumers hold it: the value in state, every report and commit logged. */
function Controlled({ initial, log }: { initial: number[]; log: Entry[] }): ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <Slider
      data-testid="slider"
      aria-label="Level"
      max={100}
      step={1}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        log.push(['change', next])
      }}
      onValueCommit={(next) => log.push(['commit', next])}
    />
  )
}

interface Mounted {
  slider: HTMLElement
  track: HTMLElement
  thumb: HTMLElement
}

function mount(el: ReactElement): Mounted {
  unmount()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  const slider = host.querySelector<HTMLElement>('[data-testid="slider"]')!
  // happy-dom lays nothing out: the slider is 100 px wide at the left edge, a pixel a unit.
  Object.defineProperty(slider, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0 })
  })
  return {
    slider,
    track: slider.firstElementChild as HTMLElement,
    thumb: slider.querySelector<HTMLElement>('[role="slider"]')!
  }
}

/** The pointer on the track, one event; the callers say what React gets to draw in between. */
function pointer(track: HTMLElement, type: string, clientX: number): void {
  track.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 }))
}

describe('Slider', () => {
  it('commits where the pointer let go, not where the thumb was last drawn', () => {
    const log: Entry[] = []
    const { track, thumb } = mount(<Controlled initial={[0]} log={log} />)
    act(() => pointer(track, 'pointerdown', 10))
    act(() => pointer(track, 'pointermove', 30))
    expect(thumb.getAttribute('aria-valuenow')).toBe('30')
    // The last move and the lift in one go: 30 is what React last drew when the pointer lifts
    // at 60, and Radix commits what it drew. The commit goes with the pointer.
    act(() => {
      pointer(track, 'pointermove', 60)
      pointer(track, 'pointerup', 60)
    })
    expect(log).toEqual([
      ['change', [10]],
      ['change', [30]],
      ['change', [60]],
      ['commit', [60]]
    ])
    expect(thumb.getAttribute('aria-valuenow')).toBe('60')
  })

  it('commits a slide whose only move React had not drawn, for which Radix commits nothing', () => {
    const log: Entry[] = []
    const { track, thumb } = mount(<Controlled initial={[10]} log={log} />)
    // Down on the thumb's own position: nothing changes, so Radix sees the thumb where it was
    // when the pointer lifts and skips its commit. The release commits the reported value once.
    act(() => pointer(track, 'pointerdown', 10))
    act(() => {
      pointer(track, 'pointermove', 60)
      pointer(track, 'pointerup', 60)
    })
    expect(log).toEqual([
      ['change', [60]],
      ['commit', [60]]
    ])
    expect(thumb.getAttribute('aria-valuenow')).toBe('60')
  })

  it("a key's step is reported as a change and then committed, once each", () => {
    const log: Entry[] = []
    const { thumb } = mount(<Controlled initial={[10]} log={log} />)
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(log).toEqual([
      ['change', [11]],
      ['commit', [11]]
    ])
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(log.slice(2)).toEqual([
      ['change', [0]],
      ['commit', [0]]
    ])
    expect(thumb.getAttribute('aria-valuenow')).toBe('0')
  })

  it('a tap commits once where it put the thumb, and not at all where the thumb stayed', () => {
    const log: Entry[] = []
    const { track } = mount(<Controlled initial={[10]} log={log} />)
    act(() => pointer(track, 'pointerdown', 10))
    act(() => pointer(track, 'pointerup', 10))
    expect(log).toEqual([])
    act(() => pointer(track, 'pointerdown', 40))
    act(() => pointer(track, 'pointerup', 40))
    expect(log).toEqual([
      ['change', [40]],
      ['commit', [40]]
    ])
  })

  it('lostpointercapture settles a slide the browser ended without a pointerup, and adds nothing after one', () => {
    const log: Entry[] = []
    const { track } = mount(<Controlled initial={[10]} log={log} />)
    act(() => pointer(track, 'pointerdown', 10))
    act(() => pointer(track, 'pointermove', 60))
    // The pointer was cancelled (no pointerup): the capture's loss ends the slide.
    act(() => pointer(track, 'lostpointercapture', 60))
    expect(log).toEqual([
      ['change', [60]],
      ['commit', [60]]
    ])
    // After a pointerup the browser reports the capture's loss too: the slide is over already.
    act(() => pointer(track, 'pointerdown', 60))
    act(() => {
      pointer(track, 'pointermove', 80)
      pointer(track, 'pointerup', 80)
    })
    act(() => pointer(track, 'lostpointercapture', 80))
    expect(log.slice(2)).toEqual([
      ['change', [80]],
      ['commit', [80]]
    ])
  })

  it('holds the value of a slider given defaultValue and commits its slides the same way', () => {
    const log: Entry[] = []
    const { track, thumb } = mount(
      <Slider
        data-testid="slider"
        aria-label="Level"
        max={100}
        step={1}
        defaultValue={[10]}
        onValueChange={(next) => log.push(['change', next])}
        onValueCommit={(next) => log.push(['commit', next])}
      />
    )
    expect(thumb.getAttribute('aria-valuenow')).toBe('10')
    act(() => pointer(track, 'pointerdown', 10))
    act(() => {
      pointer(track, 'pointermove', 60)
      pointer(track, 'pointerup', 60)
    })
    expect(log).toEqual([
      ['change', [60]],
      ['commit', [60]]
    ])
    expect(thumb.getAttribute('aria-valuenow')).toBe('60')
  })

  it("runs the consumer's own pointer handlers first, and starts no slide on a pointerdown they prevent", () => {
    const log: Entry[] = []
    const seen: string[] = []
    const slider = (prevent: boolean): ReactElement => (
      <Slider
        data-testid="slider"
        aria-label="Level"
        max={100}
        step={1}
        defaultValue={[10]}
        onPointerDown={(event) => {
          seen.push('down')
          if (prevent) event.preventDefault()
        }}
        onPointerUp={() => seen.push('up')}
        onValueChange={(next) => log.push(['change', next])}
        onValueCommit={(next) => log.push(['commit', next])}
      />
    )
    let { track } = mount(slider(true))
    act(() => pointer(track, 'pointerdown', 40))
    act(() => pointer(track, 'pointerup', 40))
    expect(seen).toEqual(['down', 'up'])
    expect(log).toEqual([])
    ;({ track } = mount(slider(false)))
    act(() => pointer(track, 'pointerdown', 40))
    act(() => pointer(track, 'pointerup', 40))
    expect(seen).toEqual(['down', 'up', 'down', 'up'])
    expect(log).toEqual([
      ['change', [40]],
      ['commit', [40]]
    ])
  })
})

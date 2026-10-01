// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOTION_POP_MS } from '../../lib/motion/tokens'
import { attachFadeEdges, type FadeEdges } from '../useFadeEdges'

/*
 * The fading edges of a scroll container (`useFadeEdges`): each edge fades only while content
 * lies past it, and a container whose header marks scrolled-under content with a hairline
 * instead (the sheet chassis, v2 §9.7) fades its end edge alone. The mask (`data-fade-axis`)
 * is on the container only while an edge fades: a container with nothing past either edge
 * carries none.
 */

let raf: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    raf.push(cb)
    return raf.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  raf = []
})

/** A 300 px box over 900 px of content, scrolled to `top`, its fades kept by `attachFadeEdges`. */
function scroller(edges: FadeEdges): {
  el: HTMLElement
  detach: () => void
  scrollTo: (top: number) => void
} {
  const el = document.createElement('div')
  let top = 0
  Object.defineProperty(el, 'clientHeight', { get: () => 300 })
  Object.defineProperty(el, 'scrollHeight', { get: () => 900 })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    }
  })
  const detach = attachFadeEdges(el, 'y', 16, edges)
  return {
    el,
    detach,
    scrollTo: (next: number) => {
      el.scrollTop = next
      el.dispatchEvent(new Event('scroll'))
      for (const cb of raf.splice(0)) cb()
    }
  }
}

const fades = (el: HTMLElement): [string, string] => [
  el.style.getPropertyValue('--zen-fade-start'),
  el.style.getPropertyValue('--zen-fade-end')
]

describe('attachFadeEdges', () => {
  it('fades each edge only while content lies past it', () => {
    const { el, scrollTo } = scroller('both')
    expect(el.dataset.fadeAxis).toBe('y')
    expect(fades(el)).toEqual(['0px', '16px'])
    scrollTo(100)
    expect(fades(el)).toEqual(['16px', '16px'])
    scrollTo(600)
    expect(fades(el)).toEqual(['16px', '0px'])
  })

  it('fades the end edge alone for a container whose header draws the hairline instead', () => {
    const { el, scrollTo } = scroller('end')
    expect(fades(el)).toEqual(['0px', '16px'])
    scrollTo(100)
    expect(fades(el)).toEqual(['0px', '16px'])
    scrollTo(600)
    expect(fades(el)).toEqual(['0px', '0px'])
  })

  it('a list that fits has no fade; the end fade comes on as rows overflow the box and goes as they leave', async () => {
    // The tab list's edges (MOT-33): 44 rows at a 46 pitch in a 300 box – six fit, the seventh
    // overflows. The rows' arrival and departure are DOM mutations, which schedule the measure.
    const el = document.createElement('div')
    let rows = 6
    Object.defineProperty(el, 'clientHeight', { get: () => 300 })
    Object.defineProperty(el, 'scrollHeight', { get: () => Math.max(300, rows * 46 - 2) })
    Object.defineProperty(el, 'scrollTop', { get: () => 0, set: () => undefined })
    attachFadeEdges(el, 'y', 24, 'both')
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const cb of raf.splice(0)) cb()
    }
    // Nothing past either edge: no fade, and no mask on the list.
    expect(fades(el)).toEqual(['0px', '0px'])
    expect(el.dataset.fadeAxis).toBeUndefined()
    rows = 7
    el.append(document.createElement('div'))
    await settle()
    expect(fades(el)).toEqual(['0px', '24px'])
    expect(el.dataset.fadeAxis).toBe('y')
    rows = 6
    el.firstChild?.remove()
    await settle()
    expect(fades(el)).toEqual(['0px', '0px'])
  })

  it('the mask is on the container only while an edge fades: it comes with the first fade and goes once the last has eased out', () => {
    // W6-S26-e (#731): the selection menu's rows fit its sheet, so neither edge faded – yet the
    // body carried the mask (0 px fades draw nothing), and the compositor lost that mask layer
    // when the sheet was flung, blanking the rows under it. A container with nothing past
    // either edge carries no mask at all; the mask returns with a fade.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { el, scrollTo } = scroller('end')
    expect(el.dataset.fadeAxis).toBe('y')
    expect(fades(el)).toEqual(['0px', '16px'])
    // At the end of an end-only container nothing fades: the depth eases out under the mask
    // for `MOTION_POP_MS` (the `[data-fade-axis]` transition), then the mask goes.
    scrollTo(600)
    expect(fades(el)).toEqual(['0px', '0px'])
    expect(el.dataset.fadeAxis).toBe('y')
    vi.advanceTimersByTime(MOTION_POP_MS - 1)
    expect(el.dataset.fadeAxis).toBe('y')
    vi.advanceTimersByTime(1)
    expect(el.dataset.fadeAxis).toBeUndefined()
    expect(fades(el)).toEqual(['0px', '0px'])
    // Back from the end, the mask returns with the fade.
    scrollTo(0)
    expect(el.dataset.fadeAxis).toBe('y')
    expect(fades(el)).toEqual(['0px', '16px'])
  })

  it('a fade that returns within the ease-out keeps its mask; teardown drops a pending unmask', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { el, detach, scrollTo } = scroller('end')
    scrollTo(600)
    vi.advanceTimersByTime(MOTION_POP_MS / 2)
    scrollTo(0)
    vi.advanceTimersByTime(MOTION_POP_MS * 2)
    expect(el.dataset.fadeAxis).toBe('y')
    expect(fades(el)).toEqual(['0px', '16px'])
    scrollTo(600)
    detach()
    expect(el.dataset.fadeAxis).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachFadeEdges, type FadeEdges } from '../useFadeEdges'

/*
 * The fading edges of a scroll container (`useFadeEdges`): each edge fades only while content
 * lies past it, and a container whose header marks scrolled-under content with a hairline
 * instead (the sheet chassis, v2 §9.7) fades its end edge alone.
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
  raf = []
})

/** A 300 px box over 900 px of content, scrolled to `top`, its fades kept by `attachFadeEdges`. */
function scroller(edges: FadeEdges): { el: HTMLElement; scrollTo: (top: number) => void } {
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
  attachFadeEdges(el, 'y', 16, edges)
  return {
    el,
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
    expect(fades(el)).toEqual(['0px', '0px'])
    rows = 7
    el.append(document.createElement('div'))
    await settle()
    expect(fades(el)).toEqual(['0px', '24px'])
    rows = 6
    el.firstChild?.remove()
    await settle()
    expect(fades(el)).toEqual(['0px', '0px'])
  })
})

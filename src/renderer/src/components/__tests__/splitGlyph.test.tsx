// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SplitGlyph } from '../SplitGlyph'

/*
 * The split glyph (split-05): one rounded frame divided as the split is, the pane it stands for
 * filled – a picture in the row's or the chip's ink, hidden from assistive technology.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: ReactElement): SVGSVGElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host.querySelector('svg')!
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const num = (el: Element | null, attr: string): number => Number(el?.getAttribute(attr))

describe('SplitGlyph', () => {
  it('is a 16 box in the current ink, hidden from the accessibility tree, sized as asked', () => {
    const svg = render(<SplitGlyph layout="vertical" count={2} index={0} />)
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    const shapes = [...svg.querySelectorAll('rect, path')].filter((s) => !s.closest('clipPath'))
    expect(shapes).toHaveLength(3)
    for (const shape of shapes) {
      const paint = shape.getAttribute('fill') === 'none' ? 'stroke' : 'fill'
      expect(shape.getAttribute(paint)).toBe('currentColor')
    }
    const small = render(<SplitGlyph layout="vertical" count={2} index={0} size={14} />)
    expect(small.getAttribute('width')).toBe('14')
    expect(small.getAttribute('height')).toBe('14')
  })

  it('fills the pane it stands for: the right column of two, the bottom row of a grid of three', () => {
    const right = render(<SplitGlyph layout="vertical" count={2} index={1} />)
    const fill = right.querySelector('rect[fill="currentColor"]')!
    // The two columns share the box inside the frame; the filled one starts at its middle.
    expect(num(fill, 'x')).toBeCloseTo(8, 5)
    expect(num(fill, 'width')).toBeCloseTo(6.25, 5)
    expect(num(fill, 'height')).toBeCloseTo(12.5, 5)
    expect(right.getAttribute('data-split-pane')).toBe('1')

    const bottom = render(<SplitGlyph layout="grid" count={3} index={2} />)
    const wide = bottom.querySelector('rect[fill="currentColor"]')!
    expect(num(wide, 'x')).toBeCloseTo(1.75, 5)
    expect(num(wide, 'width')).toBeCloseTo(12.5, 5)
    expect(num(wide, 'y')).toBeCloseTo(8, 5)
    // Its dividers: one down the top row's middle, one across the frame under the top row.
    expect(bottom.querySelector('path')!.getAttribute('d')).toBe('M8 1.75v6.25M1.75 8h12.5')
  })

  it('clamps to the 2–4 panes a split can have and to a pane the split has', () => {
    const one = render(<SplitGlyph layout="horizontal" count={1} index={5} />)
    expect(one.getAttribute('data-split-panes')).toBe('2')
    expect(one.getAttribute('data-split-pane')).toBe('1')
    const many = render(<SplitGlyph layout="grid" count={9} index={-1} />)
    expect(many.getAttribute('data-split-panes')).toBe('4')
    expect(many.getAttribute('data-split-pane')).toBe('0')
    // Four panes in a grid: a cross.
    expect(many.querySelector('path')!.getAttribute('d')).toBe(
      'M8 1.75v6.25M1.75 8h6.25M8 8v6.25M8 8h6.25'
    )
  })
})

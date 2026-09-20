import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ControlRow } from '../ControlRow'

/**
 * §9.34: the row wrapper marks a row `data-control` while it holds a shared control; the surface
 * never sets the mark by hand. The markup here is the byte-for-byte shape the translate rows
 * carried before the wrapper, so the primitive's 40 / 48 / 36 rows draw as they did.
 */
describe('ControlRow', () => {
  it('marks a row that holds a control, static, on the shared row class', () => {
    const html = renderToStaticMarkup(
      createElement(ControlRow, { 'data-word': 'colour' } as never, 'colour')
    )
    expect(html).toBe(
      '<div class="zen-v2-row" data-static="" data-control="" data-word="colour">colour</div>'
    )
  })

  it('leaves the mark off a row that carries no control', () => {
    const html = renderToStaticMarkup(createElement(ControlRow, { control: false }, 'Model'))
    expect(html).toBe('<div class="zen-v2-row" data-static="">Model</div>')
  })

  it('renders the add rows as a form with the surface class beside the primitive', () => {
    const html = renderToStaticMarkup(
      createElement(ControlRow, {
        as: 'form',
        className: 'zen-translate-add',
        'aria-disabled': true
      } as never)
    )
    expect(html).toBe(
      '<form class="zen-v2-row zen-translate-add" data-static="" data-control="" aria-disabled="true"></form>'
    )
  })
})

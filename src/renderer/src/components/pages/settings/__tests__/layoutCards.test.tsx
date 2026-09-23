// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ToolbarLayout } from '@shared/types'
import { TOOLBAR_LAYOUTS, TOOLBAR_LAYOUT_LABELS } from '@shared/toolbarLayout'
import { LayoutCards } from '../LayoutCards'

/*
 * Look and Feel › Layout (design language v2 §9.37; §10.4's image radio cards): one radiogroup
 * of four picture cards in the layouts' card order, the current one checked, each named by its
 * caption and carrying a drawing of its own, a click on a card picking its layout live.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const cards = (h: HTMLElement): HTMLButtonElement[] => [
  ...h.querySelectorAll<HTMLButtonElement>('[data-layout-cards] [role="radio"]')
]

describe('LayoutCards', () => {
  it('is one labelled radiogroup of the four layouts in card order, captioned as Settings names them', () => {
    const h = render(<LayoutCards value="single" onChange={() => undefined} />)
    const group = h.querySelector<HTMLElement>('[role="radiogroup"]')
    expect(group?.hasAttribute('data-layout-cards')).toBe(true)
    const label = document.getElementById(group?.getAttribute('aria-labelledby') ?? '')
    expect(label?.textContent).toBe('Layout')
    expect(cards(h).map((c) => c.dataset.value)).toEqual([...TOOLBAR_LAYOUTS])
    expect(cards(h).map((c) => c.querySelector('.zen-settings-icon-caption')?.textContent)).toEqual(
      ['Only sidebar', 'Sidebar and top toolbar', 'Collapsed sidebar', 'Horizontal tabs']
    )
    expect(cards(h).map((c) => c.textContent)).toEqual(
      TOOLBAR_LAYOUTS.map((layout) => TOOLBAR_LAYOUT_LABELS[layout])
    )
  })

  it('checks the current layout alone and wears the shared card radio', () => {
    const h = render(<LayoutCards value="horizontal" onChange={() => undefined} />)
    expect(cards(h).map((c) => c.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'true'
    ])
    for (const card of cards(h)) {
      expect(card.type).toBe('button')
      expect(card.classList.contains('zen-v2-card-radio')).toBe(true)
    }
  })

  it('draws every card its own picture, hidden from assistive technology', () => {
    const h = render(<LayoutCards value="single" onChange={() => undefined} />)
    const pictures = cards(h).map((c) => c.querySelector<SVGElement>('svg'))
    expect(pictures.every((p) => p !== null && p.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(pictures.map((p) => p?.dataset.layoutPicture)).toEqual([...TOOLBAR_LAYOUTS])
    // The four drawings differ where the layouts do: no two share their marks.
    const marks = pictures.map((p) => p?.innerHTML ?? '')
    expect(new Set(marks).size).toBe(4)
    // Every drawing takes its colours from the tokens, so both schemes draw it.
    for (const mark of marks) {
      expect(mark).toContain('var(--v2-fill)')
      expect(mark).toContain('var(--v2-accent)')
      expect(mark).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })

  it('picks a layout on a click, live', () => {
    const onChange = vi.fn<(layout: ToolbarLayout) => void>()
    const h = render(<LayoutCards value="single" onChange={onChange} />)
    act(() => cards(h)[3]?.click())
    expect(onChange).toHaveBeenCalledWith('horizontal')
    act(() => cards(h)[1]?.click())
    expect(onChange).toHaveBeenLastCalledWith('multiple')
  })
})

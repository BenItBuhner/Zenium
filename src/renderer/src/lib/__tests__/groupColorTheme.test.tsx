// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertySymbol } from 'happy-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder } from '@shared/types'
import { FOLDER_COLOR_ORDER } from '@shared/defaults'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { GroupColorPalette } from '@renderer/components/phone/GroupsPane'
import { groupColorChannels, groupColorVars } from '../groups'

/*
 * A group colour follows the theme live (design language v2 §9.14: one set a scheme). The
 * element wearing it carries both schemes' channels (`groupColorVars`) and the marker
 * `data-group-rgb`; two rules in main.css derive `--zen-group-rgb` from the pair by the root's
 * `data-theme` – the attribute `useTheme`'s `paint()` writes – so a flip of the theme recolours
 * every reader of `rgb(var(--zen-group-rgb) / α)` with no component reading the theme. The
 * stylesheet's own rules, on a bare carrier and on the phone's swatch row (`GroupColorPalette`,
 * the Groups pane's and the group card's sheets).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet, braces included. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at) + 1)
}

/** The rules under test, as written in main.css: the two picks and three readers. */
const RULES = [
  rule('[data-group-rgb]'),
  rule(":root[data-theme='dark'] [data-group-rgb]"),
  rule('.zen-group-editor-swatch-disc'),
  rule('.zen-overview-group-glyph'),
  rule('.zen-group-row-dot')
].join('\n')

/**
 * The theme flipped as `useTheme`'s `paint()` flips it. happy-dom (20.14) keeps an element's
 * selector matches – and with them its computed style – cached across an ANCESTOR's attribute
 * change, where a browser restyles (it drops them on the element's own attributes, a tree
 * mutation, a focus change), so the flip is followed by the drop a restyle stands for: the
 * document's cache cleared through happy-dom's own symbol, before anything reads a computed
 * style (a read between the flip and the clear caches the stale match again, and that one the
 * document's clear does not reach). Nothing in the tree changes.
 */
function flipTheme(scheme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = scheme
  document.documentElement.style.colorScheme = scheme
  ;(document as unknown as Record<symbol, () => void>)[PropertySymbol.clearCache]()
}

const computed = (el: Element, property: string): string =>
  getComputedStyle(el).getPropertyValue(property).trim()

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  const style = document.createElement('style')
  style.textContent = RULES
  document.head.appendChild(style)
  host = document.createElement('div')
  document.body.appendChild(host)
  flipTheme('light')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  document.head.innerHTML = ''
  delete document.documentElement.dataset.theme
})

describe('a group colour follows the theme (§9.14)', () => {
  it('derives --zen-group-rgb from the pair on the carrier by the root’s data-theme', () => {
    const el = document.createElement('span')
    el.setAttribute('data-group-rgb', '')
    el.className = 'zen-group-row-dot'
    for (const [name, value] of Object.entries(groupColorVars('blue'))) {
      el.style.setProperty(name, value)
    }
    host!.appendChild(el)

    expect(computed(el, '--zen-group-rgb')).toBe(groupColorChannels('blue', 'light'))
    expect(computed(el, 'background-color')).toBe(`rgb(${groupColorChannels('blue', 'light')})`)

    flipTheme('dark')
    expect(computed(el, '--zen-group-rgb')).toBe(groupColorChannels('blue', 'dark'))
    expect(computed(el, 'background-color')).toBe(`rgb(${groupColorChannels('blue', 'dark')})`)
    expect(groupColorChannels('blue', 'dark')).not.toBe(groupColorChannels('blue', 'light'))

    flipTheme('light')
    expect(computed(el, '--zen-group-rgb')).toBe(groupColorChannels('blue', 'light'))
  })

  it('leaves an element without the marker out: no --zen-group-rgb of its own to read', () => {
    const el = document.createElement('span')
    for (const [name, value] of Object.entries(groupColorVars('blue'))) {
      el.style.setProperty(name, value)
    }
    host!.appendChild(el)
    expect(computed(el, '--zen-group-rgb')).toBe('')
  })

  it('recolours the phone’s swatch row on the flip: every swatch shows its scheme’s value', () => {
    const folder = {
      id: 'work',
      spaceId: 'space',
      name: 'Work',
      icon: '📁',
      collapsed: false,
      color: 'blue'
    } as Folder
    root = createRoot(host!)
    act(() => root!.render(<GroupColorPalette folder={folder} />))
    const swatches = Array.from(host!.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(swatches).toHaveLength(9)
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Grey',
      'Blue',
      'Red',
      'Yellow',
      'Green',
      'Pink',
      'Purple',
      'Cyan',
      'Orange'
    ])
    const light = swatches.map((s) => computed(s, '--zen-group-rgb'))
    expect(light).toEqual(FOLDER_COLOR_ORDER.map((c) => groupColorChannels(c, 'light')))

    flipTheme('dark')
    const dark = swatches.map((s) => computed(s, '--zen-group-rgb'))
    expect(dark).toEqual(FOLDER_COLOR_ORDER.map((c) => groupColorChannels(c, 'dark')))
    // Nine colours, nine flips: no value survives the scheme change.
    light.forEach((value, i) => expect(dark[i], FOLDER_COLOR_ORDER[i]).not.toBe(value))
  })

  it('is the stylesheet’s only word on --zen-group-rgb: the two picks, nothing else declares it', () => {
    const declarations = css.match(/--zen-group-rgb:\s*[^;]+;/g) ?? []
    expect(declarations).toEqual([
      '--zen-group-rgb: var(--zen-group-rgb-light);',
      '--zen-group-rgb: var(--zen-group-rgb-dark);'
    ])
    // Unlayered and on the carrier: the dark pick outranks the light one by the root's attribute.
    const light = css.indexOf('[data-group-rgb] {')
    const dark = css.indexOf(":root[data-theme='dark'] [data-group-rgb] {")
    expect(light).toBeGreaterThan(0)
    expect(dark).toBeGreaterThan(light)
    expect(css.slice(0, light)).not.toMatch(/@layer\s+\w+\s*\{[^}]*$/)
  })
})

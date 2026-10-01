// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder } from '@shared/types'

/*
 * A saved group as a card of the overview grid (the cleanup spec §2; TAB-16): the folded group
 * card's dress with the saved ring, the pages' count, a mosaic of the kept pages (three and a
 * "+N" past four), a tap that reopens it and nothing else in the tree but the header.
 */

Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SavedGroupCard } = await import('../SavedGroupCard')
const { groupRowOf } = await import('@renderer/lib/groupRows')
const { DEFAULT_FOLDER_ICON } = await import('@renderer/lib/groups')

const pages = (n: number): NonNullable<Folder['savedTabs']> =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://p${i}.example/`,
    title: i === 0 ? '' : `Page ${i}`,
    favicon: i % 2 ? `https://p${i}.example/favicon.ico` : null
  }))

const folder = (n: number, over: Partial<Folder> = {}): Folder => ({
  id: 'saved-1',
  spaceId: 'space',
  name: 'Trip',
  icon: DEFAULT_FOLDER_ICON,
  collapsed: false,
  color: 'green',
  savedTabs: pages(n),
  ...over
})

let root: Root | null = null
let host: HTMLElement | null = null
const onOpen = vi.fn<(folder: Folder) => void>()
const onMenu = vi.fn()

function card(n: number, over: Partial<Folder> = {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const f = folder(n, over)
  act(() => root!.render(createElement(SavedGroupCard, { row: groupRowOf(f, []), onOpen, onMenu })))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  onOpen.mockClear()
  onMenu.mockClear()
})

describe('SavedGroupCard', () => {
  it('is a folded card with the saved ring, the name, the pages’ count and a sentence that says saved', () => {
    const el = card(5)
    const shell = el.querySelector<HTMLElement>('.zen-group')!
    expect(shell.dataset.cell).toBe('saved:saved-1')
    expect(shell.hasAttribute('data-collapsed')).toBe(true)
    expect(shell.hasAttribute('data-saved')).toBe(true)
    const header = el.querySelector<HTMLElement>('[data-testid="saved-group-card"]')!
    expect(header.getAttribute('role')).toBe('button')
    expect(header.getAttribute('aria-label')).toBe('Trip, tab group, 5 tabs, saved')
    expect(el.querySelector('[data-testid="group-row-glyph"]')!.hasAttribute('data-saved')).toBe(
      true
    )
    expect(el.querySelector('[data-testid="group-card-count"]')!.textContent).toBe('5')
    expect(el.querySelectorAll('button').length).toBe(0)
  })

  it('tiles the first three pages and names the rest past four; fewer pages leave quiet tiles', () => {
    const five = card(5)
    const tiles = [...five.querySelectorAll<HTMLElement>('.zen-group-tile')]
    expect(tiles.map((t) => t.dataset.tile)).toEqual([
      'https://p0.example/',
      'https://p1.example/',
      'https://p2.example/',
      'more'
    ])
    expect(tiles[3].textContent).toBe('+2')
    // A page with no title reads its address; a favicon kept is drawn, none is a quiet disc.
    expect(tiles[0].querySelector('.zen-group-tile-title')!.textContent).toBe('https://p0.example/')
    expect(tiles[0].querySelector('img')).toBeNull()
    expect(tiles[1].querySelector('img')!.getAttribute('src')).toBe(
      'https://p1.example/favicon.ico'
    )
    act(() => root?.unmount())
    root = null
    const two = card(2)
    expect(
      [...two.querySelectorAll<HTMLElement>('.zen-group-tile')].map((t) => t.dataset.tile)
    ).toEqual(['https://p0.example/', 'https://p1.example/', 'empty', 'empty'])
  })

  it('a tap on the header or anywhere on the card reopens the group', () => {
    const el = card(3)
    const click = (node: Element): void => {
      act(() => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }
    click(el.querySelector('[data-testid="saved-group-card"]')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0].id).toBe('saved-1')
    click(el.querySelector('[data-testid="group-card-tap"]')!)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onMenu).not.toHaveBeenCalled()
  })
})

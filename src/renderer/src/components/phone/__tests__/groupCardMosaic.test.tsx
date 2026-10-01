// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'

/*
 * The folded group card's 2×2 mosaic (tab overview cleanup spec §2): a tile is the member's
 * capture alone or – with none – its favicon alone on the placeholder's fill, never the card's
 * title or host at tile size, which is noise (ruled on #731). The "+N" tile past four members
 * and the quiet slots of a smaller group are the face's own, not a member's text.
 */

Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { GroupCard } = await import('../GroupCard')
const { DEFAULT_FOLDER_ICON } = await import('@renderer/lib/groups')
const { placeholderPx } = await import('../tabPlaceholder')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

const tab = (id: string): Tab =>
  ({
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.example/story`,
    title: `The ${id} story`,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: 'g',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0
  }) as Tab

const folder: Folder = {
  id: 'g',
  spaceId: 'space',
  name: 'Research',
  icon: DEFAULT_FOLDER_ICON,
  collapsed: true,
  color: 'blue'
}

let root: Root | null = null
let host: HTMLElement | null = null

function card(count: number): HTMLElement {
  const tabs = Array.from({ length: count }, (_, i) => tab(`t${i}`))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(GroupCard, {
        folder,
        tabs,
        card: (t: Tab) => createElement('div', { key: t.id }, t.title),
        onMenu: () => undefined,
        onNewTab: () => undefined,
        onCloseGroup: () => undefined,
        onDelete: () => undefined,
        columns: 2
      })
    )
  )
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

const tiles = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[data-testid="group-card-mosaic"] .zen-group-tile')
]

describe('the folded group card’s mosaic (§2)', () => {
  it('draws an uncaptured member as its favicon alone on the placeholder’s fill – no title, no host', () => {
    const el = card(5)
    const mosaic = el.querySelector<HTMLElement>('[data-testid="group-card-mosaic"]')!
    expect(mosaic.getAttribute('aria-hidden')).toBe('true')
    const all = tiles(el)
    expect(all.map((t) => t.dataset.tile)).toEqual(['t0', 't1', 't2', 'more'])
    const [iconPx] = placeholderPx(0.45)
    expect(iconPx).toBe(16)
    for (const tile of all.slice(0, 3)) {
      const face = tile.querySelector<HTMLElement>('[data-testid="tab-preview-tile"]')!
      expect(face.classList.contains('zen-tab-placeholder')).toBe(true)
      expect(face.classList.contains('items-center')).toBe(true)
      expect(face.classList.contains('justify-center')).toBe(true)
      // One child: the favicon, at the placeholder's icon size for a tile; whatever text the
      // tile carries is the favicon's own (a letter tile for a page with no icon).
      expect(face.children).toHaveLength(1)
      const favicon = face.firstElementChild as HTMLElement
      expect(favicon.classList.contains('zen-tab-favicon')).toBe(true)
      expect(favicon.style.width).toBe('16px')
      expect(tile.textContent).toBe(favicon.textContent)
      expect(tile.textContent).not.toMatch(/story|example/)
    }
    expect(all[3]!.textContent).toBe('+2')
  })

  it('a smaller group leaves quiet slots, and the stylesheet has no tile title to draw', () => {
    const el = card(2)
    expect(tiles(el).map((t) => t.dataset.tile)).toEqual(['t0', 't1', 'empty', 'empty'])
    for (const tile of tiles(el).slice(2)) expect(tile.textContent).toBe('')
    expect(css).not.toMatch(/\.zen-group-tile-title/)
    expect(css).toMatch(
      /\.zen-group-tile-page \{\s*display: flex;\s*align-items: center;\s*justify-content: center;\s*\}/
    )
  })
})

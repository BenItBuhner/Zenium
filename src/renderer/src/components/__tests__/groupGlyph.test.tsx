// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'
import { FOLDER_COLORS_DARK, FOLDER_COLORS_LIGHT } from '@shared/defaults'
import { hexToRgb } from '@shared/theme'

/*
 * One group glyph everywhere (design language v2 §9.37; the lead's verdict on #360: "the
 * tablet's 10 dot / 10 ring at a 2 stroke") and the count as the aside (§9.36: 13 at 69%
 * `tabular-nums`, in both states, on both hosts, never a badge). The shared `GroupGlyph` is the
 * mark on every host – the tablet's row, the phone's card header and its Departures ghost, the
 * Groups pane's rows, the strip's chip, the swipe track's ribbon, the sheets' leading boxes – and
 * no host draws a dot, badge or count rule of its own any more.
 */

Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { GroupGlyph } = await import('../GroupGlyph')
const { GroupCard } = await import('../phone/GroupCard')
const { DEFAULT_FOLDER_ICON } = await import('@renderer/lib/groups')

const components = resolve(__dirname, '..')
const css = readFileSync(resolve(components, '../assets/main.css'), 'utf8')
const source = (path: string): string => readFileSync(resolve(components, path), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at) + 1)
}

const channels = (hex: string): string => hexToRgb(hex)!.join(' ')

const folder = (over: Partial<Folder> = {}): Folder => ({
  id: 'g',
  spaceId: 'space',
  name: 'Research',
  icon: DEFAULT_FOLDER_ICON,
  collapsed: false,
  color: 'blue',
  ...over
})

const tab = (id: string): Tab =>
  ({
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
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

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: JSX.Element): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

describe('the one group glyph (§9.37)', () => {
  it('is the 16 box with the 10 dot of the group’s colour, wearing §9.14’s pair itself', () => {
    const el = render(<GroupGlyph folder={folder()} />)
    const glyph = el.querySelector<HTMLElement>('.zen-group-row-glyph')!
    expect(glyph.dataset.testid).toBe('group-row-glyph')
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.hasAttribute('data-saved')).toBe(false)
    // The pair on the glyph, with the marker main.css derives the theme's pick from: it stands on
    // any host without the host carrying the colour for it.
    expect(glyph.hasAttribute('data-group-rgb')).toBe(true)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-light')).toBe(
      channels(FOLDER_COLORS_LIGHT.blue)
    )
    expect(glyph.style.getPropertyValue('--zen-group-rgb-dark')).toBe(
      channels(FOLDER_COLORS_DARK.blue)
    )
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(glyph.querySelector('.zen-group-row-icon')).toBeNull()
  })

  it('is the same 10 as a ring at a 2 stroke for a saved group, and the folder’s own icon at 14 where it has one', () => {
    const ring = render(
      <GroupGlyph folder={folder({ color: 'green' })} saved />
    ).querySelector<HTMLElement>('.zen-group-row-glyph')!
    expect(ring.hasAttribute('data-saved')).toBe(true)
    expect(ring.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(ring.style.getPropertyValue('--zen-group-rgb-light')).toBe(
      channels(FOLDER_COLORS_LIGHT.green)
    )
    act(() => root?.unmount())
    host?.remove()
    const own = render(<GroupGlyph folder={folder({ icon: '📚' })} />).querySelector<HTMLElement>(
      '.zen-group-row-glyph'
    )!
    // As generated content off `data-icon`, so a row's `textContent` – what the drivers read a
    // sheet row by – stays its words.
    expect(own.querySelector('.zen-group-row-icon')?.getAttribute('data-icon')).toBe('📚')
    expect(own.textContent).toBe('')
    expect(rule('.zen-group-row-icon::before')).toContain('content: attr(data-icon)')
    expect(own.querySelector('.zen-group-row-dot')).toBeNull()
    // The icon's glyph wears the pair too: the colour still tints the card and the line around it.
    expect(own.style.getPropertyValue('--zen-group-rgb-light')).toBe(
      channels(FOLDER_COLORS_LIGHT.blue)
    )
  })

  it('reads its sizes from one place in the stylesheet: 16 box, 10 dot, inset 2 ring, 14 icon over the text zoom', () => {
    const box = rule('.zen-group-row-glyph')
    expect(box).toContain('width: 16px')
    expect(box).toContain('height: 16px')
    const dot = rule('.zen-group-row-dot')
    expect(dot).toContain('width: 10px')
    expect(dot).toContain('height: 10px')
    expect(dot).toContain('border-radius: 50%')
    expect(dot).toContain('background: rgb(var(--zen-group-rgb))')
    const ring = rule('.zen-group-row-glyph[data-saved] .zen-group-row-dot')
    expect(ring).toContain('background: transparent')
    expect(ring).toContain('box-shadow: inset 0 0 0 2px rgb(var(--zen-group-rgb))')
    expect(rule('.zen-group-row-icon')).toContain('font-size: calc(14px / var(--zen-text-zoom, 1))')
    // No other glyph rule survives: the card's dot with its halo, its badge, the pane's 12 dot.
    for (const gone of ['.zen-group-dot', '.zen-group-badge', '.zen-overview-group-glyph']) {
      expect(css, gone).not.toContain(gone)
    }
  })

  it('is what every host draws – no dot, badge or glyph of a host’s own', () => {
    const hosts = [
      'sidebar/SpacePanel.tsx',
      'phone/GroupCard.tsx',
      'phone/Departures.tsx',
      'phone/GroupStrip.tsx',
      'phone/GroupsPane.tsx',
      'phone/TabOverview.tsx',
      'phone/TabSwitchStage.tsx'
    ]
    for (const path of hosts) {
      const text = source(path)
      expect(text, path).toContain('<GroupGlyph ')
      for (const own of [
        'zen-group-dot',
        'zen-group-badge',
        'zen-overview-group-glyph',
        'GroupBadge',
        'GroupDot',
        'GroupRowGlyph',
        // The sheet rows' bare 10 dot (a palette swatch's 20 disc is a swatch, not a glyph).
        'h-2.5 w-2.5 rounded-full bg-[rgb(var(--zen-group-rgb))]'
      ]) {
        expect(text, `${path} draws ${own}`).not.toContain(own)
      }
    }
  })
})

describe('the count as the aside (§9.36)', () => {
  it('is the 13 tabular aside at 69% on the phone’s card header, folded and open alike', () => {
    for (const collapsed of [false, true]) {
      const el = render(
        createElement(GroupCard, {
          folder: folder({ collapsed }),
          tabs: [tab('a'), tab('b'), tab('c')],
          card: (t: Tab) => createElement('div', { key: t.id }, t.title),
          onMenu: () => undefined,
          columns: 2
        })
      )
      const header = el.querySelector<HTMLElement>('.zen-group-header')!
      const count = header.querySelector<HTMLElement>('[data-testid="group-card-count"]')!
      expect(count.textContent).toBe('3')
      expect(count.classList.contains('zen-group-row-count')).toBe(true)
      // The header's mark is the one glyph, and the count sits beside it as text: no badge next to
      // the dot (§9.19), no pill on the tinted header (§7).
      expect(header.querySelector('.zen-group-row-glyph .zen-group-row-dot')).not.toBeNull()
      expect(header.querySelector('.zen-v2-badge, .zen-group-count-badge')).toBeNull()
      act(() => root?.unmount())
      host?.remove()
    }
    const aside = rule('.zen-group-row-count')
    expect(aside).toContain('font-size: 13px')
    expect(aside).toContain('font-variant-numeric: tabular-nums')
    expect(aside).toContain('color: var(--v2-control-text-deemphasized, var(--zen-muted))')
    // The ghost a departing group leaves reads its count the same way.
    expect(source('phone/Departures.tsx')).toContain('className="zen-group-row-count"')
    for (const path of ['phone/GroupCard.tsx', 'phone/Departures.tsx']) {
      expect(source(path), path).not.toContain('text-[12px] tabular-nums')
    }
  })
})

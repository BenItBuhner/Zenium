// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpaceGlyph } from '../../SpaceGlyph'
import { V2_TRAILING_GLYPH } from '../../v2/controls'
import { SpacePanel } from '../SpacePanel'

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/*
 * The sidebar's rows on the window family (shell pass 7(a), design language v2 §5, §6, §9.3,
 * §9.29): the tab row at §5's 32 and radius 8 with the window fills for hover and the active
 * tab, the folder header, the space header and the New Tab row as rows of the same height, the
 * Essentials tile at 44 / radius 8 on the window fill, the supplementary ink deemphasised, and
 * the empty space-glyph dot's ring at §9.3's glyph stroke instead of 2 px (the lead's #226 note).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The text of the first `selector {` rule found in `from`. */
function rule(from: string, selector: string): string {
  const at = from.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return from.slice(at, from.indexOf('}', at))
}

const components = css.slice(css.indexOf('@layer components {'))

describe('the tab row stylesheet (§5, §9.29)', () => {
  const row = rule(components, '.zen-tab')

  it('is §5’s 32 px row at radius 8, one token high, raised for a coarse pointer only', () => {
    expect(css).toContain('--zen-tab-row: 32px')
    expect(row).toContain('height: var(--zen-tab-row)')
    expect(row).toContain('border-radius: 8px')
    expect(row).toContain('font-size: var(--zen-sidebar-font)')
    expect(css).toMatch(/--zen-sidebar-font: 14px/)
    expect(css).toMatch(/:root\[data-pointer='coarse'\] \{\n\s+--zen-tab-row: 42px;/)
    // A coarse pointer scales the hit target, not the vocabulary: no radius of its own.
    expect(css).not.toMatch(/:root\[data-pointer='coarse'\] \.zen-tab \{/)
  })

  it('takes the window fills – hover on -hover, the active tab on --v2-window-fill – with no frame', () => {
    const hover = rule(
      components,
      ".zen-tab:hover,\n  .zen-tab[data-editing]:not([data-active='true'])"
    )
    expect(hover).toContain('background: var(--v2-window-fill-hover)')
    const active = rule(components, ".zen-tab[data-active='true']")
    expect(active).toContain('background: var(--v2-window-fill)')
    expect(active).not.toContain('box-shadow')
    // The v1 fills are gone from the row.
    const block = components.slice(
      components.indexOf('  .zen-tab {'),
      components.indexOf('  .zen-split-row {')
    )
    expect(block).not.toContain('--zen-element-bg')
  })

  it('draws the Essentials tile at 44 / radius 8 on the window fill, the active one told by the hairline', () => {
    const tile = rule(components, '.zen-essential')
    expect(tile).toContain('height: 44px')
    expect(tile).toContain('border-radius: 8px')
    expect(tile).toContain('background: var(--v2-window-fill)')
    expect(tile).not.toContain('box-shadow')
    expect(rule(components, '.zen-essential:hover')).toContain(
      'background: var(--v2-window-fill-hover)'
    )
    const active = rule(components, ".zen-essential[data-active='true']")
    expect(active).toContain('background: var(--v2-window-fill-hover)')
    expect(active).toContain('box-shadow: inset 0 0 0 1px var(--zen-border)')
    expect(active).not.toContain('--v2-border')
  })

  it('turns the throbber in the control roles, the v1 inks standing in off a surface', () => {
    expect(rule(components, '.zen-tab-throbber')).toContain(
      'border-color: var(--v2-control-text-deemphasized, var(--zen-muted))'
    )
    expect(rule(components, ".zen-tab-throbber[data-phase='loading']")).toContain(
      'border-color: var(--v2-control-accent, var(--zen-accent))'
    )
  })
})

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ selectedTabIds: [], drag: null })
})

describe('the empty space-glyph dot (§9.3, the lead on #226)', () => {
  it('is a ring at the glyph stroke in the current ink, the size the 2 px dot had', () => {
    render(<SpaceGlyph icon="" size={15} />)
    const svg = document.querySelector<SVGSVGElement>('svg[data-space-dot]')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('width')).toBe(String(15 * 0.7))
    expect(svg!.getAttribute('height')).toBe(String(15 * 0.7))
    expect(svg!.getAttribute('stroke')).toBe('currentColor')
    expect(svg!.getAttribute('fill')).toBe('none')
    // The stroke is the token – 1.5 on desktop, 1.75 on the phone – never a width of its own.
    expect(svg!.getAttribute('class')).toContain('[stroke-width:var(--v2-icon-stroke)]')
    expect(svg!.getAttribute('class')).not.toMatch(/border/)
    const circle = svg!.querySelector('circle')!
    expect(Number(circle.getAttribute('cx'))).toBeCloseTo(15 * 0.35)
    expect(Number(circle.getAttribute('r'))).toBeCloseTo((15 * 0.7 - 1.75) / 2)
  })

  it('keeps the coloured swatch with its 20 % hairline (§9.14)', () => {
    render(<SpaceGlyph icon="" size={17} dotColor="#f00" />)
    expect(document.querySelector('svg[data-space-dot]')).toBeNull()
    const swatch = document.querySelector<HTMLElement>('span[aria-hidden]')!
    expect(swatch.className).toContain('border-[rgb(var(--zen-fg-rgb)/0.2)]')
    expect(swatch.className).not.toContain('border-2')
    expect(swatch.style.background).toBe('#f00')
  })
})

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
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
    ...over
  } as Tab
}

function panel(tabs: Tab[], folders: Folder[] = []): void {
  const space: Space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  const state = {
    platform: 'linux',
    window: { kind: 'synced' },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    settings: { showTabSeparator: false }
  } as unknown as UIState
  browserStore.set({ state })
  render(<SpacePanel state={state} space={space} isActive compact={false} />)
}

describe('the strip’s headers and rows (§5, §9.29)', () => {
  it('sets the space header at the row height as a 13/600 label in full ink on the window hover fill', () => {
    panel([tab('a', { pinned: true }), tab('b')])
    const header = document.querySelector<HTMLElement>('[data-strip-item="header:space"]')!
    expect(header.className).toContain('h-[var(--zen-tab-row)]')
    expect(header.className).toContain('text-[13px]')
    expect(header.className).toContain('font-semibold')
    expect(header.className).toContain('text-[var(--zen-fg)]')
    expect(header.className).toContain('hover:bg-[var(--v2-window-fill-hover)]')
    expect(header.className).not.toContain('--zen-element-bg')
    // The header's empty space dot is the ring, in the header's ink.
    expect(header.querySelector('svg[data-space-dot]')).not.toBeNull()
  })

  it('makes the folder header a row with its count and chevron deemphasised and its colour a hairlined swatch', () => {
    const folder: Folder = {
      id: 'f1',
      spaceId: 'space',
      name: 'Work',
      icon: '📁',
      color: 'blue',
      collapsed: false
    } as Folder
    panel([tab('a', { folderId: 'f1' }), tab('b', { folderId: 'f1' })], [folder])
    const header = document.querySelector<HTMLElement>('[data-tab-folder="f1"]')!
    expect(header.classList.contains('zen-tab')).toBe(true)
    expect(header.className).not.toMatch(/\bh-8\b/)
    const count = [...header.querySelectorAll('span')].find((s) => s.textContent === '2')!
    expect(count.className).toContain('text-[var(--v2-control-text-deemphasized)]')
    expect(count.className).toContain('tabular-nums')
    expect(count.className).not.toContain('--zen-muted')
    const chevron = header.querySelector('svg.lucide-chevron-down')!
    expect(chevron.getAttribute('class')).toContain('text-[var(--v2-control-text-deemphasized)]')
    expect(chevron.getAttribute('class')).not.toContain('opacity-60')
    const dot = header.querySelector<HTMLElement>('span.h-2.w-2')!
    expect(dot.className).toContain('border-[rgb(var(--zen-fg-rgb)/0.2)]')
  })

  it('gives the New Tab row the row’s height and font in full ink', () => {
    panel([tab('a')])
    const row = document.querySelector<HTMLElement>('[data-new-tab]')!
    expect(row.classList.contains('zen-tab')).toBe(true)
    expect(row.className).not.toMatch(/\bh-8\b/)
    expect(row.className).toContain('text-[var(--zen-fg)]')
    const label = [...row.querySelectorAll('span')].find((s) => s.textContent === 'New Tab')!
    expect(label.className).not.toContain('text-[13px]')
  })
})

/*
 * The rows' trailing glyphs (§9.3: the chevron, a status alert, the row's own buttons) are 16 on
 * both platforms at the platform's stroke (`--v2-icon-stroke`, set as a CSS property so it
 * outranks Lucide's 2); 14 (`h-3.5`) is not a size the language has (#295's review, nit B2).
 */
describe('the rows’ trailing glyphs (§9.3)', () => {
  const trailing = (svg: Element | null): void => {
    expect(svg).not.toBeNull()
    const cls = svg!.getAttribute('class') ?? ''
    expect(cls).toContain(V2_TRAILING_GLYPH)
    expect(cls).not.toMatch(/\bh-3(\.5)?\b/)
  }

  it('the space header’s and the folder’s chevrons', () => {
    const folder: Folder = {
      id: 'f1',
      spaceId: 'space',
      name: 'Work',
      icon: '📁',
      color: null,
      collapsed: true
    } as unknown as Folder
    panel([tab('a', { pinned: true }), tab('b', { folderId: 'f1' })], [folder])
    trailing(document.querySelector('[data-strip-item="header:space"] svg.lucide-chevron-down'))
    trailing(document.querySelector('[data-tab-folder="f1"] svg.lucide-chevron-right'))
  })

  it('a tab’s close, its audio button, a sleeping page’s moon and the alert indicators', () => {
    panel([
      tab('a'),
      tab('b', { audible: true }),
      tab('c', { discarded: true }),
      tab('d', { frozen: true }),
      tab('e', { muted: true })
    ])
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="tab"]')]
    expect(rows).toHaveLength(5)
    for (const row of rows) trailing(row.querySelector('.zen-tab-close svg'))
    trailing(document.querySelector('[data-tab-id="b"] .zen-tab-audio svg'))
    trailing(document.querySelector('[data-tab-id="e"] .zen-tab-audio svg'))
    trailing(document.querySelector('[data-tab-id="c"] .zen-tab-sleeping svg'))
    trailing(document.querySelector('[data-tab-id="d"] svg.lucide-snowflake'))
    // Nothing in the strip's rows is left at 14.
    for (const svg of document.querySelectorAll('[data-testid="tab"] svg, [data-tab-folder] svg')) {
      expect(svg.getAttribute('class') ?? '').not.toMatch(/\bh-3\.5\b/)
    }
  })

  it('the stylesheet sets no tablet size of its own on the close glyph: 16 is every platform’s', () => {
    expect(css).not.toMatch(/\.zen-tab-close > svg/)
  })
})

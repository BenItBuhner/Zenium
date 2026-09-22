// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SplitGroup, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import {
  SPLIT_GAP,
  SPLIT_HEADER,
  SPLIT_OUTLINE,
  placementsFor,
  splitPaneRects
} from '@renderer/lib/layout'

/*
 * The active pane's indicator in the content (design language v2 §9.35; Zen's
 * `--zen-active-split-outline-color`; the lead's #262 verdict sent it to shell pass 7(a)): a
 * 2 px `--zen-accent` outline inside the pane's frame's radius, which with the §9.35 group row
 * in the sidebar is the whole indicator. The page is a native view the chrome cannot paint
 * over, so every pane's view sits `SPLIT_OUTLINE` inside its frame and the outline takes that
 * band on the active pane; the pre-#262 underline under the pane's header is gone.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))

const { SplitChrome } = await import('../SplitChrome')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

function tab(id: string): Tab {
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
    splitGroupId: 'g',
    createdAt: 0
  } as Tab
}

const group: SplitGroup = {
  id: 'g',
  spaceId: 'space',
  tabIds: ['a', 'b'],
  layout: 'vertical',
  sizes: [0.5, 0.5]
}
const area = { x: 0, y: 0, width: 1006, height: 600 }
const state = {
  tabs: { a: tab('a'), b: tab('b') },
  splitGroups: { g: group }
} as unknown as UIState

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (activeTabId: string | null): void => {
  act(() =>
    root.render(<SplitChrome state={state} group={group} area={area} activeTabId={activeTabId} />)
  )
}
const outlines = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.zen-split-pane-outline')
]

describe('the active pane’s outline (§9.35)', () => {
  it('every pane’s view keeps the outline’s band inside its frame, its corners concentric with the frame’s', () => {
    const [a, b] = splitPaneRects(area, group)
    expect(a.frame).toEqual({ x: 0, y: SPLIT_HEADER, width: 500, height: 600 - SPLIT_HEADER })
    expect(a.rect).toEqual({
      x: SPLIT_OUTLINE,
      y: SPLIT_HEADER + SPLIT_OUTLINE,
      width: 500 - 2 * SPLIT_OUTLINE,
      height: 600 - SPLIT_HEADER - 2 * SPLIT_OUTLINE
    })
    expect(b.frame.x).toBe(500 + SPLIT_GAP)
    expect(b.rect.x).toBe(500 + SPLIT_GAP + SPLIT_OUTLINE)
    // The view the main process places: the inset box at the frame's radius less the band.
    const placed = placementsFor(area, ['a', 'b'], group, 12)
    expect(placed.map((p) => p.rect)).toEqual([a.rect, b.rect])
    expect(placed.every((p) => p.radius === 12 - SPLIT_OUTLINE)).toBe(true)
    // A lone page keeps the whole area at the frame's own radius.
    expect(placementsFor(area, ['a'], null, 12)).toEqual([{ tabId: 'a', rect: area, radius: 12 }])
  })

  it('draws one outline, on the active pane’s frame, and none under the header', () => {
    render('b')
    const [a, b] = splitPaneRects(area, group)
    expect(outlines()).toHaveLength(1)
    const outline = outlines()[0]
    expect(outline.getAttribute('data-split-pane-outline')).toBe('b')
    expect(outline.getAttribute('aria-hidden')).toBe('true')
    expect(outline.style.left).toBe(`${b.frame.x}px`)
    expect(outline.style.top).toBe(`${b.frame.y}px`)
    expect(outline.style.width).toBe(`${b.frame.width}px`)
    expect(outline.style.height).toBe(`${b.frame.height}px`)
    expect(outline.style.left).not.toBe(`${a.frame.x}px`)
    // The pre-#262 underline is gone from both headers: nothing 2 px tall filled in the accent
    // (the gutter's hover tint is the gutter's, not a header's).
    expect(container.querySelector('.h-0\\.5')).toBeNull()
    const headers = [...container.querySelectorAll<HTMLElement>('[title^="Un-split"]')].map(
      (button) => button.parentElement!
    )
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      expect(header.innerHTML).not.toMatch(/bg-\[var\(--zen-accent\)\]/)
      expect(header.querySelector('.absolute.inset-x-0.bottom-0')).toBeNull()
    }
    // The headers stay: each with its pane's title and the un-split control.
    expect(headers.map((h) => h.textContent)).toEqual(['AA', 'BB'])
  })

  it('moves with the active pane and leaves with the active tab', () => {
    render('a')
    expect(outlines()[0].getAttribute('data-split-pane-outline')).toBe('a')
    render('b')
    expect(outlines()).toHaveLength(1)
    expect(outlines()[0].getAttribute('data-split-pane-outline')).toBe('b')
    render(null)
    expect(outlines()).toHaveLength(0)
  })

  it('is 2 px of --zen-accent inside the frame’s radius in the stylesheet, catching no pointer', () => {
    const outline = rule('.zen-split-pane-outline')
    expect(outline).toContain('position: absolute')
    expect(outline).toContain('pointer-events: none')
    expect(outline).toContain('border-radius: var(--zen-content-radius)')
    expect(outline).toContain('outline: 2px solid var(--zen-accent)')
    expect(outline).toContain('outline-offset: -2px')
    expect(outline).not.toContain('--v2-accent')
    expect(SPLIT_OUTLINE).toBe(2)
  })
})

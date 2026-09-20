// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { cmd, run } from '../api'
import {
  pinnedCount,
  resetThumbnails,
  thumbnailStats,
  trackTabs,
  useThumbnail
} from '../thumbnails'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * A card's hook (lib/thumbnails.ts `useThumbnail`): a card holds and reads its tab's picture
 * while it is on screen – the overview grid's word per card – and not before; off screen it lets
 * go, so the grid's pictures are bounded by the cards in view, not the cards in the space.
 */

function Probe({ tabId, visible }: { tabId: string; visible: boolean }): JSX.Element {
  const picture = useThumbnail(tabId, { visible })
  return createElement('i', { 'data-picture': picture ?? '' })
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  resetThumbnails()
  vi.mocked(run).mockReset()
  vi.mocked(cmd).mockReset()
  vi.mocked(cmd).mockResolvedValue(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  trackTabs({
    platform: 'android',
    tabs: { a: { id: 'a', url: 'u', containerId: 'default' } }
  } as unknown as UIState)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const loads = (): number => vi.mocked(cmd).mock.calls.filter(([n]) => n === 'thumbnail.load').length

describe('a card', () => {
  it('holds and reads its picture while on screen, never while off it', () => {
    act(() => root.render(createElement(Probe, { tabId: 'a', visible: false })))
    expect(pinnedCount()).toBe(0)
    expect(loads()).toBe(0)
    act(() => root.render(createElement(Probe, { tabId: 'a', visible: true })))
    expect(pinnedCount()).toBe(1)
    expect(loads()).toBe(1)
    // Scrolled away: the picture may go, and the read is not asked for again on its own.
    act(() => root.render(createElement(Probe, { tabId: 'a', visible: false })))
    expect(pinnedCount()).toBe(0)
    expect(loads()).toBe(1)
    // Back in view: held again (the read is deduplicated while the last is still in flight).
    act(() => root.render(createElement(Probe, { tabId: 'a', visible: true })))
    expect(pinnedCount()).toBe(1)
    expect(thumbnailStats().loading).toBe(1)
    act(() => root.unmount())
    root = createRoot(container)
    expect(pinnedCount()).toBe(0)
  })
})

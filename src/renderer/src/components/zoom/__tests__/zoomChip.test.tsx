// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_PAGE_CONTROLS, DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'

/*
 * The pill's zoom chip on the host with the page-controls sheet (Android): §9.29's tier gives
 * the pill a zoom chip for a per-page deviation the user cannot otherwise see, and §9.36's
 * tablet pill takes that tier – under Ctrl+wheel in a Samsung DeX window the chip is the whole
 * of the feedback, since the chrome lies under the page and a bubble over it would cost the
 * page's cover (the design gate for #494). The chip stands while the zoom deviates; its press
 * opens §9.13's zoom sheet (`ui.zoomTabId`) where the desktop's opens the bubble, and a second
 * press puts the sheet away with the keyboard kept on the chip.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { uiStore } = await import('@renderer/lib/ui')
const { ZoomChip } = await import('../ZoomChip')

const TAB = {
  id: 'a',
  url: 'https://a.example/',
  title: 'a',
  zoom: 1.25
} as Tab

function stateOf(pageControlsHost: boolean, tab: Tab = TAB): UIState {
  return {
    platform: pageControlsHost ? 'android' : 'linux',
    capabilities: { pageControls: pageControlsHost },
    tabs: { [tab.id]: tab },
    settings: { pageControls: DEFAULT_PAGE_CONTROLS },
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(state: UIState, tab: Tab = TAB, collapsed = false): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(ZoomChip, { state, tab, collapsed }))
  })
}

const chip = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-zoom-chip]')

beforeEach(() => {
  uiStore.set({ zoomTabId: null, zoomBubble: null })
  vi.mocked(run).mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

describe('the zoom chip on the page-controls host (Android, the tablet pill under Ctrl+wheel)', () => {
  it('stands in the pill while the page is away from its default zoom, and not at the default', () => {
    mount(stateOf(true))
    expect(chip()).not.toBeNull()
    expect(chip()!.getAttribute('aria-label')).toBe('Zoom: 125%')
    expect(chip()!.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip()!.getAttribute('aria-expanded')).toBe('false')
    act(() => root?.unmount())
    root = null

    const at100 = { ...TAB, zoom: 1 } as Tab
    mount(stateOf(true, at100), at100)
    expect(chip()).toBeNull()
  })

  it('opens the zoom sheet on its press – never the desktop bubble – and puts it away on the next, keeping the keyboard', () => {
    mount(stateOf(true))
    act(() => chip()!.click())
    expect(uiStore.get().zoomTabId).toBe(TAB.id)
    expect(uiStore.get().zoomBubble).toBeNull()
    expect(chip()!.getAttribute('aria-expanded')).toBe('true')

    act(() => chip()!.click())
    expect(uiStore.get().zoomTabId).toBeNull()
    expect(chip()!.getAttribute('aria-expanded')).toBe('false')
    // The chip that closed the sheet keeps the keyboard: focus is not handed to the page.
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('stays put while its sheet is up even where the pill cannot hold it, and hides otherwise', () => {
    mount(stateOf(true), TAB, true)
    expect(chip()).toBeNull()
    act(() => root?.unmount())
    root = null

    uiStore.set({ zoomTabId: TAB.id })
    mount(stateOf(true), TAB, true)
    expect(chip()).not.toBeNull()
    expect(chip()!.getAttribute('aria-expanded')).toBe('true')
  })

  it('on the desktop the press is the bubble’s, as before', () => {
    mount(stateOf(false))
    expect(chip()).not.toBeNull()
    act(() => chip()!.click())
    expect(uiStore.get().zoomTabId).toBeNull()
  })
})

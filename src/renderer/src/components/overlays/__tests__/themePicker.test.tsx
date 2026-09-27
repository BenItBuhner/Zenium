// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { THEME_PRESETS } from '@shared/theme'

/*
 * The theme picker as the Settings theme row opens it (W8-3, settings-30; #572's round B):
 * its header is the one word "Theme" over the space it edits as §9.23's description ("Personal
 * space" – the row's aside "Ocean · Personal space" names the space the same way; N5), the
 * "Default" chip and "Reset to default" as the Settings row's own button (§9.1: one reset,
 * `lib/theme.ts`), a reset dropping an edit still in the debounce instead of applying it over
 * the reset (Android's re-nod note at `9f02f12ba`); and, given the button that opened it, the
 * panel hung from it – end-aligned under the button in the chrome layer, §9.20 (L8) – rather
 * than at the sidebar's seat.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ThemePicker } = await import('../ThemePicker')
const { uiStore } = await import('@renderer/lib/ui')
type Anchor = import('@renderer/lib/anchor').Anchor

function state(theme: UIState['spaces'][number]['theme'] = null): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: {},
    spaces: [
      { id: 'space', name: 'Personal', icon: '', activeTabId: null, tabIds: [], theme },
      { id: 'work', name: 'Work', icon: '', activeTabId: null, tabIds: [], theme: null }
    ],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: {},
    settings: { ...DEFAULT_SETTINGS },
    shortcuts: [],
    systemDark: false,
    window: { kind: 'synced', chrome: 'full', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLElement | null = null

function mount(s: UIState, spaceId = 'space', anchor?: Omit<Anchor, 'element'>): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(ThemePicker, { state: s, spaceId, anchor })))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  invoke.mockClear()
  uiStore.set({ overlay: 'none', overlayAnchor: null })
})

const q = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector)
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
const updates = (): unknown[] =>
  invoke.mock.calls.filter(([name]) => name === 'space.update').map(([, args]) => args)

describe('the theme picker’s header and reset (settings-30; #572 N5, Android’s note)', () => {
  it('titles itself "Theme" with the space as its description – "Personal space" – the "Default" chip and "Reset to default" under it', () => {
    mount(state())
    const header = q<HTMLElement>('.zen-overlay-header')!
    expect(header.querySelector('.zen-overlay-title')?.textContent).toBe('Theme')
    expect(header.querySelector('.zen-overlay-description')?.textContent).toBe('Personal space')
    expect(header.querySelector('.zen-overlay-title-block')).not.toBeNull()
    expect(button('Default')).toBeDefined()
    expect(button('Reset to default')).toBeDefined()
    expect(button('Reset theme')).toBeUndefined()
  })

  it('names the space it was opened for, not the active one', () => {
    mount(state(), 'work')
    expect(q('.zen-overlay-description')?.textContent).toBe('Work space')
  })

  it('a preset writes the space’s theme after the picker’s 40 ms debounce; Reset to default cancels an edit still in it and puts the theme to null at once – one space.update, the reset', async () => {
    vi.useFakeTimers()
    try {
      mount(state(structuredClone(THEME_PRESETS[1].theme)))
      const ocean = q<HTMLButtonElement>(`button[title="${THEME_PRESETS[0].name}"]`)!
      act(() => ocean.click())
      expect(updates()).toEqual([])
      act(() => button('Reset to default')!.click())
      expect(updates()).toEqual([{ spaceId: 'space', patch: { theme: null } }])
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      expect(updates()).toEqual([{ spaceId: 'space', patch: { theme: null } }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the picker hung from the Settings row’s Change… button (§9.20; #572’s L8)', () => {
  const viewport = { width: 1600, height: 1000 }
  /** The button at the trailing end of the page's column: the picker end-aligns under it. */
  const button: Omit<Anchor, 'element'> = {
    x: 1000,
    y: 240,
    width: 88,
    height: 32,
    column: { x: 400, y: 0, width: 1200, height: 1000 }
  }
  const sized = (): void => {
    Object.assign(window, { innerWidth: viewport.width, innerHeight: viewport.height })
  }

  it('renders the panel in the chrome layer, fixed, its right edge on the button’s and its top on the button’s bottom edge – one placement, at its own 420 – and leaves the seat’s classes behind', () => {
    sized()
    mount(state(), 'space', button)
    const panel = document.querySelector<HTMLElement>('#zen-chrome-layer [data-anchored]')
    expect(panel).not.toBeNull()
    expect(host!.querySelector('[data-anchored]')).toBeNull()
    expect(panel!.classList.contains('fixed')).toBe(true)
    expect(panel!.classList.contains('zen-animate-pop')).toBe(true)
    expect(panel!.className).not.toMatch(/w-\[420px\]|ml-3|mt-auto/)
    // End-aligned: left = the button's right edge − 420; flush under the button's box.
    expect(panel!.style.left).toBe(`${1000 + 88 - 420}px`)
    expect(panel!.style.top).toBe(`${240 + 32}px`)
    expect(panel!.style.width).toBe('420px')
    expect(panel!.style.visibility).not.toBe('hidden')
    // The pop grows out of the button's centre on the panel's top edge (§7).
    expect(panel!.style.transformOrigin).toMatch(/^376px 0(px)?$/)
    // The header is the same block the seated picker draws.
    expect(panel!.querySelector('.zen-overlay-title')?.textContent).toBe('Theme')
    expect(panel!.querySelector('.zen-overlay-description')?.textContent).toBe('Personal space')
  })

  it('start-aligns under a button in the leading half of its column, and closes on a resize as every popover does', () => {
    sized()
    uiStore.set({ overlay: 'theme' })
    mount(state(), 'space', { ...button, x: 500 })
    const panel = document.querySelector<HTMLElement>('#zen-chrome-layer [data-anchored]')!
    expect(panel.style.left).toBe('500px')
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(uiStore.get().overlay).toBe('none')
  })

  it('without an anchor the panel sits at its seat inside the content area, dropping in', () => {
    mount(state())
    expect(document.querySelector('#zen-chrome-layer [data-anchored]')).toBeNull()
    const panel = host!.querySelector<HTMLElement>('.zen-panel')!
    expect(panel.classList.contains('zen-animate-in')).toBe(true)
    expect(panel.className).toMatch(/w-\[420px\]/)
  })

  // The Colour-algorithm popup is a Radix Select portaled to `body`: ArrowDown on the combobox
  // opens it, and its listbox is the popup's box.
  const openAlgorithmPopup = (): HTMLElement => {
    const trigger = document.querySelector<HTMLElement>('[role="combobox"]')!
    act(() => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    return document.querySelector<HTMLElement>('[role="listbox"]')!
  }

  it('hung from the row, the Colour-algorithm popup lifts to z 110 – past the chrome layer (100) the panel stands in, or it would open under its own picker', () => {
    sized()
    mount(state(), 'space', button)
    const listbox = openAlgorithmPopup()
    expect(listbox.classList.contains('z-[110]')).toBe(true)
    expect(listbox.classList.contains('z-50')).toBe(false)
  })

  it('seated – the space menu’s and the palette’s picker, and the phone’s, which never anchors – the popup keeps the menulist’s z 50, under the phone’s sheets (z 90) as it always was (Android’s re-nod on #572)', () => {
    mount(state())
    const listbox = openAlgorithmPopup()
    expect(listbox.classList.contains('z-50')).toBe(true)
    expect(listbox.classList.contains('z-[110]')).toBe(false)
  })
})

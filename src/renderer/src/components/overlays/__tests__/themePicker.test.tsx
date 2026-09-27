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
 * the reset (Android's re-nod note at `9f02f12ba`).
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ThemePicker } = await import('../ThemePicker')

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

function mount(s: UIState, spaceId = 'space'): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(ThemePicker, { state: s, spaceId })))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  invoke.mockClear()
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

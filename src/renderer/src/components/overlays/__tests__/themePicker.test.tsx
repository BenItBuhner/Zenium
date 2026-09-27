// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { THEME_PRESETS } from '@shared/theme'

/*
 * The theme picker as the Settings theme row opens it (W8-3, settings-30; #572's round B):
 * its header is the one word "Theme" over the space it edits as §9.23's description ("Personal
 * Space" – the row's aside "Ocean · Personal Space" names the space the same way; N5), the
 * "Default" chip and "Reset to default" as the Settings row's own button (§9.1: one reset,
 * `lib/theme.ts`), a reset dropping an edit still in the debounce instead of applying it over
 * the reset (Android's re-nod note at `9f02f12ba`); and, given the button that opened it, the
 * panel hung from it – end-aligned under the button in the chrome layer, §9.20 (L8) – rather
 * than at the sidebar's seat.
 *
 * Round C (the lead's ruling on the first line's notes 16–19): hanging there the picker IS a
 * §9.20 popover and takes the popover's chrome – the chassis's `.zen-v2-panel` (radius 8 at
 * §2's squircle, the opaque `--v2-panel` fill, `--v2-shadow-panel`), no X, 400 wide
 * (`POPOVER_WIDTH.form`) – as a variant of the shell's anchored panel, and holds the focus as
 * a popover does (§9.22): the container on open, the button it hung from on close. The
 * sidebar's seat keeps `.zen-panel` with its bar header and X exactly as today, 420 wide,
 * moving no focus. §9.20 as amended by the lead: the chrome is the seat's, never the content's.
 */

const mainCss = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const extensionsCss = readFileSync(resolve(__dirname, '../../../assets/extensions.css'), 'utf8')

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

/** Closes the picker as `closeOverlay` does – the component leaves the tree. */
function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}

afterEach(() => {
  unmount()
  invoke.mockClear()
  uiStore.set({ overlay: 'none', overlayAnchor: null })
})

const q = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector)
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
const updates = (): unknown[] =>
  invoke.mock.calls.filter(([name]) => name === 'space.update').map(([, args]) => args)

describe('the theme picker’s header and reset (settings-30; #572 N5, Android’s note)', () => {
  it('titles itself "Theme" with the space as its description – "Personal Space" – the "Default" chip and "Reset to default" under it', () => {
    mount(state())
    const header = q<HTMLElement>('.zen-overlay-header')!
    expect(header.querySelector('.zen-overlay-title')?.textContent).toBe('Theme')
    expect(header.querySelector('.zen-overlay-description')?.textContent).toBe('Personal Space')
    expect(header.querySelector('.zen-overlay-title-block')).not.toBeNull()
    expect(button('Default')).toBeDefined()
    expect(button('Reset to default')).toBeDefined()
    expect(button('Reset theme')).toBeUndefined()
  })

  it('names the space it was opened for, not the active one', () => {
    mount(state(), 'work')
    expect(q('.zen-overlay-description')?.textContent).toBe('Work Space')
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

  it('renders the panel in the chrome layer, fixed, its right edge on the button’s and its top on the button’s bottom edge – one placement, at the popover’s 400 (Δ 0 / Δ 0) – and leaves the seat’s classes behind', () => {
    sized()
    mount(state(), 'space', button)
    const panel = document.querySelector<HTMLElement>('#zen-chrome-layer [data-anchored]')
    expect(panel).not.toBeNull()
    expect(host!.querySelector('[data-anchored]')).toBeNull()
    expect(panel!.classList.contains('fixed')).toBe(true)
    expect(panel!.classList.contains('zen-animate-pop')).toBe(true)
    expect(panel!.className).not.toMatch(/w-\[420px\]|ml-3|mt-auto/)
    // End-aligned: left = the button's right edge − 400, so the panel's right edge is the
    // button's (Δ 0); flush under the button's box (Δ 0).
    expect(panel!.style.left).toBe(`${1000 + 88 - 400}px`)
    expect(panel!.style.top).toBe(`${240 + 32}px`)
    expect(panel!.style.width).toBe('400px')
    expect(panel!.style.visibility).not.toBe('hidden')
    // The pop grows out of the button's centre on the panel's top edge (§7): 1044 − 688.
    expect(panel!.style.transformOrigin).toMatch(/^356px 0(px)?$/)
    // The header is the same block the seated picker draws.
    expect(panel!.querySelector('.zen-overlay-title')?.textContent).toBe('Theme')
    expect(panel!.querySelector('.zen-overlay-description')?.textContent).toBe('Personal Space')
  })

  it('hung from the row the panel is a §9.20 popover: the chassis’s .zen-v2-panel chrome – radius 8 at the squircle, the opaque --v2-panel, --v2-shadow-panel – in place of the seat’s .zen-panel, and no X (round C, notes 16–18)', () => {
    sized()
    mount(state(), 'space', button)
    const panel = document.querySelector<HTMLElement>('#zen-chrome-layer [data-anchored]')!
    expect(panel.classList.contains('zen-v2-panel')).toBe(true)
    expect(panel.classList.contains('zen-panel')).toBe(false)
    // The header keeps §9.23's title block – the same 78 with a description, the 28 close
    // being the 3 + 22 + 3 the block stands in – and carries no close: a popover has none.
    const header = panel.querySelector<HTMLElement>('.zen-overlay-header')!
    expect(header.querySelector('.zen-overlay-title-block')).not.toBeNull()
    expect(header.querySelector('[aria-label="Close"]')).toBeNull()
    expect(panel.querySelector('[title="Close (Esc)"]')).toBeNull()
    // The popover is a dialog named by its title, held at tabindex -1 (main.css's container
    // rule draws no ring on it), as the anchor's aria-haspopup="dialog" says.
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('tabindex')).toBe('-1')
    const title = panel.querySelector<HTMLElement>('.zen-overlay-title')!
    expect(title.id).not.toBe('')
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id)
    // The chrome is the chassis's popover rule, pinned by its declarations and tokens: the card
    // radius 8, the opaque panel fill (light #f4f4f4, dark #1f1f1f), the 0 2px 6px .2 shadow.
    const rule = extensionsCss.match(/\.zen-v2-panel \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/background: var\(--v2-panel\);/)
    expect(rule).toMatch(/border: 1px solid var\(--v2-border\);/)
    expect(rule).toMatch(/border-radius: var\(--v2-radius-card\);/)
    expect(rule).toMatch(/corner-shape: var\(--zen-corner\);/)
    expect(rule).toMatch(/box-shadow: var\(--v2-shadow-panel\);/)
    expect(mainCss).toMatch(/--v2-radius-card: 8px;/)
    expect(mainCss).toMatch(/--v2-shadow-panel: 0 2px 6px rgb\(0 0 0 \/ 0\.2\);/)
    expect(mainCss).toMatch(/--v2-panel: #f4f4f4;/)
    expect(mainCss).toMatch(/--v2-panel: #1f1f1f;/)
  })

  it('takes the focus as a popover does (§9.22): the container on open – once placed, never in the hidden measuring pass – no control preselected – and the button it hung from on close; today’s seated picker moves none, and a focus placed elsewhere on the way out is left alone', () => {
    sized()
    const opener = document.createElement('button')
    opener.textContent = 'Change…'
    document.body.appendChild(opener)
    // Chromium refuses the focus to a `visibility: hidden` element and leaves it where it was;
    // happy-dom does not. The panel's measuring pass is hidden (`measuringStyle`), so the focus
    // must come with the placement – the drive on the packaged build read the container
    // unfocused when it came in the measuring pass. The visibility at each call is recorded.
    const nativeFocus = HTMLElement.prototype.focus
    const panelFocusCalls: string[] = []
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this.hasAttribute('data-anchored')) panelFocusCalls.push(this.style.visibility)
      if (this.style.visibility === 'hidden') return
      nativeFocus.call(this, options)
    })
    try {
      opener.focus()
      expect(document.activeElement).toBe(opener)
      mount(state(), 'space', button)
      const panel = document.querySelector<HTMLElement>('#zen-chrome-layer [data-anchored]')!
      expect(panelFocusCalls).toEqual([''])
      expect(document.activeElement).toBe(panel)
      expect(panel.contains(document.activeElement)).toBe(true)
      expect([...panel.querySelectorAll('button')]).not.toContain(document.activeElement)
      // Escape's closeOverlay unmounts the picker (useGlobalKeys): the opener gets the focus back.
      unmount()
      expect(document.activeElement).toBe(opener)
      // A focus another surface placed while the popover was leaving is not taken from it.
      const elsewhere = document.createElement('input')
      document.body.appendChild(elsewhere)
      opener.focus()
      mount(state(), 'space', button)
      expect(document.activeElement).not.toBe(opener)
      elsewhere.focus()
      unmount()
      expect(document.activeElement).toBe(elsewhere)
      elsewhere.remove()
      // At the seat the picker moves no focus – the space menu's and the palette's picker, and
      // the phone's, as they always did.
      opener.focus()
      mount(state())
      expect(document.activeElement).toBe(opener)
      expect(host!.querySelector('.zen-panel')?.getAttribute('tabindex')).toBeNull()
      expect(host!.querySelector('.zen-panel')?.getAttribute('role')).toBeNull()
    } finally {
      focus.mockRestore()
      opener.remove()
    }
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

  it('without an anchor the panel sits at its seat inside the content area, dropping in – the sidebar seat’s chrome exactly as today: .zen-panel with its bar header and X, 420 wide, never .zen-v2-panel (round C)', () => {
    mount(state())
    expect(document.querySelector('#zen-chrome-layer [data-anchored]')).toBeNull()
    const panel = host!.querySelector<HTMLElement>('.zen-panel')!
    expect(panel.classList.contains('zen-animate-in')).toBe(true)
    expect(panel.classList.contains('zen-v2-panel')).toBe(false)
    expect(panel.classList.contains('fixed')).toBe(false)
    expect(panel.className).toMatch(/w-\[420px\]/)
    expect(panel.className).toMatch(/mb-3 ml-3 mr-auto mt-auto/)
    expect(panel.hasAttribute('data-anchored')).toBe(false)
    // The bar header with its title block and the 28 close, named for the reader and hinting
    // the key on a mouse (§9.31).
    const header = panel.querySelector<HTMLElement>('.zen-overlay-header')!
    expect(header.getAttribute('data-size')).toBe('panel')
    expect(header.querySelector('.zen-overlay-title-block')).not.toBeNull()
    const close = header.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    expect(close).not.toBeNull()
    expect(close.classList.contains('zen-v2-icon-button')).toBe(true)
    expect(close.title).toBe('Close (Esc)')
    expect(header.lastElementChild).toBe(close)
    // The X closes the overlay, as it always did.
    uiStore.set({ overlay: 'theme' })
    act(() => close.click())
    expect(uiStore.get().overlay).toBe('none')
    // The seat's chrome is the sidebar card's, not the popover's: the 16 radius, the
    // translucent blurred fill, the panel shadow (main.css `.zen-panel`).
    const rule = mainCss.match(/\n {2}\.zen-panel \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/background: var\(--zen-panel-bg\);/)
    expect(rule).toMatch(/backdrop-filter: var\(--zen-blur-panel\);/)
    expect(rule).toMatch(/border-radius: 16px;/)
    expect(rule).toMatch(/box-shadow: var\(--zen-shadow\);/)
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

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The chrome tooltip's host (components/Tooltip.tsx; v2 draft §9.31, a11y-26), driven from
 * the document: any control carrying `data-tooltip` gets the one `role=tooltip` in the chrome
 * layer after the pointer's dwell or at once on keyboard focus, is `aria-describedby` it while
 * it shows, and loses it on the pointer leaving, focus leaving, a press, Escape – which travels
 * on to the control's own meaning, never consumed – the text going, or the control leaving the
 * DOM. The text follows the control's attribute while it is up (Reload becoming Stop).
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Tooltip } = await import('../Tooltip')
const { TOOLTIP_ATTR, TOOLTIP_DELAY, TOOLTIP_ID, tooltip } = await import('@renderer/lib/tooltip')
const { KEYBOARD_FOCUS_ATTR } = await import('@renderer/lib/panes')
const { chromeLayer } = await import('@renderer/lib/portals')

let root: Root | null = null
let host: HTMLDivElement

function render(el: ReactElement): void {
  root = createRoot(host)
  act(() => root!.render(el))
}

function control(text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.setAttribute(TOOLTIP_ATTR, text)
  button.setAttribute('aria-label', text)
  button.innerHTML = '<svg></svg>'
  return button
}

const pointer = (
  type: 'pointerover' | 'pointerout' | 'pointerdown',
  target: Element,
  relatedTarget: Element | null = null,
  pointerType = 'mouse'
): void => {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, composed: true, pointerType, relatedTarget })
    )
  })
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const shown = (): HTMLElement | null => document.getElementById(TOOLTIP_ID)

describe('Tooltip host', () => {
  let aside: HTMLElement
  let back: HTMLButtonElement
  let reload: HTMLButtonElement

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    aside = document.createElement('aside')
    back = control('Back (Alt+←)')
    reload = control('Reload (Ctrl+R)')
    aside.append(back, reload)
    document.body.appendChild(aside)
    render(createElement(Tooltip))
  })
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    tooltip.hide()
    chromeLayer().innerHTML = ''
    vi.useRealTimers()
  })

  it('shows the control’s text as the one role=tooltip after the dwell, and describes the control by it', () => {
    pointer('pointerover', back.querySelector('svg')!, aside)
    tick(TOOLTIP_DELAY - 1)
    expect(shown()).toBeNull()
    expect(back.hasAttribute('aria-describedby')).toBe(false)
    tick(1)
    const tip = shown()!
    expect(tip.getAttribute('role')).toBe('tooltip')
    expect(tip.textContent).toBe('Back (Alt+←)')
    expect(tip.closest('.zen-chrome-layer')).not.toBeNull()
    expect(back.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  })

  it('moves to the next control at once and takes the description with it', () => {
    pointer('pointerover', back, aside)
    tick(TOOLTIP_DELAY)
    pointer('pointerout', back, reload)
    pointer('pointerover', reload, back)
    expect(shown()!.textContent).toBe('Reload (Ctrl+R)')
    expect(back.hasAttribute('aria-describedby')).toBe(false)
    expect(reload.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  })

  it('goes with the pointer leaving, and puts the control’s own describedby back', () => {
    back.setAttribute('aria-describedby', 'other')
    pointer('pointerover', back, aside)
    tick(TOOLTIP_DELAY)
    expect(back.getAttribute('aria-describedby')).toBe(`other ${TOOLTIP_ID}`)
    pointer('pointerout', back, aside)
    pointer('pointerover', aside, back)
    expect(shown()).toBeNull()
    expect(back.getAttribute('aria-describedby')).toBe('other')
  })

  it('a touch or pen pointer shows nothing (§9.31: mouse and keyboard only)', () => {
    pointer('pointerover', back, aside, 'touch')
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
    pointer('pointerover', back, aside, 'pen')
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
  })

  it('keyboard focus shows at once; focus moving on moves it; blur takes it down', () => {
    act(() => back.focus())
    expect(shown()!.textContent).toBe('Back (Alt+←)')
    expect(shown()!.getAttribute('data-by')).toBe('focus')
    act(() => reload.focus())
    expect(shown()!.textContent).toBe('Reload (Ctrl+R)')
    expect(back.hasAttribute('aria-describedby')).toBe(false)
    act(() => reload.blur())
    expect(shown()).toBeNull()
    expect(reload.hasAttribute('aria-describedby')).toBe(false)
  })

  it('a control that is a box around its focusable part shows on the part’s keyboard focus (the URL pill)', () => {
    // The pill group carries the address as its tooltip; the button inside it takes the Tab
    // stop. `:focus-visible` is the focused button's, never the group's – the a11y-2 drive
    // (2026-09-23) found the pill silent on every keyboard focus for testing it on the group.
    const group = document.createElement('div')
    group.setAttribute(TOOLTIP_ATTR, 'example.com – Site information')
    const button = document.createElement('button')
    button.textContent = 'example.com'
    group.appendChild(button)
    aside.appendChild(group)
    const focusVisible = (el: Element, is: boolean): void => {
      const matches = el.matches.bind(el)
      el.matches = (selector: string): boolean =>
        selector === ':focus-visible' ? is : matches(selector)
    }
    focusVisible(group, false)
    focusVisible(button, true)
    act(() => button.focus())
    expect(shown()!.textContent).toBe('example.com – Site information')
    expect(shown()!.getAttribute('data-by')).toBe('focus')
    expect(group.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(button.hasAttribute('aria-describedby')).toBe(false)
    // A pointer's press focuses the button without `:focus-visible`: nothing for the keyboard.
    act(() => button.blur())
    focusVisible(button, false)
    act(() => button.focus())
    expect(shown()).toBeNull()
  })

  it('a pane shortcut’s landing shows at once although `:focus-visible` does not match (the mark, lib/panes.ts)', () => {
    // Shift+Alt+T after the app menu's mouse clicks: the chord is consumed before the document
    // sees a key, so the landing on Reload has no `:focus-visible`; the pane move marks it.
    const matches = reload.matches.bind(reload)
    reload.matches = (selector: string): boolean =>
      selector === ':focus-visible' ? false : matches(selector)
    act(() => reload.focus())
    expect(shown()).toBeNull()
    act(() => reload.blur())
    reload.setAttribute(KEYBOARD_FOCUS_ATTR, '')
    act(() => reload.focus())
    expect(shown()!.textContent).toBe('Reload (Ctrl+R)')
    expect(shown()!.getAttribute('data-by')).toBe('focus')
  })

  it('Escape takes it down and travels on untouched: the control’s own Escape (Stop, Close) is one press', () => {
    // The design review of #400 (A1): a swallowed Escape cost a keyboard user two presses on
    // Stop, and on the find bar's Next and Close – `useGlobalKeys`' "Escape is Stop" never ran
    // under a tooltip. The key must reach the listeners below as if no tooltip had been up.
    const seen: string[] = []
    const onKey = (e: KeyboardEvent): void => {
      seen.push(e.defaultPrevented ? 'prevented' : 'free')
    }
    window.addEventListener('keydown', onKey)
    try {
      act(() => back.focus())
      expect(shown()).not.toBeNull()
      act(() => {
        back.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(shown()).toBeNull()
      // Not consumed: the listener below saw the key, free of `preventDefault`, in the one
      // press. The control keeps the keyboard.
      expect(seen).toEqual(['free'])
      expect(document.activeElement).toBe(back)
      // With nothing up the key is as free – the tooltip has no say either way.
      act(() => {
        back.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(seen).toEqual(['free', 'free'])
    } finally {
      window.removeEventListener('keydown', onKey)
    }
  })

  it('Escape on a pointer’s tooltip takes it down, free, and the control stays silent until the pointer leaves', () => {
    const seen: string[] = []
    const onKey = (e: KeyboardEvent): void => {
      seen.push(e.defaultPrevented ? 'prevented' : 'free')
    }
    window.addEventListener('keydown', onKey)
    try {
      pointer('pointerover', back, aside)
      tick(TOOLTIP_DELAY)
      expect(shown()).not.toBeNull()
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(shown()).toBeNull()
      expect(seen).toEqual(['free'])
      // The pointer's dwell is silenced for the still pointer (a press's rule), not the key.
      pointer('pointerover', back, back.querySelector('svg'))
      tick(TOOLTIP_DELAY * 2)
      expect(shown()).toBeNull()
      pointer('pointerout', back, aside)
      pointer('pointerover', back, aside)
      tick(TOOLTIP_DELAY)
      expect(shown()).not.toBeNull()
    } finally {
      window.removeEventListener('keydown', onKey)
    }
  })

  it('a press takes it down and the control stays silent until the pointer leaves', () => {
    pointer('pointerover', back, aside)
    tick(TOOLTIP_DELAY)
    pointer('pointerdown', back)
    expect(shown()).toBeNull()
    pointer('pointerover', back, back.querySelector('svg'))
    tick(TOOLTIP_DELAY * 2)
    expect(shown()).toBeNull()
  })

  // The observers deliver as microtasks; an awaited act flushes them.
  const settle = (): Promise<void> =>
    act(async () => {
      await Promise.resolve()
    })

  it('follows the control’s text while it is up, and goes when the text goes', async () => {
    pointer('pointerover', reload, aside)
    tick(TOOLTIP_DELAY)
    reload.setAttribute(TOOLTIP_ATTR, 'Stop (Esc)')
    await settle()
    expect(shown()!.textContent).toBe('Stop (Esc)')
    reload.removeAttribute(TOOLTIP_ATTR)
    await settle()
    expect(shown()).toBeNull()
  })

  it('goes when the control leaves the DOM', async () => {
    pointer('pointerover', reload, aside)
    tick(TOOLTIP_DELAY)
    expect(shown()).not.toBeNull()
    reload.remove()
    await settle()
    expect(shown()).toBeNull()
  })

  it('goes when the window loses focus', () => {
    act(() => back.focus())
    expect(shown()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(shown()).toBeNull()
  })
})

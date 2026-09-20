// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { NewTabPageAction, NewTabPageState } from '../types'
import { PRIVATE_COOKIES, newTabPageHtml } from '../newTabPage'
import { installNewTabPage, type NewTabTransport } from '../newTabPageScript'

/**
 * The page script against the served document in happy-dom (no layout, no real focus ring):
 * what the private page's "Block third-party cookies" row shows for each state and what a press
 * sends. The switch is a real `<button role="switch">`, so Space and Enter are the browser's
 * own activation; the Xvfb drive presses the real keys.
 */

function state(overrides: Partial<NewTabPageState> = {}): NewTabPageState {
  const vars = { '--zen-bg': '#f2f1f5', '--zen-fg': '#1e1e24', '--zen-fg-rgb': '30 30 36' }
  return {
    light: { vars, isDark: false },
    dark: { vars, isDark: true },
    colorScheme: 'light',
    isPrivate: false,
    shortcutsMode: 'most-visited',
    background: 'space',
    greeting: false,
    shortcuts: [],
    topSites: [],
    backgroundImage: null,
    canPickImage: false,
    ...overrides
  }
}

/** A private page's state; `null` leaves the switch's field out altogether. */
function privateState(
  cookies: { blocked: boolean; locked: boolean } | null = { blocked: true, locked: false }
): NewTabPageState {
  return state({
    isPrivate: true,
    shortcutsMode: 'hidden',
    ...(cookies ? { privateThirdPartyCookies: cookies } : {})
  })
}

interface Harness {
  sent: NewTabPageAction[]
  push(next: NewTabPageState): void
  row: HTMLElement
  toggle: HTMLButtonElement
  label: HTMLLabelElement
  description: HTMLElement
}

function mount(initial: NewTabPageState | null): Harness {
  const html = newTabPageHtml()
  document.body.innerHTML = html.slice(
    html.indexOf('<body') + html.slice(html.indexOf('<body')).indexOf('>') + 1,
    html.indexOf('</body>')
  )
  const sent: NewTabPageAction[] = []
  const stateListeners: Array<(s: NewTabPageState) => void> = []
  const transport: NewTabTransport = {
    initialState: () => initial,
    onState: (listener) => {
      stateListeners.push(listener)
    },
    onCommand: () => {},
    send: (action) => {
      sent.push(action)
    }
  }
  installNewTabPage(transport)
  return {
    sent,
    push: (next) => stateListeners.forEach((l) => l(next)),
    row: document.getElementById('zen-cookies') as HTMLElement,
    toggle: document.getElementById('zen-cookies-switch') as HTMLButtonElement,
    label: document.getElementById('zen-cookies-label') as HTMLLabelElement,
    description: document.getElementById('zen-cookies-desc') as HTMLElement
  }
}

const cookieActions = (h: Harness): NewTabPageAction[] =>
  h.sent.filter((a) => a.type === 'set-private-third-party-cookies')

describe('zen://newtab: the private page\'s "Block third-party cookies" switch', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('is a real switch button labelled by the row and described by its description', () => {
    const h = mount(privateState())
    expect(h.toggle.tagName).toBe('BUTTON')
    expect(h.toggle.type).toBe('button')
    expect(h.toggle.getAttribute('role')).toBe('switch')
    expect(h.toggle.classList.contains('zen-v2-switch')).toBe(true)
    expect(h.label.htmlFor).toBe('zen-cookies-switch')
    expect(h.label.textContent).toBe(PRIVATE_COOKIES.label)
    expect(h.toggle.getAttribute('aria-describedby')).toBe('zen-cookies-desc')
    // The row is the shared row's static form: no role of its own, the switch is the target.
    expect(h.row.classList.contains('zen-v2-row')).toBe(true)
    expect(h.row.hasAttribute('data-static')).toBe(true)
    expect(h.row.hasAttribute('role')).toBe(false)
    expect(h.sent).toEqual([{ type: 'ready' }])
  })

  it('a regular page has no row; a private page without the field has none either', () => {
    const regular = mount(state())
    expect(regular.row.hidden).toBe(true)
    expect(document.getElementById('zen-private')!.hidden).toBe(true)
    const bare = mount(privateState(null))
    expect(bare.row.hidden).toBe(true)
    expect(document.getElementById('zen-private')!.hidden).toBe(false)
  })

  it('reflects blocked as aria-checked and locked as disabled with the Settings copy', () => {
    const h = mount(privateState({ blocked: true, locked: false }))
    expect(h.row.hidden).toBe(false)
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    expect(h.toggle.disabled).toBe(false)
    expect(h.toggle.hasAttribute('aria-disabled')).toBe(false)
    expect(h.description.textContent).toBe(PRIVATE_COOKIES.description)

    h.push(privateState({ blocked: false, locked: false }))
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
    expect(h.description.textContent).toBe(PRIVATE_COOKIES.description)

    h.push(privateState({ blocked: true, locked: true }))
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    expect(h.toggle.disabled).toBe(true)
    expect(h.toggle.getAttribute('aria-disabled')).toBe('true')
    expect(h.description.textContent).toBe(PRIVATE_COOKIES.lockedDescription)

    // The lock lifts: the stored choice shows, enabled again, the plain description back.
    h.push(privateState({ blocked: false, locked: false }))
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
    expect(h.toggle.disabled).toBe(false)
    expect(h.toggle.hasAttribute('aria-disabled')).toBe(false)
    expect(h.description.textContent).toBe(PRIVATE_COOKIES.description)

    // Leaving the private state (a regular state arrives) hides the row.
    h.push(state())
    expect(h.row.hidden).toBe(true)
  })

  it('a press sends the flipped position and moves the switch at once; the next state confirms it', () => {
    const h = mount(privateState({ blocked: false, locked: false }))
    h.toggle.click()
    expect(cookieActions(h)).toEqual([{ type: 'set-private-third-party-cookies', blocked: true }])
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    // The browser's answer: the same position, nothing else moves.
    h.push(privateState({ blocked: true, locked: false }))
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    // Off again: `allow` is asked for through `blocked: false`.
    h.toggle.click()
    expect(cookieActions(h)).toEqual([
      { type: 'set-private-third-party-cookies', blocked: true },
      { type: 'set-private-third-party-cookies', blocked: false }
    ])
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
    // A correction from the browser wins over the optimistic flip.
    h.push(privateState({ blocked: true, locked: false }))
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
  })

  it("the label is the switch's: a press on it toggles too", () => {
    const h = mount(privateState({ blocked: true, locked: false }))
    h.label.click()
    expect(cookieActions(h)).toEqual([{ type: 'set-private-third-party-cookies', blocked: false }])
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('locked, a press sends nothing and the switch stays on', () => {
    const h = mount(privateState({ blocked: true, locked: true }))
    h.toggle.click()
    h.toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    h.label.click()
    expect(cookieActions(h)).toEqual([])
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    expect(h.toggle.disabled).toBe(true)
  })

  it('a press on a page that lost the field sends nothing', () => {
    const h = mount(privateState({ blocked: true, locked: false }))
    h.push(privateState(null))
    h.toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(cookieActions(h)).toEqual([])
  })
})

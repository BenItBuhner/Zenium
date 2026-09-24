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
    engineFavicon: null,
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

/**
 * The field's leading glyph (v2 §6): the default engine's favicon at 16 once loaded, the
 * magnifier until then and for good without one. happy-dom fires no load events of its own, so
 * the image's load and error are dispatched by hand.
 */
describe("zen://newtab: the field's engine favicon", () => {
  const glyph = (): HTMLSpanElement =>
    document.getElementById('zen-engine-glyph') as HTMLSpanElement
  const img = (): HTMLImageElement =>
    document.getElementById('zen-engine-favicon') as HTMLImageElement
  const magnifier = (): SVGSVGElement => glyph().querySelector('svg') as SVGSVGElement
  const magnifierShown = (): boolean => magnifier().style.display !== 'none'

  it('leads with the magnifier alone while the engine has no favicon', () => {
    mount(state({ engineFavicon: null }))
    expect(glyph().parentElement?.id).toBe('zen-search')
    expect(glyph().firstElementChild).toBe(magnifier())
    expect(img().hidden).toBe(true)
    expect(img().hasAttribute('src')).toBe(false)
    expect(magnifierShown()).toBe(true)
  })

  it('keeps the magnifier until the favicon loads, then shows the favicon in its place', async () => {
    mount(state({ engineFavicon: 'https://engine.example/favicon.ico' }))
    expect(img().getAttribute('src')).toBe('https://engine.example/favicon.ico')
    expect(img().getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img().hidden).toBe(true)
    expect(magnifierShown()).toBe(true)
    img().dispatchEvent(new Event('load'))
    expect(img().hidden).toBe(false)
    expect(magnifierShown()).toBe(false)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    expect(img().hasAttribute('data-shown')).toBe(true)
  })

  it('a favicon that never comes leaves the magnifier; a new default engine starts over', () => {
    const h = mount(state({ engineFavicon: 'https://broken.example/favicon.ico' }))
    img().dispatchEvent(new Event('error'))
    expect(img().hidden).toBe(true)
    expect(img().hasAttribute('src')).toBe(false)
    expect(magnifierShown()).toBe(true)
    h.push(state({ engineFavicon: 'https://other.example/favicon.ico' }))
    expect(img().getAttribute('src')).toBe('https://other.example/favicon.ico')
    expect(magnifierShown()).toBe(true)
    img().dispatchEvent(new Event('load'))
    expect(magnifierShown()).toBe(false)
    // Back to an engine without one: the magnifier returns and the image is dropped.
    h.push(state({ engineFavicon: null }))
    expect(img().hidden).toBe(true)
    expect(img().hasAttribute('src')).toBe(false)
    expect(magnifierShown()).toBe(true)
  })

  it('a re-push of the same favicon changes nothing; one that loaded before shows at once', () => {
    const h = mount(state({ engineFavicon: 'https://same.example/favicon.ico' }))
    img().dispatchEvent(new Event('load'))
    expect(img().hidden).toBe(false)
    h.push(state({ engineFavicon: 'https://same.example/favicon.ico', greeting: true }))
    expect(img().hidden).toBe(false)
    expect(magnifierShown()).toBe(false)
    // A fresh page for an address this page already loaded: no magnifier frame first.
    mount(state({ engineFavicon: 'https://same.example/favicon.ico' }))
    expect(img().hidden).toBe(false)
    expect(img().hasAttribute('data-shown')).toBe(true)
    expect(magnifierShown()).toBe(false)
  })
})

/**
 * The toast after a change to the grid (NTP-22): Undo and Chrome's "Restore default shortcuts"
 * link; the restore's own toast offers Undo alone. The tiles' Remove runs through the chrome's
 * `remove-tile` command, so the harness feeds that.
 */
describe('zen://newtab: the toast\'s "Restore default shortcuts" link', () => {
  const toast = (): HTMLDivElement => document.getElementById('zen-toast') as HTMLDivElement
  const buttons = (): string[] =>
    Array.from(toast().querySelectorAll('button')).map((b) => b.textContent ?? '')
  const shortcuts = [
    { id: 's1', title: 'One', url: 'https://one.example/', favicon: null },
    { id: 's2', title: 'Two', url: 'https://two.example/', favicon: null }
  ]

  function mountWithCommands(initial: NewTabPageState): {
    h: Harness
    command(c: { type: 'remove-tile'; id: string }): void
  } {
    const listeners: Array<(c: { type: 'remove-tile'; id: string }) => void> = []
    const html = newTabPageHtml()
    document.body.innerHTML = html.slice(
      html.indexOf('<body') + html.slice(html.indexOf('<body')).indexOf('>') + 1,
      html.indexOf('</body>')
    )
    const sent: NewTabPageAction[] = []
    const stateListeners: Array<(s: NewTabPageState) => void> = []
    installNewTabPage({
      initialState: () => initial,
      onState: (l) => {
        stateListeners.push(l)
      },
      onCommand: (l) => {
        listeners.push(l)
      },
      send: (a) => {
        sent.push(a)
      }
    })
    const h = {
      sent,
      push: (next: NewTabPageState) => stateListeners.forEach((l) => l(next)),
      row: document.getElementById('zen-cookies') as HTMLElement,
      toggle: document.getElementById('zen-cookies-switch') as HTMLButtonElement,
      label: document.getElementById('zen-cookies-label') as HTMLLabelElement,
      description: document.getElementById('zen-cookies-desc') as HTMLElement
    }
    return { h, command: (c) => listeners.forEach((l) => l(c)) }
  }

  it('a removal offers Undo and the restore link; the link asks for the defaults and offers its own Undo', () => {
    const { h, command } = mountWithCommands(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    expect(toast().hidden).toBe(true)
    command({ type: 'remove-tile', id: 's1' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Shortcut removed')
    expect(buttons()).toEqual(['Undo', 'Restore default shortcuts'])
    expect(h.sent.at(-1)).toEqual({ type: 'remove-shortcut', id: 's1' })
    ;(document.getElementById('zen-restore-defaults') as HTMLButtonElement).click()
    expect(h.sent.at(-1)).toEqual({ type: 'restore-default-shortcuts' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Default shortcuts restored')
    expect(buttons()).toEqual(['Undo'])
    toast().querySelector('button')!.click()
    expect(h.sent.at(-1)).toEqual({ type: 'undo-restore-default-shortcuts' })
    expect(toast().hidden).toBe(true)
  })

  it('a section the chrome hid (NTP-18) raises the toast with Undo alone; Undo asks for the section back', () => {
    const { h, command } = mountWithCommands(state({ greeting: true, shortcuts }))
    ;(command as (c: unknown) => void)({ type: 'section-hidden', section: 'greeting' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Greeting hidden')
    expect(buttons()).toEqual(['Undo'])
    toast().querySelector('button')!.click()
    expect(h.sent.at(-1)).toEqual({ type: 'show-section', section: 'greeting' })
    expect(toast().hidden).toBe(true)
    ;(command as (c: unknown) => void)({ type: 'section-hidden', section: 'shortcuts' })
    expect(toast().querySelector('span')?.textContent).toBe('Shortcuts hidden')
  })

  it("Undo on a removal restores the tile as before; the toast's link is not sent with it", () => {
    const { h, command } = mountWithCommands(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    command({ type: 'remove-tile', id: 's2' })
    toast().querySelector('button')!.click()
    expect(h.sent.at(-1)).toEqual({
      type: 'restore-shortcut',
      id: 's2',
      title: 'Two',
      url: 'https://two.example/',
      index: 1
    })
    expect(h.sent.some((a) => a.type === 'restore-default-shortcuts')).toBe(false)
    expect(toast().hidden).toBe(true)
  })
})

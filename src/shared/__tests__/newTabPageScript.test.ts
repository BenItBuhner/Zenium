// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewTabPageAction, NewTabPageCommand, NewTabPageState } from '../types'
import { NEW_TAB_AWAIT_STATE_ATTR, PRIVATE_COOKIES, newTabPageHtml } from '../newTabPage'
import {
  AWAIT_STATE_CAP_MS,
  ICON_WAIT_MS,
  LANDING_MARKS,
  iconsInHand,
  installNewTabPage,
  type NewTabTransport
} from '../newTabPageScript'

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
  cookies: NewTabPageState['privateThirdPartyCookies'] | null = { blocked: true, locked: false }
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

  it('locked by an extension’s chrome.privacy hold (services pass 10): on, disabled, the line names the holder – or "an extension" without a name – and a press sends nothing', () => {
    const h = mount(
      privateState({ blocked: true, locked: true, lockedByExtension: 'Cookie Shield Probe' })
    )
    expect(h.toggle.getAttribute('aria-checked')).toBe('true')
    expect(h.toggle.disabled).toBe(true)
    expect(h.toggle.getAttribute('aria-disabled')).toBe('true')
    expect(h.description.textContent).toBe(
      'Blocked in every window by the extension Cookie Shield Probe.'
    )
    h.toggle.click()
    expect(cookieActions(h)).toEqual([])

    h.push(privateState({ blocked: true, locked: true, lockedByExtension: '' }))
    expect(h.description.textContent).toBe('Blocked in every window by an extension.')

    // The hold withdrawn (Disable, uninstall): the user's own state shows again.
    h.push(privateState({ blocked: false, locked: false }))
    expect(h.toggle.disabled).toBe(false)
    expect(h.description.textContent).toBe(PRIVATE_COOKIES.description)
  })

  it('locked OFF by a hold at true (allow everywhere – the independent review’s Required 1): off, disabled, the twin sentence names the holder, and a press sends nothing', () => {
    const h = mount(
      privateState({ blocked: false, locked: true, lockedByExtension: 'Cookie Shield Probe' })
    )
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
    expect(h.toggle.disabled).toBe(true)
    expect(h.toggle.getAttribute('aria-disabled')).toBe('true')
    expect(h.description.textContent).toBe(
      'Allowed in every window by the extension Cookie Shield Probe.'
    )
    // No optimistic flip, no write: the switch would spring back with no word otherwise.
    h.toggle.click()
    expect(h.toggle.getAttribute('aria-checked')).toBe('false')
    expect(cookieActions(h)).toEqual([])

    h.push(privateState({ blocked: false, locked: true, lockedByExtension: '' }))
    expect(h.description.textContent).toBe('Allowed in every window by an extension.')
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
 * The toast after a change to the grid (NTP-22, v2 §9.33: one action): a sentence and Undo,
 * never a second link – Chrome's "Restore default shortcuts" is the page menu's row, whose
 * `defaults-restored` command raises the restore's own toast with Undo. The tiles' Remove runs
 * through the chrome's `remove-tile` command, so the harness feeds that.
 */
describe('zen://newtab: the toast carries Undo alone; the restore is the menu’s and comes back as a command', () => {
  const toast = (): HTMLDivElement => document.getElementById('zen-toast') as HTMLDivElement
  const buttons = (): string[] =>
    Array.from(toast().querySelectorAll('button')).map((b) => b.textContent ?? '')
  const shortcuts = [
    { id: 's1', title: 'One', url: 'https://one.example/', favicon: null },
    { id: 's2', title: 'Two', url: 'https://two.example/', favicon: null }
  ]

  function mountWithCommands(initial: NewTabPageState): {
    h: Harness
    command(c: NewTabPageCommand): void
  } {
    const listeners: Array<(c: NewTabPageCommand) => void> = []
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

  it('a removal offers Undo alone – no second link on the toast (§9.33; the restore is the page menu’s row)', () => {
    const { h, command } = mountWithCommands(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    expect(toast().hidden).toBe(true)
    command({ type: 'remove-tile', id: 's1' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Shortcut removed')
    expect(buttons()).toEqual(['Undo'])
    expect(document.getElementById('zen-restore-defaults')).toBeNull()
    expect(h.sent.at(-1)).toEqual({ type: 'remove-shortcut', id: 's1' })
    // Nothing the page sends asks for the defaults: that is the chrome's row, not the page's.
    expect(h.sent.map((a) => a.type)).not.toContain('restore-default-shortcuts')
  })

  it('the menu’s restore comes back as `defaults-restored`: the toast says so with Undo alone, and Undo asks for the three back', () => {
    const { h, command } = mountWithCommands(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    command({ type: 'defaults-restored' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Default shortcuts restored')
    expect(buttons()).toEqual(['Undo'])
    toast().querySelector('button')!.click()
    expect(h.sent.at(-1)).toEqual({ type: 'undo-restore-default-shortcuts' })
    expect(toast().hidden).toBe(true)
  })

  it('a section the chrome hid (NTP-18) raises the toast with Undo alone; Undo asks for the section back', () => {
    const { h, command } = mountWithCommands(state({ greeting: true, shortcuts }))
    command({ type: 'section-hidden', section: 'greeting' })
    expect(toast().hidden).toBe(false)
    expect(toast().querySelector('span')?.textContent).toBe('Greeting hidden')
    expect(buttons()).toEqual(['Undo'])
    toast().querySelector('button')!.click()
    expect(h.sent.at(-1)).toEqual({ type: 'show-section', section: 'greeting' })
    expect(toast().hidden).toBe(true)
    command({ type: 'section-hidden', section: 'shortcuts' })
    expect(toast().querySelector('span')?.textContent).toBe('Shortcuts hidden')
  })

  it('Undo on a removal restores the tile as before and closes the toast', () => {
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
    expect(toast().hidden).toBe(true)
  })

  it('a drag that reorders the shortcuts sends the new order and raises no toast (Chrome raises none; a move is undone by dragging back)', () => {
    // The drag's frames are taken by hand: every slot measures alike in happy-dom, so the
    // nearest slot to a moved tile is the first, and the drop settles on its spring frame by
    // frame until the script commits the order.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    try {
      const { h } = mountWithCommands(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
      const link = document.querySelector<HTMLElement>(
        '.zen-tile[data-id="s2"] a.zen-v2-shortcut'
      ) as HTMLElement
      const pointer = (type: string, clientX: number): boolean =>
        link.dispatchEvent(
          new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX, clientY: 0 })
        )
      pointer('pointerdown', 0)
      pointer('pointermove', 12)
      pointer('pointerup', 12)
      let now = performance.now()
      for (let i = 0; frames.length && i < 1000; i++) {
        now += 16
        ;(frames.shift() as FrameRequestCallback)(now)
      }
      expect(h.sent.at(-1)).toEqual({ type: 'reorder-shortcuts', ids: ['s2', 's1'] })
      expect(toast().hidden).toBe(true)
      expect(buttons()).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('zen://newtab: the field under a finger is a hand-off control (NTP-35)', () => {
  const input = (): HTMLInputElement =>
    document.getElementById('zen-search-input') as HTMLInputElement
  const form = (): HTMLFormElement => document.getElementById('zen-search') as HTMLFormElement

  /** `matchMedia` answering the pointer query as `coarse` says; the rest as happy-dom does. */
  function withPointer<T>(coarse: boolean, fn: () => T): T {
    const real = window.matchMedia.bind(window)
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      query === '(pointer: coarse)'
        ? ({
            matches: coarse,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false
          } as unknown as MediaQueryList)
        : real(query)
    )
    try {
      return fn()
    } finally {
      spy.mockRestore()
    }
  }

  it("a coarse pointer (the tablet's served page): the field raises no keyboard of its own, and the tap still hands off to the omnibox with nothing typed", () => {
    withPointer(true, () => {
      const h = mount(state())
      expect(input().inputMode).toBe('none')
      expect(input().readOnly).toBe(false)
      expect(document.activeElement).not.toBe(input())
      form().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(h.sent.at(-1)).toEqual({ type: 'search', text: '' })
    })
  })

  it('a fine pointer (the desktop): the field is as it was – a live input whose first character hands off', () => {
    withPointer(false, () => {
      const h = mount(state())
      expect(input().inputMode).toBe('')
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
      expect(h.sent.at(-1)).toEqual({ type: 'search', text: 'z' })
    })
  })

  it("a tile's context menu carries the tile's box beside the point (`rect`: the square and its caption, for the touch layouts to hang the menu from)", () => {
    const h = mount(
      state({
        shortcutsMode: 'my-shortcuts',
        shortcuts: [
          { id: 's1', title: 'One', url: 'https://one.example/', favicon: null },
          { id: 's2', title: 'Two', url: 'https://two.example/', favicon: null }
        ]
      })
    )
    const tile = document.querySelector<HTMLElement>('.zen-tile[data-id="s2"]') as HTMLElement
    const link = tile.querySelector<HTMLElement>('a.zen-v2-shortcut') as HTMLElement
    // happy-dom lays nothing out: the tile's box is given to it.
    tile.getBoundingClientRect = () =>
      ({ left: 120.4, top: 200, width: 104, height: 95.6 }) as DOMRect
    link.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 150, clientY: 250 })
    )
    expect(h.sent.at(-1)).toEqual({
      type: 'tile-menu',
      id: 's2',
      url: 'https://two.example/',
      title: 'Two',
      x: 150,
      y: 250,
      keyboard: false,
      rect: { x: 120, y: 200, width: 104, height: 96 }
    })
  })
})

/**
 * NTP-35 (#563, the lead's conditions of form on the tablet's boot landing): the Android host's
 * document awaits its first state TRANSPARENT (`data-await-state` on its root, `newTabPage.ts`;
 * the host hands no state before the first paint) and comes in WHOLE – filled from the state
 * push, the tiles with their icons decoded (a tile whose icon is on its way keeps its slot empty:
 * never a letter that turns into an icon), the field, the sentence – the attribute coming off on
 * the NEXT FRAME after the fill so the layout is in before the root's 120 ms opacity fade runs
 * (a cut under reduced motion: the stylesheet's rule). The frames are taken by hand, and so is
 * `HTMLImageElement.decode()` (happy-dom's settles at once): the order is the pin.
 */
describe("zen://newtab: the awaiting document comes in whole (NTP-35, the tablet's served page)", () => {
  const root = (): HTMLElement => document.documentElement
  const awaiting = (): boolean => root().hasAttribute(NEW_TAB_AWAIT_STATE_ATTR)
  const icons = (): HTMLImageElement[] =>
    Array.from(document.querySelectorAll<HTMLImageElement>('img.zen-ntp-icon'))
  const letters = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.zen-ntp-letter')).map(
      (l) => l.textContent ?? ''
    )
  const engineImg = (): HTMLImageElement =>
    document.getElementById('zen-engine-favicon') as HTMLImageElement
  /** A macrotask: every promise chain in flight has settled. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const shortcuts = [
    {
      id: 's1',
      title: 'One',
      url: 'https://one.example/',
      favicon: 'zen://favicon/0123456789abcdef0123456789abcdef'
    },
    {
      id: 's2',
      title: 'Two',
      url: 'https://two.example/',
      favicon: 'zen://favicon/fedcba9876543210fedcba9876543210'
    },
    // No icon cached for it: the letter IS its face, nothing arrives later to replace it.
    { id: 's3', title: 'Three', url: 'https://three.example/', favicon: null }
  ]

  let frames: FrameRequestCallback[] = []
  const runFrames = (): void => {
    let now = performance.now()
    for (let i = 0; frames.length && i < 100; i++) {
      now += 16
      ;(frames.shift() as FrameRequestCallback)(now)
    }
  }

  /** `decode()` settles only by the test's hand, per image. */
  function decodeByHand(): {
    settle(img: HTMLImageElement): void
    fail(img: HTMLImageElement): void
    asked(): number
  } {
    const pending = new Map<HTMLImageElement, { resolve(): void; reject(e: Error): void }>()
    const spy = vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (
      this: HTMLImageElement
    ) {
      return new Promise<void>((resolve, reject) => {
        pending.set(this, { resolve, reject })
      })
    })
    const of = (img: HTMLImageElement): { resolve(): void; reject(e: Error): void } => {
      const entry = pending.get(img)
      if (!entry) throw new Error('decode() was not asked of this image')
      return entry
    }
    return {
      settle: (img) => of(img).resolve(),
      fail: (img) => of(img).reject(new Error('EncodingError')),
      asked: () => spy.mock.calls.length
    }
  }

  /** The Android host's document: the attribute on the root, no state handed synchronously. */
  function mountAwaiting(): Harness {
    root().setAttribute(NEW_TAB_AWAIT_STATE_ATTR, '')
    return mount(null)
  }

  /** The landing's marks on the page's own clock, in the order they were set. */
  const marks = (): string[] =>
    performance
      .getEntriesByType('mark')
      .map((m) => m.name)
      .filter((n) => n.startsWith('zen-newtab-'))

  beforeEach(() => {
    frames = []
    performance.clearMarks()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    root().removeAttribute(NEW_TAB_AWAIT_STATE_ATTR)
    performance.clearMarks()
  })

  it('stays transparent until its first state: frames pass, nothing is let in', async () => {
    const h = mountAwaiting()
    expect(awaiting()).toBe(true)
    expect(h.sent).toEqual([{ type: 'ready' }])
    await flush()
    runFrames()
    expect(awaiting()).toBe(true)
    expect(icons()).toEqual([])
    // The record so far: the ready sent, nothing let in.
    expect(marks()).toEqual([LANDING_MARKS.ready])
  })

  it('the state fills the document unseen; the icons decode; the next frame lets it in whole', async () => {
    const decode = decodeByHand()
    const h = mountAwaiting()
    h.push(
      state({
        shortcutsMode: 'my-shortcuts',
        shortcuts,
        greeting: true,
        engineFavicon: 'https://engine.example/favicon.ico'
      })
    )
    // Filled at once, still transparent: the grid's three tiles, the field's favicon asked for.
    expect(awaiting()).toBe(true)
    expect(icons().map((i) => i.getAttribute('src'))).toEqual([
      shortcuts[0].favicon,
      shortcuts[1].favicon
    ])
    expect(letters()).toEqual(['T'])
    expect(engineImg().getAttribute('src')).toBe('https://engine.example/favicon.ico')
    await flush()
    // Every icon with an address is asked to decode – the two tiles' and the field's.
    expect(decode.asked()).toBe(3)
    runFrames()
    expect(awaiting()).toBe(true)

    // Two of three in hand: still waiting, and no tile shows a letter in the meantime.
    decode.settle(icons()[0])
    decode.settle(icons()[1])
    await flush()
    runFrames()
    expect(awaiting()).toBe(true)
    expect(letters()).toEqual(['T'])

    // The last in hand: the fill is laid out on this frame, the attribute comes off on the next.
    decode.settle(engineImg())
    await flush()
    expect(awaiting()).toBe(true)
    expect(marks()).toEqual([LANDING_MARKS.ready, LANDING_MARKS.state, LANDING_MARKS.icons])
    expect(frames.length).toBeGreaterThan(0)
    runFrames()
    expect(awaiting()).toBe(false)
    expect(letters()).toEqual(['T'])
    // The landing's record, in the order the run reads it: ready → state → icons → in, no cap.
    expect(marks()).toEqual([
      LANDING_MARKS.ready,
      LANDING_MARKS.state,
      LANDING_MARKS.icons,
      LANDING_MARKS.in
    ])

    // A later push changes the page in place: the attribute does not come back, no second wait.
    const asked = decode.asked()
    h.push(state({ shortcutsMode: 'my-shortcuts', shortcuts: shortcuts.slice(0, 1) }))
    await flush()
    runFrames()
    expect(awaiting()).toBe(false)
    expect(decode.asked()).toBe(asked)
    expect(marks().length).toBe(4)
  })

  it("an icon that fails to decode is in hand as its letter: the icon's answer, not a letter ahead of it", async () => {
    const decode = decodeByHand()
    const h = mountAwaiting()
    h.push(state({ shortcutsMode: 'my-shortcuts', shortcuts: shortcuts.slice(0, 2) }))
    await flush()
    const [one, two] = icons()
    decode.settle(one)
    decode.fail(two)
    // The store's own word that there is no icon: the tile falls back to its letter.
    two.dispatchEvent(new Event('error'))
    await flush()
    runFrames()
    expect(awaiting()).toBe(false)
    expect(letters()).toEqual(['T'])
    expect(icons().length).toBe(1)
  })

  it('an icon still on its way at the cap lets the page in with that slot empty, never a letter', async () => {
    decodeByHand()
    const img = document.createElement('img')
    img.className = 'zen-ntp-icon'
    img.src = shortcuts[0].favicon as string
    let settled = false
    const wait = iconsInHand([img], 20).then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    await wait
    expect(settled).toBe(true)
    // No icons to wait for: in hand at once, no timer armed.
    let atOnce = false
    void iconsInHand([], 20).then(() => {
      atOnce = true
    })
    await Promise.resolve()
    expect(atOnce).toBe(true)
    // The page's own numbers: the icons' cap well under a frame's worth of frames at the boot's
    // pace; the state's cap THE BOOT HOLD's OWN 5 s FAIL-SAFE (`BootPlacementHold.DEADLINE_MS`),
    // not a guess at the push's pace – the host's UI thread can sit behind the served view's
    // first frame for seconds on an emulator (2.4 s measured), and the push waits behind it.
    expect(ICON_WAIT_MS).toBe(300)
    expect(AWAIT_STATE_CAP_MS).toBe(5000)
  })

  it("a tile whose icon is late at the cap is let in EMPTY and fills when its icon lands – an arrival into an empty seat, not a swap; the letter is the failed icon's alone", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const decode = decodeByHand()
    const h = mountAwaiting()
    h.push(state({ shortcutsMode: 'my-shortcuts', shortcuts: shortcuts.slice(0, 2) }))
    await vi.advanceTimersByTimeAsync(0)
    const [one, two] = icons()
    decode.settle(one)
    // Two's answer has not come by the icons' cap: the page is let in with its seat empty – the
    // `<img>` in place, its source kept, nothing drawn for it.
    await vi.advanceTimersByTimeAsync(ICON_WAIT_MS)
    runFrames()
    expect(awaiting()).toBe(false)
    expect(letters()).toEqual([])
    expect(icons()).toHaveLength(2)
    expect(icons()[1]).toBe(two)
    expect(two.isConnected).toBe(true)
    expect(two.getAttribute('src')).toBe(shortcuts[1].favicon)
    // The icon lands after the reveal: the same `<img>`, in the same seat, is what paints it –
    // the page swaps nothing, replaces nothing, and never drew a letter for it.
    decode.settle(two)
    two.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(0)
    runFrames()
    expect(icons()).toHaveLength(2)
    expect(icons()[1]).toBe(two)
    expect(two.isConnected).toBe(true)
    expect(letters()).toEqual([])
    expect(marks()).toEqual([
      LANDING_MARKS.ready,
      LANDING_MARKS.state,
      LANDING_MARKS.icons,
      LANDING_MARKS.in
    ])
    // Only the store's own word that there is no icon draws the letter, before or after the reveal.
    two.dispatchEvent(new Event('error'))
    expect(letters()).toEqual(['T'])
    expect(icons()).toHaveLength(1)
    expect(icons()[0]).toBe(one)
  })

  it('a state that never comes: the shell is let in at the cap rather than staying the ground', async () => {
    // The clock alone is faked: the frames stay the test's own hand.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = mountAwaiting()
    expect(awaiting()).toBe(true)
    await vi.advanceTimersByTimeAsync(AWAIT_STATE_CAP_MS - 1)
    runFrames()
    expect(awaiting()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(awaiting()).toBe(true)
    runFrames()
    expect(awaiting()).toBe(false)
    expect(h.sent).toEqual([{ type: 'ready' }])
    // The record names the cap: a run reading it knows the shell came in without its state.
    expect(marks()).toEqual([
      LANDING_MARKS.ready,
      LANDING_MARKS.cap,
      LANDING_MARKS.icons,
      LANDING_MARKS.in
    ])
  })

  it('a state that comes late, before the cap, is the fill: the cap is cleared and never named', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = mountAwaiting()
    await vi.advanceTimersByTimeAsync(AWAIT_STATE_CAP_MS - 100)
    runFrames()
    expect(awaiting()).toBe(true)
    h.push(state({ shortcutsMode: 'most-visited' }))
    await vi.advanceTimersByTimeAsync(0)
    runFrames()
    expect(awaiting()).toBe(false)
    await vi.advanceTimersByTimeAsync(AWAIT_STATE_CAP_MS)
    expect(marks()).toEqual([
      LANDING_MARKS.ready,
      LANDING_MARKS.state,
      LANDING_MARKS.icons,
      LANDING_MARKS.in
    ])
  })

  it("the desktop's document carries no attribute and none of this runs for it", async () => {
    const decode = decodeByHand()
    const h = mount(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    expect(awaiting()).toBe(false)
    h.push(state({ shortcutsMode: 'my-shortcuts', shortcuts }))
    await flush()
    runFrames()
    expect(awaiting()).toBe(false)
    expect(decode.asked()).toBe(0)
    expect(icons().length).toBe(2)
    // No mark on the desktop's clock: the awaiting path is not the desktop's.
    expect(marks()).toEqual([])
  })
})

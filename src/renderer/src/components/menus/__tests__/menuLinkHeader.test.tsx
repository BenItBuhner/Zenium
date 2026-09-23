// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuHeader, MenuItemDescriptor } from '@shared/types'
import { MenuSheet } from '../MenuSheet'
import { viewportStore } from '@renderer/lib/formFactor'
import { SheetPresence } from '@renderer/lib/motion/presence'
import { uiStore } from '@renderer/lib/ui'

/*
 * The link menu's header (PUI-18; Chrome for Android's context-menu header), rendered for real
 * in happy-dom: a link's or an image's menu on the phone opens on what was held – the site's
 * favicon (the globe when the cache holds none) or the image as a thumbnail, the title over the
 * address, in the §9.16 header's place, naming the sheet – a tap expands the address, a
 * long-press copies it through the clipboard command with the toast's word, and the click that
 * follows the hold changes nothing. A drill into a submenu shows the row's label as the title, as
 * every submenu does. The frame loop is cranked by hand (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => undefined)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

// --- the menu ---------------------------------------------------------------------------------

function item(
  id: string,
  label: string,
  patch: Partial<MenuItemDescriptor> = {}
): MenuItemDescriptor {
  return { id, type: 'normal', label, enabled: true, checked: false, submenu: null, ...patch }
}

const LINK: MenuHeader = {
  url: 'https://docs.example.org/guides/getting-started/installation',
  copied: 'Link copied',
  title: 'Getting started',
  favicon: 'data:image/png;base64,AAAA',
  thumbnail: null
}

/** A link's context menu as the core serialises it on the phone: the header, then the rows (`null`: none). */
function linkMenu(header: MenuHeader | null = LINK): MenuDescriptor {
  return {
    id: 'menu_9',
    source: 'page',
    x: 120,
    y: 400,
    ...(header ? { header } : {}),
    items: [
      item('menu_9_1', 'Open Link in New Tab'),
      item('menu_9_2', 'Open Link in Private Tab'),
      item('menu_9_3', '', { type: 'separator' }),
      item('menu_9_4', 'Copy Link Address'),
      item('menu_9_5', 'Share Link', {
        submenu: [item('menu_9_5_1', 'Copy'), item('menu_9_5_2', 'Send to Your Devices')]
      })
    ]
  }
}

const layer = (m: MenuDescriptor): ReactElement => (
  <SheetPresence>
    <MenuSheet key={m.id} menu={m} />
  </SheetPresence>
)

async function show(m: MenuDescriptor): Promise<void> {
  uiStore.set({ menu: m })
  render(layer(m))
  await settle()
  frames.run(60)
}

const header = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.zen-menu-link-header')
const title = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-menu-link-title')
const address = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-menu-link-url')
const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!
const rows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')].map((b) => b.textContent ?? '')
const fire = (el: Element, type: string): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  })
}
const copies = (): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === 'clipboard.writeText')

beforeEach(() => {
  frames.install()
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
  invoke.mockClear()
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
  viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ menu: null })
  vi.unstubAllGlobals()
  frames.now = 0
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
})

describe('the link menu’s header', () => {
  it('opens on the link: the favicon, the title over the address, in the header’s place, and it names the sheet', async () => {
    await show(linkMenu())
    const h = header()!
    expect(h).not.toBeNull()
    // The header's slot is the sheet's own (`.zen-sheet-header`, the chassis untouched): no
    // centred title stands beside the row.
    expect(h.parentElement!.classList.contains('zen-sheet-header')).toBe(true)
    expect(document.querySelector('.zen-sheet-title')).toBeNull()
    expect(h.tagName).toBe('BUTTON')
    expect(h.getAttribute('type')).toBe('button')
    expect(title()!.textContent).toBe('Getting started')
    expect(address()!.textContent).toBe(LINK.url)
    // The favicon at 20 in the list's own box; no thumbnail for a link.
    const favicon = h.querySelector<HTMLImageElement>('.zen-menu-link-favicon img.zen-list-favicon')
    expect(favicon).not.toBeNull()
    expect(favicon!.getAttribute('src')).toBe(LINK.favicon)
    expect(favicon!.getAttribute('alt')).toBe('')
    expect(h.querySelector('.zen-menu-link-thumbnail')).toBeNull()
    // The title is what the dialog is named by.
    expect(title()!.id).not.toBe('')
    expect(dialog().getAttribute('aria-labelledby')).toBe(title()!.id)
    expect(rows()).toEqual([
      'Open Link in New Tab',
      'Open Link in Private Tab',
      'Copy Link Address',
      'Share Link'
    ])
  })

  it('draws the globe stand-in when the cache holds no favicon, and the image itself at 40 for an image', async () => {
    await show(linkMenu({ ...LINK, favicon: null }))
    expect(header()!.querySelector('.zen-menu-link-favicon .zen-list-standin')).not.toBeNull()
    expect(header()!.querySelector('img')).toBeNull()
    act(() => root!.unmount())
    root = null
    mount?.remove()
    mount = null

    await show(
      linkMenu({
        url: 'https://cdn.example.org/photos/1.jpg',
        copied: 'Image address copied',
        title: 'cdn.example.org',
        favicon: null,
        thumbnail: 'https://cdn.example.org/photos/1.jpg'
      })
    )
    const thumb = header()!.querySelector<HTMLImageElement>('img.zen-menu-link-thumbnail')
    expect(thumb).not.toBeNull()
    expect(thumb!.getAttribute('src')).toBe('https://cdn.example.org/photos/1.jpg')
    expect(thumb!.getAttribute('alt')).toBe('')
    expect(thumb!.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(header()!.querySelector('.zen-menu-link-favicon')).toBeNull()
    expect(title()!.textContent).toBe('cdn.example.org')
  })

  it('a tap expands the address to its full length and a second folds it; nothing is picked or copied', async () => {
    await show(linkMenu())
    const h = header()!
    expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(h.hasAttribute('data-expanded')).toBe(false)
    fire(h, 'click')
    expect(h.getAttribute('aria-expanded')).toBe('true')
    expect(h.getAttribute('data-expanded')).toBe('true')
    fire(h, 'click')
    expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(h.hasAttribute('data-expanded')).toBe(false)
    expect(copies()).toEqual([])
    expect(invoke.mock.calls.filter(([name]) => name === 'menu.click')).toEqual([])
    expect(uiStore.get().menu).not.toBeNull()
  })

  it('a long-press copies the address with the toast’s word, and the click that follows the hold changes nothing', async () => {
    await show(linkMenu())
    const h = header()!
    // The `contextmenu` Chromium raises for a touch hold (a right click on a mouse) is the
    // long-press's cue in `useLongPress`.
    fire(h, 'contextmenu')
    expect(copies()).toEqual([
      ['clipboard.writeText', { text: LINK.url, confirmation: 'Link copied' }]
    ])
    fire(h, 'click')
    expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(copies()).toHaveLength(1)
    // The next tap is a tap again.
    fire(h, 'click')
    expect(h.getAttribute('aria-expanded')).toBe('true')
    expect(copies()).toHaveLength(1)
  })

  it('a phone number’s or an address’s header carries the bare number and its own toast word', async () => {
    await show(
      linkMenu({
        url: '+44 20 7946 0958',
        copied: 'Phone number copied',
        title: 'Phone number',
        favicon: null,
        thumbnail: null
      })
    )
    expect(title()!.textContent).toBe('Phone number')
    expect(address()!.textContent).toBe('+44 20 7946 0958')
    fire(header()!, 'contextmenu')
    expect(copies()).toEqual([
      ['clipboard.writeText', { text: '+44 20 7946 0958', confirmation: 'Phone number copied' }]
    ])
  })

  it('a drill into a submenu shows the row’s label as the title, the header gone until Back', async () => {
    await show(linkMenu())
    const share = [...document.querySelectorAll<HTMLButtonElement>('.zen-sheet-item')].find(
      (b) => b.textContent === 'Share Link'
    )!
    fire(share, 'click')
    expect(header()).toBeNull()
    const t = document.querySelector<HTMLElement>('.zen-sheet-title')!
    expect(t.textContent).toBe('Share Link')
    expect(dialog().getAttribute('aria-labelledby')).toBe(t.id)
    expect(rows()).toEqual(['Copy', 'Send to Your Devices'])
    fire(document.querySelector('.zen-sheet-header-control[data-side="leading"]')!, 'click')
    expect(header()).not.toBeNull()
    expect(document.querySelector('.zen-sheet-title')).toBeNull()
  })

  it('a menu without a header – the page’s own, the app menu – keeps the centred title', async () => {
    await show(linkMenu(null))
    expect(header()).toBeNull()
    const t = document.querySelector<HTMLElement>('.zen-sheet-title')!
    expect(t).not.toBeNull()
    expect(dialog().getAttribute('aria-labelledby')).toBe(t.id)
  })

  it('the header’s rules draw in tokens alone: the two-line row height, the 16 gutter, the type and ink tokens, no literal hue', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const block = css.slice(
      css.indexOf('.zen-sheet-header:has(> .zen-menu-link-header)'),
      css.indexOf('.zen-sheet-grip {')
    )
    expect(block.length).toBeGreaterThan(0)
    const rule = /\.zen-menu-link-header \{([^}]*)\}/.exec(block)![1]
    expect(rule).toContain('min-height: var(--v2-row-two-line)')
    expect(rule).toContain('padding: 12px 16px')
    expect(rule).toContain('gap: 12px')
    const titleRule = /\.zen-menu-link-title \{([^}]*)\}/.exec(block)![1]
    expect(titleRule).toContain('font-size: var(--v2-font-body)')
    expect(titleRule).toContain('font-weight: var(--v2-weight-heading)')
    const urlRule = /\.zen-menu-link-url \{([^}]*)\}/.exec(block)![1]
    expect(urlRule).toContain('color: var(--v2-text-deemphasized)')
    expect(urlRule).toContain('font-size: var(--v2-font-small)')
    // The header's 46 side padding gives way to the row's own gutter, on the chassis's rule.
    expect(block).toMatch(/\.zen-sheet-header:has\(> \.zen-menu-link-header\) \{\s*padding: 0;/)
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo, UIState } from '@shared/types'

/*
 * The favicon slot of a tab on an extension's page (v2 §10.1 applied to extension pages): the
 * extension's icon when the page supplies no favicon of its own – the puzzle glyph while the
 * extension has none or is unknown – and never a letter of its id, for both forms the address
 * takes (`chrome-extension://` and the Android runtime's emulated origin). A page that names a
 * favicon keeps it, as any site does.
 */

const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Favicon } = await import('../sidebar/Favicon')
const { browserStore } = await import('@renderer/lib/ui')

const ID = 'dbepggeogbaibhgnhhndojpepiihcmeb'
const ICON = 'data:image/png;base64,icon'
const OWN_FAVICON = 'data:image/png;base64,favicon'
const SCHEME_URL = `chrome-extension://${ID}/pages/options.html`
const EMULATED_URL = `https://${ID}.ext.zenium.invalid/pages/options.html`

const source = (
  url: string,
  favicon: string | null = null
): Parameters<typeof Favicon>[0]['tab'] => ({
  url,
  title: 'Vimium Options',
  favicon,
  customIcon: null,
  customTitle: null,
  loading: false,
  discarded: false,
  containerId: 'default'
})

function withExtensions(extensions: ExtensionInfo[]): void {
  browserStore.set({ state: { extensions } as unknown as UIState })
}

const vimium = { id: ID, name: 'Vimium', icon: ICON, enabled: true } as ExtensionInfo

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

beforeEach(() => withExtensions([vimium]))

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
})

describe('Favicon on an extension page', () => {
  it('shows the extension’s icon at the slot’s size when the page has no favicon of its own', () => {
    for (const url of [SCHEME_URL, EMULATED_URL]) {
      const el = render(<Favicon tab={source(url)} size={16} />)
      const img = el.querySelector('img')
      expect(img?.getAttribute('src')).toBe(ICON)
      expect(img?.style.width).toBe('16px')
      expect(el.textContent).toBe('')
      act(() => root?.unmount())
      host?.remove()
    }
  })

  it('shows the puzzle glyph, never a letter tile, while the extension has no icon or is unknown', () => {
    withExtensions([{ ...vimium, icon: null }])
    let el = render(<Favicon tab={source(SCHEME_URL)} size={16} />)
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('svg.zen-ext-icon-glyph')).not.toBeNull()
    expect(el.textContent).toBe('')
    act(() => root?.unmount())
    host?.remove()
    // Removed, or the list has not arrived: the id is no site to take a letter from.
    withExtensions([])
    el = render(<Favicon tab={source(EMULATED_URL)} size={16} />)
    expect(el.querySelector('svg.zen-ext-icon-glyph')).not.toBeNull()
    expect(el.textContent).toBe('')
  })

  it('keeps a favicon the page names, as any site does', () => {
    const el = render(<Favicon tab={source(SCHEME_URL, OWN_FAVICON)} size={16} />)
    expect(el.querySelector('img')?.getAttribute('src')).toBe(OWN_FAVICON)
  })

  it('still draws a site without a favicon as its letter tile', () => {
    const el = render(<Favicon tab={source('https://www.example.com/')} size={16} />)
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toBe('E')
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AppWindowInfo, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { APP_MENU_EVENT } from '@renderer/lib/shortcuts'
import { browserStore } from '@renderer/lib/ui'
import { TOOLBAR_STROKE } from '../../v2/controls'
import { AppTitleBar } from '../AppTitleBar'

/*
 * The title bar of a web app's standalone window (MW-23; the one row of chrome an app window
 * has in place of the toolbar), rendered for real in happy-dom: what it shows of the app and
 * the page (the installed icon over the favicon, the page's title over the app's name, the host
 * as the title's tooltip), that its menu button opens the core's menu from its own edge – from
 * the keyboard too, through the chrome-wide menu event –, and that the window's buttons and the
 * host's insets are where the toolbar puts them.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app: AppWindowInfo = {
  name: 'Notes',
  icon: 'data:image/png;base64,AAAA',
  scope: 'https://notes.example.com/',
  appId: 'app-1',
  startUrl: 'https://notes.example.com/'
}

function tab(over: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    url: 'https://notes.example.com/today',
    title: 'Today – Notes',
    favicon: 'data:image/png;base64,BBBB',
    ...over
  } as Tab
}

/** A Linux app window whose host draws no caption buttons of its own. */
function stateWith(over: Partial<UIState> = {}): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true, windowControls: true, windowControlsOverlay: false },
    window: { chrome: 'app', app, fullscreen: false },
    tabs: {},
    spaces: [],
    folders: {},
    essentialTabIds: [],
    settings: {},
    shortcuts: [],
    extensions: [],
    ...over
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}

function bar(
  state: UIState,
  current: Tab | null,
  insets: Partial<{ trailing: number; leading: number }> = {}
): void {
  browserStore.set({ state })
  render(
    <AppTitleBar
      state={state}
      tab={current}
      app={state.window.app!}
      trailingInset={insets.trailing}
      leadingInset={insets.leading}
    />
  )
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  vi.mocked(run).mockClear()
})

describe('AppTitleBar', () => {
  it('shows the installed icon and the page title, with the host as the tooltip', () => {
    bar(stateWith(), tab())
    const icon = q<HTMLImageElement>('.zen-app-titlebar-icon')
    expect(icon.tagName).toBe('IMG')
    expect(icon.getAttribute('src')).toBe(app.icon)
    const title = q('.zen-app-titlebar-title')
    expect(title.textContent).toBe('Today – Notes')
    expect(title.getAttribute('title')).toBe('notes.example.com')
  })

  it("reads the app's name while the page has no title", () => {
    bar(stateWith(), tab({ title: '' }))
    expect(q('.zen-app-titlebar-title').textContent).toBe('Notes')
  })

  it('falls back to the favicon for a window no installed app owns', () => {
    const unowned = { ...app, icon: null, appId: null }
    bar(
      stateWith({ window: { chrome: 'app', app: unowned, fullscreen: false } } as Partial<UIState>),
      tab()
    )
    const icon = q<HTMLImageElement>('.zen-app-titlebar-icon')
    expect(icon.getAttribute('src')).toBe('data:image/png;base64,BBBB')
  })

  it('falls back to the favicon once the installed icon fails to load', () => {
    bar(stateWith(), tab())
    const icon = q<HTMLImageElement>('.zen-app-titlebar-icon')
    act(() => {
      icon.dispatchEvent(new Event('error'))
    })
    expect(q<HTMLImageElement>('.zen-app-titlebar-icon').getAttribute('src')).toBe(
      'data:image/png;base64,BBBB'
    )
  })

  it('opens the web-app menu from the button, and from the keyboard through the menu event', () => {
    bar(stateWith(), tab())
    const button = q<HTMLButtonElement>('[data-zen-app-titlebar] button[aria-haspopup="menu"]')
    expect(button.getAttribute('title')).toBe('Menu')
    act(() => button.click())
    expect(vi.mocked(run).mock.calls.at(-1)?.[0]).toBe('app.menu')
    expect((vi.mocked(run).mock.calls.at(-1)?.[1] as { keyboard: boolean }).keyboard).toBe(false)
    vi.mocked(run).mockClear()
    const event = new Event(APP_MENU_EVENT, { cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(vi.mocked(run).mock.calls.at(-1)?.[0]).toBe('app.menu')
    expect((vi.mocked(run).mock.calls.at(-1)?.[1] as { keyboard: boolean }).keyboard).toBe(true)
    expect(document.activeElement).toBe(button)
  })

  // Design language v2 §9.3: the title bar's one 16 px glyph draws at the toolbar row's stroke,
  // as the SVG attribute (the #245 review's chassis item (d)).
  it('draws its menu glyph at the toolbar stroke', () => {
    bar(stateWith(), tab())
    const glyph = q<SVGElement>('[data-zen-app-titlebar] button[aria-haspopup="menu"] svg')
    expect(glyph.classList.contains('h-4')).toBe(true)
    expect(glyph.getAttribute('stroke-width')).toBe(String(TOOLBAR_STROKE))
  })

  it("draws the window's buttons where the host does not, and keeps the host's insets clear", () => {
    bar(stateWith(), tab(), { trailing: 138, leading: 72 })
    expect(document.querySelector('[title="Close"]')).not.toBeNull()
    const row = q('[data-zen-app-titlebar]')
    expect(row.style.paddingRight).toBe('142px')
    expect(row.style.paddingLeft).toBe('72px')
    expect(row.classList.contains('zen-drag')).toBe(true)
    expect(row.getAttribute('data-surface')).toBe('window')
  })

  it("leaves the window's buttons to a host that overlays its own", () => {
    bar(
      stateWith({
        capabilities: { windows: true, windowControls: true, windowControlsOverlay: true }
      } as Partial<UIState>),
      tab()
    )
    expect(document.querySelector('[title="Close"]')).toBeNull()
  })
})

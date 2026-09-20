// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState, WebAppInstallPrompt } from '@shared/types'
import type { WebAppInfo } from '@shared/webApp'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import { FrameDialogHost, closeAllPopovers } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { InstallDialogLayer } from '../InstallDialog'

/*
 * The desktop's install dialog (install/InstallDialog.tsx, MW-22): the install surface of a host
 * with windows – registered through `ui.surface` there and never on a one-window host – showing
 * Chrome's "Install app" for a page with an installable manifest (the app's name and origin, the
 * one primary "Install" armed) and "Create shortcut" for a page without one (a name field armed
 * with the page's title, "Create"); "Install" goes busy while `webapp.pin` is out and the dialog
 * leaves once it has settled, while Cancel and Escape report a cancelled install; the dialog goes
 * with its tab, cancelling an install not yet taken.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INFO: WebAppInfo = {
  manifestUrl: 'https://app.example/manifest.json',
  id: 'https://app.example/',
  name: 'Example App',
  shortName: 'Example',
  description: 'Does example things.',
  startUrl: 'https://app.example/',
  scope: 'https://app.example/',
  display: 'standalone',
  themeColor: null,
  backgroundColor: null,
  icons: [
    { src: 'https://app.example/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' }
  ],
  screenshots: [],
  shortcuts: []
} as unknown as WebAppInfo

const APP_PROMPT: WebAppInstallPrompt = {
  tabId: 't1',
  title: 'Example App',
  url: 'https://app.example/',
  origin: 'app.example',
  icon: null,
  info: INFO,
  tint: null,
  surface: 'desktop'
}

const PAGE_PROMPT: WebAppInstallPrompt = {
  ...APP_PROMPT,
  title: 'A plain page',
  info: null
}

function stateWith(activeTabId: string | null, windows = true): UIState {
  return {
    platform: 'linux',
    capabilities: { windows },
    tabs: activeTabId ? { [activeTabId]: { id: activeTabId, url: 'https://app.example/' } } : {},
    spaces: [{ id: 'space', activeTabId }],
    activeSpaceId: 'space'
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

function layer(state: UIState): ReactElement {
  return (
    <FrameDialogHost frame>
      <InstallDialogLayer state={state} />
    </FrameDialogHost>
  )
}

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function keydown(target: Element | null, key: string): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  uiStore.set({ install: null })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ install: null })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('InstallDialogLayer as the install surface', () => {
  it('registers the install surface on a host with windows and takes it back on unmount', () => {
    render(layer(stateWith('t1')))
    expect(vi.mocked(run).mock.calls).toContainEqual([
      'ui.surface',
      { surface: 'install', mounted: true }
    ])
    act(() => root!.unmount())
    root = null
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'ui.surface',
      { surface: 'install', mounted: false }
    ])
  })

  it('registers nothing and shows nothing on a one-window host, whose surface is the phone sheet', () => {
    uiStore.set({ install: { ...APP_PROMPT, surface: 'homeScreen' } })
    const el = render(layer(stateWith('t1', false)))
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('ui.surface', expect.anything())
    expect(el.querySelector('[data-install-dialog]')).toBeNull()
  })
})

describe('InstallDialog', () => {
  it('shows "Install app" for a page with a manifest – the app, its origin, Install armed', () => {
    uiStore.set({ install: APP_PROMPT })
    const el = render(layer(stateWith('t1')))
    const dialog = el.querySelector<HTMLElement>('[data-install-dialog="app"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('role')).toBe('dialog')
    expect(dialog!.style.width).toBe('400px')
    expect(dialog!.querySelector('h2')!.textContent).toBe('Install app')
    expect(dialog!.querySelector('.zen-install-name')!.textContent).toBe('Example App')
    expect(dialog!.querySelector('.zen-install-detail')!.textContent).toBe('app.example')
    expect(dialog!.querySelector('.zen-install-description')!.textContent).toBe(
      'Does example things.'
    )
    expect(dialog!.querySelector('input')).toBeNull()
    const primary = dialog!.querySelector<HTMLButtonElement>('[data-accept]')!
    expect(primary.textContent).toBe('Install')
    expect(primary.hasAttribute('data-primary')).toBe(true)
    expect(dialog!.querySelectorAll('[data-primary]')).toHaveLength(1)
    expect(document.activeElement).toBe(primary)
  })

  it('shows "Create shortcut" for a page without one – a name field with the page title, Create', () => {
    uiStore.set({ install: PAGE_PROMPT })
    const el = render(layer(stateWith('t1')))
    const dialog = el.querySelector<HTMLElement>('[data-install-dialog="shortcut"]')!
    expect(dialog.querySelector('h2')!.textContent).toBe('Create shortcut')
    const field = dialog.querySelector<HTMLInputElement>('input')!
    expect(field.value).toBe('A plain page')
    expect(dialog.querySelector('label')!.textContent).toBe('Name')
    expect(dialog.querySelector('.zen-v2-field-message')!.textContent).toBe('app.example')
    expect(dialog.querySelector('[data-accept]')!.textContent).toBe('Create')
    expect(document.activeElement).toBe(field)
  })

  it('"Install" pins through the core with the name, busy meanwhile, and the dialog leaves once it settled', async () => {
    let settlePin: (() => void) | null = null
    vi.mocked(cmd).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          settlePin = () => resolve(null)
        }) as never
    )
    uiStore.set({ install: PAGE_PROMPT })
    const el = render(layer(stateWith('t1')))
    const field = el.querySelector<HTMLInputElement>('input')!
    act(() => {
      // Past React's value tracker, so the change registers.
      nativeValue.call(field, '  My   shortcut ')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const primary = el.querySelector<HTMLButtonElement>('[data-accept]')!
    click(primary)
    expect(cmd).toHaveBeenCalledWith('webapp.pin', { tabId: 't1', title: 'My   shortcut' })
    expect(primary.getAttribute('aria-busy')).toBe('true')
    // Still up while the launcher is asked; a second press does nothing.
    click(primary)
    expect(cmd).toHaveBeenCalledTimes(1)
    expect(uiStore.get().install).not.toBeNull()
    settlePin!()
    await settle()
    expect(uiStore.get().install).toBeNull()
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
  })

  it('Cancel and Escape report a cancelled install and close the dialog', () => {
    uiStore.set({ install: APP_PROMPT })
    const el = render(layer(stateWith('t1')))
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    click(cancel)
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(uiStore.get().install).toBeNull()

    vi.mocked(run).mockClear()
    uiStore.set({ install: APP_PROMPT })
    rerender(layer(stateWith('t1')))
    const dialog = el.querySelector('[data-install-dialog]')!
    keydown(dialog, 'Escape')
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(uiStore.get().install).toBeNull()
  })

  it('goes with its tab: another tab active cancels an install not yet taken', () => {
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    rerender(layer(stateWith('t2')))
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(uiStore.get().install).toBeNull()
  })

  it('does not cancel an install that was taken when the tab moves into its app window', async () => {
    uiStore.set({ install: APP_PROMPT })
    const el = render(layer(stateWith('t1')))
    click(el.querySelector('[data-accept]'))
    // The core moved the tab into the new app window before the pin resolved.
    rerender(layer(stateWith(null)))
    await settle()
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
    expect(uiStore.get().install).toBeNull()
  })
})

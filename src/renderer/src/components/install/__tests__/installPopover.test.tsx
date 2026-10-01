// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState, WebAppBanner, WebAppInstallPrompt } from '@shared/types'
import type { WebAppInfo } from '@shared/webApp'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import { autoOpenInstall, resetInstallOffers, retireInstallOffer } from '@renderer/lib/installOffer'
import { FrameDialogHost, closeAllPopovers } from '@renderer/lib/portals'
import { bannerSurfaceMounted, uiStore } from '@renderer/lib/ui'
import { InstallPopoverLayer } from '../InstallPopover'

/*
 * The desktop's install surface in Chrome's form (install/InstallPopover.tsx; the Design Lead's
 * ruling on W8-M3's item 3): the install surface of a host with windows – registered through
 * `ui.surface` there and never on a one-window host – is the 320 popover hung from the pill's
 * Install chip for a page with an installable manifest: "Install <name>?" over the app's
 * identity row, Cancel then Install, no scrim. Opened by the user it focuses Install (§5.7, the
 * Lead's gate on #754) and Escape hands the keyboard back to the chip; Install goes busy while
 * `webapp.pin` is out and
 * the popover leaves once it has settled; Cancel, Escape and a press outside report a cancelled
 * install and fold the popover back into the chip; the popover goes with its tab, cancelling an
 * install not yet taken. A page without an installable manifest keeps the "Create shortcut"
 * frame dialog (install/ShortcutDialog.tsx): a name field armed with the page's title, "Create".
 *
 * The same popover is the desktop's card for the core's install banner (`lib/installOffer.ts`;
 * Services' seed #42, the cooldown through the core): the layer claims the banner surface while
 * mounted, the popover opens on `webapp.banner` of its own accord – taking no focus – and the
 * core hears the card drawn in the same tick (`webapp.bannerShown`); its Cancel is the card's
 * swipe, a light dismissal or the tab leaving its clock running out (`webapp.dismissBanner`),
 * Install the install path of old, and the core's own take-down sends nothing back. The prompt
 * the user asks for sends no such word.
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
  screenshots: [
    {
      src: 'https://app.example/shot.png',
      sizes: '1280x720',
      type: 'image/png',
      formFactor: 'wide'
    }
  ],
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

/** The core's banner for the app (`webapp.banner`): the launcher's name, the page's origin. */
const OFFER: WebAppBanner = {
  tabId: 't1',
  name: 'Example App',
  origin: 'app.example',
  icon: null,
  tint: null
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
let pill: HTMLElement | null = null
let chip: HTMLButtonElement | null = null

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
      <InstallPopoverLayer state={state} />
    </FrameDialogHost>
  )
}

/** The pill's Install chip in its pill, standing in for the address pill: the popover's anchor. */
function placeChip(): void {
  pill = document.createElement('div')
  pill.className = 'zen-pill'
  pill.getBoundingClientRect = () =>
    ({ x: 8, y: 8, left: 8, top: 8, width: 400, height: 32, right: 408, bottom: 40 }) as DOMRect
  chip = document.createElement('button')
  chip.setAttribute('data-pill-chip', '')
  chip.setAttribute('data-install-chip', '')
  chip.getBoundingClientRect = () =>
    ({
      x: 300,
      y: 12,
      left: 300,
      top: 12,
      width: 24,
      height: 24,
      right: 324,
      bottom: 36
    }) as DOMRect
  pill.appendChild(chip)
  document.body.appendChild(pill)
}

const popover = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-install-popover]')

const buttons = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent ?? '')

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A press on `target`: down and up, then the click the browser synthesises. */
function press(target: Element): { down: PointerEvent; click: MouseEvent } {
  const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
  const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true })
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(down)
    target.dispatchEvent(up)
    target.dispatchEvent(click)
  })
  return { down, click }
}

function keydown(target: Element | null, key: string): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const escape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  })
}

/** The popover's first paint settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The offer's capture came back and its popover painted. */
async function opened(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const calls = (): unknown[][] => vi.mocked(run).mock.calls.map((c) => [...c])
const cancelButton = (el: HTMLElement): HTMLButtonElement =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!

/**
 * The popover's leave, drawn: the collapse ends on its transition (dispatched here, as no
 * compositor runs) and the spring on its frames, each under `act` so React draws the removal.
 */
async function leave(): Promise<void> {
  const el = popover()
  if (el?.hasAttribute('data-collapsing')) {
    act(() => {
      el.dispatchEvent(new Event('transitionend'))
    })
  }
  for (let i = 0; i < 40 && popover(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  }
  expect(popover()).toBeNull()
}

beforeEach(() => {
  uiStore.set({ install: null, snapshot: null, snapshotTabId: null })
  resetInstallOffers()
  placeChip()
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  pill?.remove()
  root = null
  mount = null
  pill = null
  chip = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ install: null, snapshot: null, snapshotTabId: null })
  resetInstallOffers()
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('InstallPopoverLayer as the install surface', () => {
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
    expect(popover()).toBeNull()
    expect(el.querySelector('[data-install-dialog]')).toBeNull()
  })
})

describe('the install popover', () => {
  it('is Chrome’s form: a 320 popover under the chip, "Install <name>?" over the app’s identity row, Cancel then Install, no scrim', async () => {
    uiStore.set({ install: APP_PROMPT })
    const el = render(layer(stateWith('t1')))
    await settle()
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    // In the chrome layer, hung from the pill – not a frame dialog, and no scrim drawn for it.
    expect(dialog.closest('#zen-chrome-layer')).not.toBeNull()
    expect(el.querySelector('[data-install-dialog]')).toBeNull()
    expect(el.querySelector('.zen-frame-scrim')).toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.hasAttribute('aria-modal')).toBe(false)
    expect(dialog.getAttribute('aria-labelledby')).toBe('zen-install-title')
    // §9.20's list width: the 320 of the three.
    expect(dialog.style.width).toBe('320px')
    const title = dialog.querySelector<HTMLElement>('#zen-install-title')!
    expect(title.tagName).toBe('H2')
    expect(title.textContent).toBe('Install Example App?')
    // The identity row (§9.23): the tile beside the name and the origin; nothing of the
    // manifest's description or screenshots, which Chrome's simple prompt has no room for.
    expect(dialog.querySelector('.zen-install-app .zen-install-icon')).not.toBeNull()
    expect(dialog.querySelector('.zen-install-name')!.textContent).toBe('Example App')
    expect(dialog.querySelector('.zen-install-detail')!.textContent).toBe('app.example')
    expect(dialog.querySelector('.zen-install-description')).toBeNull()
    expect(dialog.querySelector('.zen-install-shots')).toBeNull()
    expect(dialog.querySelector('input')).toBeNull()
    // The §9.11 footer: hugging, the primary last, in the prompt form with no hairline.
    expect(buttons(dialog)).toEqual(['Cancel', 'Install'])
    expect(dialog.querySelector('[data-footer]')!.getAttribute('data-footer')).toBe('prompt')
    const primary = dialog.querySelector<HTMLButtonElement>('[data-accept]')!
    expect(primary.textContent).toBe('Install')
    expect(primary.hasAttribute('data-primary')).toBe(true)
    expect(dialog.querySelectorAll('[data-primary]')).toHaveLength(1)
    // Opened by the user (the chip, the app menu): the keyboard lands on Install, the primary –
    // the open was the intent and Enter completes it (§5.7; the Lead's gate on #754) – and no
    // word of a drawn card goes to the core: the prompt is the user's, not the banner's.
    expect(dialog.hasAttribute('data-offered')).toBe(false)
    expect(document.activeElement).toBe(primary)
    expect(document.activeElement).not.toBe(dialog.querySelector('button'))
    expect(run).not.toHaveBeenCalledWith('webapp.bannerShown', expect.anything())
  })

  it('"Install" pins through the core with the app’s name, busy meanwhile, and the popover leaves once it settled', async () => {
    let settlePin: (() => void) | null = null
    vi.mocked(cmd).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          settlePin = () => resolve(null)
        }) as never
    )
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    await settle()
    const primary = popover()!.querySelector<HTMLButtonElement>('[data-accept]')!
    click(primary)
    expect(cmd).toHaveBeenCalledWith('webapp.pin', { tabId: 't1', title: 'Example App' })
    expect(primary.getAttribute('aria-busy')).toBe('true')
    // Still up while the launcher is asked; a second press does nothing.
    click(primary)
    expect(cmd).toHaveBeenCalledTimes(1)
    expect(uiStore.get().install).not.toBeNull()
    settlePin!()
    await settle()
    // Done: it leaves on the spring, not the collapse – nothing was refused.
    expect(popover()?.hasAttribute('data-collapsing')).not.toBe(true)
    await leave()
    expect(uiStore.get().install).toBeNull()
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
  })

  it('Cancel reports a cancelled install and folds the popover back into the chip', async () => {
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    await settle()
    const dialog = popover()!
    const cancel = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    )!
    click(cancel)
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    // The pop reversed toward the chip (§9.20): the popover is collapsing, not springing out.
    expect(dialog.hasAttribute('data-collapsing')).toBe(true)
    await leave()
    expect(uiStore.get().install).toBeNull()
  })

  it('is light-dismissed: Escape cancels and hands the keyboard back to the chip; a press outside cancels and is consumed', async () => {
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    await settle()
    escape()
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    await leave()
    expect(uiStore.get().install).toBeNull()
    // The keyboard went to the chip it hung from, not the page (§9.22).
    expect(document.activeElement).toBe(chip)
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)

    vi.mocked(run).mockClear()
    uiStore.set({ install: APP_PROMPT })
    rerender(layer(stateWith('t1')))
    await settle()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const { down, click: tap } = press(outside)
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(down.defaultPrevented).toBe(true)
    expect(tap.defaultPrevented).toBe(true)
    await leave()
    expect(uiStore.get().install).toBeNull()
    outside.remove()
  })

  it('goes with its tab: another tab active cancels an install not yet taken', async () => {
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    await settle()
    rerender(layer(stateWith('t2')))
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    await leave()
    expect(uiStore.get().install).toBeNull()
  })

  it('does not cancel an install that was taken when the tab moves into its app window', async () => {
    uiStore.set({ install: APP_PROMPT })
    render(layer(stateWith('t1')))
    await settle()
    click(popover()!.querySelector('[data-accept]'))
    // The core moved the tab into the new app window before the pin resolved.
    rerender(layer(stateWith(null)))
    await settle()
    await leave()
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
    expect(uiStore.get().install).toBeNull()
  })
})

describe('the popover as the core’s install banner (seed #42: the cooldown through the core)', () => {
  it('claims the banner surface while mounted on a host with windows, and releases it on unmount', () => {
    expect(bannerSurfaceMounted()).toBe(false)
    render(layer(stateWith('t1')))
    expect(bannerSurfaceMounted()).toBe(true)
    act(() => root!.unmount())
    root = null
    expect(bannerSurfaceMounted()).toBe(false)
    // A one-window host's surface is the phone's layer, which claims for itself.
    render(layer(stateWith('t1', false)))
    expect(bannerSurfaceMounted()).toBe(false)
  })

  it('opens on the core’s banner of its own accord, telling the core the card is drawn in the same tick, marked the offer’s and taking no focus (§9.6)', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    // The word goes with the banner's tick, not the popover's paint.
    expect(calls()).toContainEqual(['webapp.bannerShown', { tabId: 't1' }])
    expect(popover()).toBeNull()
    await opened()
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    expect(dialog.hasAttribute('data-offered')).toBe(true)
    expect(dialog.querySelector('#zen-install-title')!.textContent).toBe('Install Example App?')
    expect(dialog.querySelector('.zen-install-name')!.textContent).toBe('Example App')
    expect(dialog.querySelector('.zen-install-detail')!.textContent).toBe('app.example')
    expect(buttons(dialog)).toEqual(['Cancel', 'Install'])
    expect(dialog.contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(dialog)
    // Over the page's picture, with the chrome holding the keys (the same as the prompt).
    expect(uiStore.get().snapshotTabId).toBe('t1')
    expect(calls()).toContainEqual(['focus.chrome', undefined])
    // Not the user's install: nothing opened through `webapp.openInstall`.
    expect(run).not.toHaveBeenCalledWith('webapp.openInstall', expect.anything())
    expect(uiStore.get().install).toBeNull()
  })

  it('a second banner for the same tab while the popover is up changes nothing', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    const dialog = popover()!
    vi.mocked(run).mockClear()
    act(() => autoOpenInstall({ ...OFFER, name: 'Example App (again)' }))
    await opened()
    expect(popover()).toBe(dialog)
    expect(dialog.querySelector('#zen-install-title')!.textContent).toBe('Install Example App?')
    // The new banner's grace is answered all the same, as the phone's replaced card answers.
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
  })

  it('Cancel is the banner’s swipe: the core hears the refusal, and the popover folds back into the chip', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    const dialog = popover()!
    vi.mocked(run).mockClear()
    click(cancelButton(dialog))
    expect(calls()).toEqual([['webapp.dismissBanner', { tabId: 't1', reason: 'swipe' }]])
    expect(dialog.hasAttribute('data-collapsing')).toBe(true)
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
    // The page comes back, with the keyboard.
    expect(uiStore.get().snapshotTabId).toBeNull()
    expect(calls()).toContainEqual(['focus.content', undefined])
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
  })

  it('Escape and a press outside are the banner’s clock running out: no refusal, the stamp stands', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    vi.mocked(run).mockClear()
    escape()
    expect(calls()).toEqual([['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }]])
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
    // The popover took no focus, so Escape hands nothing to the chip: the page gets the keys.
    expect(document.activeElement).not.toBe(chip)
    expect(calls()).toContainEqual(['focus.content', undefined])

    vi.mocked(run).mockClear()
    act(() => autoOpenInstall(OFFER))
    await opened()
    expect(popover()).not.toBeNull()
    vi.mocked(run).mockClear()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const { down, click: tap } = press(outside)
    expect(calls()).toEqual([['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }]])
    expect(down.defaultPrevented).toBe(true)
    expect(tap.defaultPrevented).toBe(true)
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
    outside.remove()
  })

  it('"Install" runs the install path of old – `webapp.pin` with the app’s name – and the popover leaves with no refusal once it settled', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    vi.mocked(run).mockClear()
    vi.mocked(cmd).mockClear()
    // The pin is out until the launcher answers (the capture before it has come back already).
    let settlePin: (() => void) | null = null
    vi.mocked(cmd).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          settlePin = () => resolve(null)
        }) as never
    )
    const primary = popover()!.querySelector<HTMLButtonElement>('[data-accept]')!
    click(primary)
    expect(cmd).toHaveBeenCalledWith('webapp.pin', { tabId: 't1', title: 'Example App' })
    expect(primary.getAttribute('aria-busy')).toBe('true')
    click(primary)
    expect(cmd).toHaveBeenCalledTimes(1)
    expect(calls()).toEqual([])
    settlePin!()
    await settle()
    // Gone on the spring, not the collapse; the core hears the card went, nothing refused.
    expect(popover()?.hasAttribute('data-collapsing')).not.toBe(true)
    expect(calls()).toContainEqual(['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }])
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
    expect(run).not.toHaveBeenCalledWith('webapp.dismissBanner', { tabId: 't1', reason: 'swipe' })
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
  })

  it('goes with its tab, as the clock running out: another tab active is no refusal', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    vi.mocked(run).mockClear()
    rerender(layer(stateWith('t2')))
    expect(calls()).toEqual([['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }]])
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
  })

  it('the core’s own take-down (`webapp.bannerHide`) sends it away with no report', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    vi.mocked(run).mockClear()
    act(() => retireInstallOffer('t1'))
    await settle()
    expect(popover()?.hasAttribute('data-collapsing')).not.toBe(true)
    await leave()
    expect(uiStore.get().installOffer).toBeNull()
    expect(run).not.toHaveBeenCalledWith('webapp.dismissBanner', expect.anything())
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
    expect(calls()).toContainEqual(['focus.content', undefined])
  })

  it('gives way to the prompt the user asks for: the chip’s own open shows the user’s popover, which focuses Install', async () => {
    render(layer(stateWith('t1')))
    act(() => autoOpenInstall(OFFER))
    await opened()
    expect(popover()!.hasAttribute('data-offered')).toBe(true)
    // The core took the banner back as the install opened, and sent the prompt.
    act(() => retireInstallOffer('t1'))
    act(() => uiStore.set({ install: APP_PROMPT, installOffer: null }))
    await settle()
    const dialog = popover()!
    expect(dialog.hasAttribute('data-offered')).toBe(false)
    expect(document.activeElement).toBe(dialog.querySelector('[data-accept]'))
    expect(uiStore.get().installOffer).toBeNull()
  })
})

describe('the "Create shortcut" dialog for a page without an installable manifest', () => {
  it('stands as the frame dialog it was – a name field with the page title, Create – with the field focused', () => {
    uiStore.set({ install: PAGE_PROMPT })
    const el = render(layer(stateWith('t1')))
    expect(popover()).toBeNull()
    const dialog = el.querySelector<HTMLElement>('[data-install-dialog="shortcut"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.style.width).toBe('400px')
    expect(dialog.querySelector('h2')!.textContent).toBe('Create shortcut')
    const field = dialog.querySelector<HTMLInputElement>('input')!
    expect(field.value).toBe('A plain page')
    expect(dialog.querySelector('label')!.textContent).toBe('Name')
    expect(dialog.querySelector('.zen-v2-field-message')!.textContent).toBe('app.example')
    expect(dialog.querySelector('[data-accept]')!.textContent).toBe('Create')
    expect(document.activeElement).toBe(field)
  })

  it('"Create" pins through the core with the edited name, busy meanwhile, and the dialog leaves once it settled', async () => {
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
    click(primary)
    expect(cmd).toHaveBeenCalledTimes(1)
    expect(uiStore.get().install).not.toBeNull()
    settlePin!()
    await settle()
    expect(uiStore.get().install).toBeNull()
    expect(run).not.toHaveBeenCalledWith('webapp.cancelInstall', expect.anything())
  })

  it('Cancel and Escape report a cancelled install and close the dialog', () => {
    uiStore.set({ install: PAGE_PROMPT })
    const el = render(layer(stateWith('t1')))
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    click(cancel)
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(uiStore.get().install).toBeNull()

    vi.mocked(run).mockClear()
    uiStore.set({ install: PAGE_PROMPT })
    rerender(layer(stateWith('t1')))
    keydown(el.querySelector('[data-install-dialog]'), 'Escape')
    expect(run).toHaveBeenCalledWith('webapp.cancelInstall', { tabId: 't1' })
    expect(uiStore.get().install).toBeNull()
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DeviceChooser, DevicePairingPrompt, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { FrameDialogHost, closeAllPopovers } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { DeviceChooserLayer } from '../DeviceChooserDialog'

/*
 * The device chooser (components/devices/DeviceChooserDialog.tsx, MW-32..35) on the chassis
 * prompt in its picker form: Chrome's "<site> wants to connect to a <kind>" over the active
 * tab's request – the host never elided, the kind's glyph in the title block – with the live
 * list as a radio list, a row per candidate with its detail, the pick `aria-checked` with a
 * trailing check, Connect at .4 until there is a pick, a double-click or Enter on the pick
 * connecting; the states under the list – scanning (§9.30), empty (§9.17) with the udev notice
 * on Linux; the keyboard the prompt's (§9.22): the container at the open, Tab to the one roving
 * stop, the arrows moving the pick, Enter from the container as Connect once there is a pick,
 * Escape, Cancel and the scrim answering the core with nothing, once. The Bluetooth pairing
 * prompt is a second dialog over it (§9.24: the chooser inert and the 320 notice whatever the
 * prompt carries) or alone, in its three forms; Pair is its default. The page gives way to its
 * picture and the chrome holds the keyboard while either is up (`deviceChooserOpen`).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHOOSER: DeviceChooser = {
  id: 'ch-1',
  tabId: 't1',
  origin: 'https://web.flasher.example',
  kind: 'usb',
  candidates: [
    { id: 'usb-1', name: 'Arduino Uno', detail: '2341:0043' },
    { id: 'usb-2', name: 'FT232R USB UART', detail: '' },
    { id: 'usb-3', name: 'Programmer', detail: 'Serial A50285BI' }
  ],
  scanning: false,
  hint: 'none',
  requestedAt: 1
}

const BLUETOOTH: DeviceChooser = {
  ...CHOOSER,
  id: 'ch-2',
  origin: 'https://fit.example',
  kind: 'bluetooth',
  candidates: [{ id: 'bt-1', name: 'Heart Rate Monitor', detail: 'C4:7C:8D:12:34:56' }],
  scanning: true
}

const PAIRING: DevicePairingPrompt = {
  id: 'pair-1',
  tabId: 't1',
  deviceId: 'bt-1',
  deviceName: 'Heart Rate Monitor',
  kind: 'confirm',
  pin: ''
}

function stateWith(
  choosers: DeviceChooser[],
  pairings: DevicePairingPrompt[] = [],
  activeTabId = 't1'
): UIState {
  return {
    platform: 'linux',
    tabs: {
      t1: { id: 't1', url: 'https://web.flasher.example/' },
      t2: { id: 't2', url: 'https://docs.example/' }
    },
    spaces: [{ id: 'space', activeTabId }],
    activeSpaceId: 'space',
    deviceChoosers: choosers,
    devicePairings: pairings,
    deviceGrants: []
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
      <DeviceChooserLayer state={state} />
    </FrameDialogHost>
  )
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function dblclick(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
}

/** A key press on `from`; the event comes back, `defaultPrevented` when the dialog answered it. */
function press(from: Element | null, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    from?.dispatchEvent(e)
  })
  return e
}

const pressEscape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

const pressScrim = (): void => {
  act(() => {
    document
      .querySelector('.zen-frame-scrim')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
}

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    // Past React's value tracker, so the change registers.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const chooser = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-confirm="device-chooser"]:not([data-leaving])')
const pairing = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-confirm="device-pairing"]:not([data-leaving])')
const rows = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('[role="radio"]')
]
const row = (scope: ParentNode, id: string): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>(`[role="radio"][data-device-id="${id}"]`)
const cancelOf = (scope: ParentNode): HTMLButtonElement =>
  scope.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
const verbOf = (scope: ParentNode): HTMLButtonElement =>
  scope.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
/** The verb before it is an answer (§9.30): `aria-disabled` on the desktop primitive, never `disabled`. */
const waiting = (scope: ParentNode): boolean => {
  const verb = verbOf(scope)
  expect(verb.disabled).toBe(false)
  return verb.getAttribute('aria-disabled') === 'true'
}
const responses = (): unknown[][] =>
  vi.mocked(run).mock.calls.filter(([c]) => c === 'devices.respond')
const pairingResponses = (): unknown[][] =>
  vi.mocked(run).mock.calls.filter(([c]) => c === 'devices.respondPairing')

beforeEach(() => {
  uiStore.set({ deviceChooserOpen: false })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  document.body.innerHTML = ''
  closeAllPopovers()
  uiStore.set({ deviceChooserOpen: false })
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('DeviceChooserLayer', () => {
  it('shows the active tab’s request only, and takes the page’s keyboard while it is up', async () => {
    render(layer(stateWith([CHOOSER], [], 't2')))
    await settle()
    expect(chooser()).toBeNull()
    expect(uiStore.get().deviceChooserOpen).toBe(false)
    rerender(layer(stateWith([CHOOSER])))
    await settle()
    expect(chooser()).not.toBeNull()
    expect(uiStore.get().deviceChooserOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('gives the page back when the core takes the request away, answering nothing of its own', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    expect(uiStore.get().deviceChooserOpen).toBe(true)
    rerender(layer(stateWith([])))
    await settle()
    expect(chooser()).toBeNull()
    expect(uiStore.get().deviceChooserOpen).toBe(false)
    expect(responses()).toHaveLength(0)
  })
})

describe('the chooser', () => {
  it('is the picker form of the chassis prompt (PickerDialog) at 400: role dialog, Chrome’s title with the host apart and the kind’s glyph, the radio list in the body slot, Cancel then Connect at .4', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.dataset.deviceKind).toBe('usb')
    expect(d.dataset.deviceChooser).toBe('ch-1')
    expect(d.style.width).toBe('400px')
    expect(d.dataset.body).toBe('list')
    expect(d.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    // The list is the body slot's one element – the primitive's scroller, not one of its own.
    const slot = d.querySelector<HTMLElement>('.zen-confirm-dialog-slot')!
    expect(slot.firstElementChild!.classList.contains('zen-device-chooser')).toBe(true)
    expect(slot.children).toHaveLength(1)
    const title = d.querySelector<HTMLElement>('.zen-v2-title-block-title')!
    expect(title.textContent).toBe('web.flasher.example wants to connect to a USB device')
    // The glyph leads the title; the host is its own span with a break after each dot.
    expect(title.firstElementChild!.tagName.toLowerCase()).toBe('svg')
    const host = title.querySelector<HTMLElement>('.zen-device-chooser-host')!
    expect(host.textContent).toBe('web.flasher.example')
    expect(host.querySelectorAll('wbr')).toHaveLength(2)
    expect(d.querySelector('.zen-v2-title-block-description')).toBeNull()
    // The list: one radio row per candidate, the kind's glyph leading, the detail as the
    // second line where the engine gave one, nothing picked.
    const list = d.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(list.getAttribute('aria-label')).toBe('Devices')
    expect(list.hasAttribute('aria-busy')).toBe(false)
    const cards = rows(d)
    expect(cards.map((r) => r.dataset.deviceId)).toEqual(['usb-1', 'usb-2', 'usb-3'])
    expect(cards.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(cards.every((r) => r.classList.contains('zen-v2-row'))).toBe(true)
    expect(cards[0]!.querySelector('.zen-v2-label')!.textContent).toBe('Arduino Uno')
    expect(cards[0]!.querySelector('.zen-v2-description')!.textContent).toBe('2341:0043')
    expect(cards[0]!.dataset.lines).toBe('2')
    expect(cards[0]!.querySelector('svg.zen-v2-row-lead')).not.toBeNull()
    expect(cards[1]!.querySelector('.zen-v2-description')).toBeNull()
    expect(cards[1]!.hasAttribute('data-lines')).toBe(false)
    expect(d.querySelector('.zen-v2-row-trail')).toBeNull()
    // No state line under a settled list.
    expect(d.querySelector('.zen-device-chooser-scanning')).toBeNull()
    expect(d.querySelector('.zen-device-chooser-empty')).toBeNull()
    // The footer: Cancel and Connect, the one primary, waiting for a pick.
    expect(cancelOf(d).textContent).toBe('Cancel')
    expect(verbOf(d).textContent).toBe('Connect')
    expect(verbOf(d).hasAttribute('data-primary')).toBe(true)
    expect(waiting(d)).toBe(true)
    expect(d.querySelectorAll('[data-primary]')).toHaveLength(1)
  })

  it('holds the keyboard on the container as it opens, then Tab reaches the list at its one roving stop, then Cancel, then Connect', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    expect(document.activeElement).toBe(d)
    expect(d.tabIndex).toBe(-1)
    const cards = rows(d)
    expect(cards.map((r) => r.tabIndex)).toEqual([0, -1, -1])
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cards[0])
    // Shift+Tab from the container goes to the last control, the verb: waiting for a pick it is
    // `aria-disabled`, still in the tab order (§9.30), so the wrap does not shift as a pick arms it.
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verbOf(d))
    expect(waiting(d)).toBe(true)
    // A press on the waiting verb is nothing.
    click(verbOf(d))
    expect(responses()).toHaveLength(0)
    // A pick moves the stop to the picked row.
    click(cards[2])
    expect(rows(d).map((r) => r.tabIndex)).toEqual([-1, -1, 0])
    expect(waiting(d)).toBe(false)
    // Shift+Tab from the container still lands on Connect, armed now.
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verbOf(d))
    // Tab from Connect wraps to the row.
    expect(press(verbOf(d), 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cards[2])
  })

  it('picks with a click – the row aria-checked with a trailing check, Connect armed – and Connect answers the core with the device, once', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    click(row(d, 'usb-2'))
    expect(row(d, 'usb-2')!.getAttribute('aria-checked')).toBe('true')
    expect(row(d, 'usb-1')!.getAttribute('aria-checked')).toBe('false')
    expect(row(d, 'usb-2')!.querySelector('svg.zen-v2-row-trail')).not.toBeNull()
    expect(d.querySelectorAll('.zen-v2-row-trail')).toHaveLength(1)
    expect(waiting(d)).toBe(false)
    // Another click moves the pick; the pick is one.
    click(row(d, 'usb-1'))
    expect(row(d, 'usb-1')!.getAttribute('aria-checked')).toBe('true')
    expect(row(d, 'usb-2')!.getAttribute('aria-checked')).toBe('false')
    click(verbOf(d))
    expect(run).toHaveBeenCalledWith('devices.respond', { id: 'ch-1', deviceId: 'usb-1' })
    click(verbOf(d))
    click(cancelOf(d))
    expect(responses()).toHaveLength(1)
  })

  it('a double-click on a row is the pick and Connect at once, as Chrome’s chooser does', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    dblclick(row(chooser()!, 'usb-3'))
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: 'usb-3' }]])
  })

  it('the arrow keys move the pick and the focus with it; Enter on the pick connects, on another row picks it', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    const first = row(d, 'usb-1')!
    act(() => first.focus())
    expect(press(first, 'ArrowDown').defaultPrevented).toBe(true)
    expect(row(d, 'usb-2')!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(row(d, 'usb-2'))
    expect(press(row(d, 'usb-2'), 'End').defaultPrevented).toBe(true)
    expect(row(d, 'usb-3')!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(row(d, 'usb-3'))
    // Off the end nothing moves.
    expect(press(row(d, 'usb-3'), 'ArrowDown').defaultPrevented).toBe(false)
    expect(row(d, 'usb-3')!.getAttribute('aria-checked')).toBe('true')
    expect(press(row(d, 'usb-3'), 'Home').defaultPrevented).toBe(true)
    expect(row(d, 'usb-1')!.getAttribute('aria-checked')).toBe('true')
    // Enter on a row that is not the pick picks it; on the pick it is Connect.
    expect(press(row(d, 'usb-2'), 'Enter').defaultPrevented).toBe(true)
    expect(row(d, 'usb-2')!.getAttribute('aria-checked')).toBe('true')
    expect(responses()).toHaveLength(0)
    expect(press(row(d, 'usb-2'), 'Enter').defaultPrevented).toBe(true)
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: 'usb-2' }]])
  })

  it('Enter from the container is nothing while there is no pick, and Connect once there is one', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(responses()).toHaveLength(0)
    click(row(d, 'usb-1'))
    act(() => d.focus())
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: 'usb-1' }]])
  })

  it('Cancel, Escape and the scrim answer the core with no device – the page’s NotFoundError – once', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    click(cancelOf(chooser()!))
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: null }]])
    pressEscape()
    pressScrim()
    expect(responses()).toHaveLength(1)
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    render(layer(stateWith([CHOOSER])))
    await settle()
    pressEscape()
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: null }]])
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    render(layer(stateWith([CHOOSER])))
    await settle()
    pressScrim()
    expect(responses()).toEqual([['devices.respond', { id: 'ch-1', deviceId: null }]])
  })

  it('follows the live list: a pick the host takes away leaves nothing picked and Connect waiting again; new rows join in place', async () => {
    render(layer(stateWith([CHOOSER])))
    await settle()
    const d = chooser()!
    click(row(d, 'usb-2'))
    expect(waiting(d)).toBe(false)
    rerender(
      layer(
        stateWith([{ ...CHOOSER, candidates: CHOOSER.candidates.filter((c) => c.id !== 'usb-2') }])
      )
    )
    expect(rows(d).map((r) => r.dataset.deviceId)).toEqual(['usb-1', 'usb-3'])
    expect(rows(d).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(waiting(d)).toBe(true)
    // The stop goes back to the first row.
    expect(rows(d).map((r) => r.tabIndex)).toEqual([0, -1])
    rerender(
      layer(
        stateWith([
          {
            ...CHOOSER,
            candidates: [...CHOOSER.candidates, { id: 'usb-4', name: 'New', detail: '' }]
          }
        ])
      )
    )
    expect(rows(d).map((r) => r.dataset.deviceId)).toEqual(['usb-1', 'usb-2', 'usb-3', 'usb-4'])
  })

  it('a Bluetooth list still growing says so under the rows with the spinner, the list aria-busy; the rows are there to pick meanwhile', async () => {
    render(layer(stateWith([BLUETOOTH])))
    await settle()
    const d = chooser()!
    expect(d.dataset.deviceKind).toBe('bluetooth')
    expect(d.querySelector('.zen-v2-title-block-title')!.textContent).toBe(
      'fit.example wants to connect to a Bluetooth device'
    )
    expect(d.querySelector('.zen-device-chooser')!.getAttribute('data-scanning')).toBe('true')
    expect(d.querySelector('[role="radiogroup"]')!.getAttribute('aria-busy')).toBe('true')
    const scanning = d.querySelector<HTMLElement>('.zen-device-chooser-scanning')!
    expect(scanning.getAttribute('role')).toBe('status')
    expect(scanning.querySelector('.zen-v2-spinner')).not.toBeNull()
    expect(scanning.textContent).toBe('Looking for devices…')
    expect(d.querySelector('.zen-device-chooser-empty')).toBeNull()
    click(row(d, 'bt-1'))
    expect(waiting(d)).toBe(false)
    // The scan done: the line goes, the rows stay.
    rerender(layer(stateWith([{ ...BLUETOOTH, scanning: false }])))
    expect(d.querySelector('.zen-device-chooser-scanning')).toBeNull()
    expect(d.querySelector('[role="radiogroup"]')!.hasAttribute('aria-busy')).toBe(false)
    expect(row(d, 'bt-1')!.getAttribute('aria-checked')).toBe('true')
  })

  it('an empty list scanning shows the spinner line alone, then §9.17’s one sentence once the scan is done', async () => {
    render(layer(stateWith([{ ...BLUETOOTH, candidates: [] }])))
    await settle()
    const d = chooser()!
    expect(d.querySelector('[role="radiogroup"]')).toBeNull()
    expect(d.querySelector('.zen-device-chooser-scanning')).not.toBeNull()
    expect(d.querySelector('.zen-device-chooser-empty')).toBeNull()
    expect(waiting(d)).toBe(true)
    rerender(layer(stateWith([{ ...BLUETOOTH, candidates: [], scanning: false }])))
    expect(d.querySelector('.zen-device-chooser-scanning')).toBeNull()
    const empty = d.querySelector<HTMLElement>('.zen-device-chooser-empty')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(empty.querySelector('.zen-device-chooser-empty-line')!.textContent).toBe(
      'No compatible devices found'
    )
    expect(empty.querySelector('.zen-device-chooser-notice')).toBeNull()
    expect(d.querySelector('.zen-device-chooser')!.getAttribute('data-empty')).toBe('true')
    // Tab from the container with no rows: Cancel is the first control.
    act(() => d.focus())
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancelOf(d))
  })

  it('on Linux the empty state carries Chrome’s udev notice under its sentence (hint linux-udev), and nothing where the host said none', async () => {
    render(layer(stateWith([{ ...CHOOSER, candidates: [], hint: 'linux-udev' }])))
    await settle()
    const d = chooser()!
    const empty = d.querySelector<HTMLElement>('.zen-device-chooser-empty')!
    expect(empty.querySelector('.zen-device-chooser-empty-line')!.textContent).toBe(
      'No compatible devices found'
    )
    expect(empty.querySelector('.zen-device-chooser-notice')!.textContent).toBe(
      'On Linux, a udev rule may be needed for this device'
    )
    expect(waiting(d)).toBe(true)
    rerender(layer(stateWith([{ ...CHOOSER, candidates: [], hint: 'none' }])))
    expect(d.querySelector('.zen-device-chooser-notice')).toBeNull()
  })
})

describe('the pairing prompt', () => {
  it('alone, confirm: the 320 notice as an alertdialog – "Pair with <device>", one sentence, Cancel then Pair the primary; Enter from the container is Pair, Cancel sends null', async () => {
    render(layer(stateWith([], [PAIRING])))
    await settle()
    expect(uiStore.get().deviceChooserOpen).toBe(true)
    const p = pairing()!
    expect(p.getAttribute('role')).toBe('alertdialog')
    expect(p.dataset.pairingKind).toBe('confirm')
    expect(p.dataset.devicePairing).toBe('pair-1')
    expect(p.style.width).toBe('320px')
    expect(p.querySelector('.zen-v2-title-block-title')!.textContent).toBe(
      'Pair with Heart Rate Monitor'
    )
    expect(p.querySelector('.zen-v2-title-block-title svg')).not.toBeNull()
    expect(p.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'Heart Rate Monitor wants to pair with this computer.'
    )
    expect(p.querySelector('input')).toBeNull()
    expect(p.querySelector('.zen-device-pairing-pin')).toBeNull()
    expect(verbOf(p).textContent).toBe('Pair')
    expect(verbOf(p).hasAttribute('data-primary')).toBe(true)
    expect(waiting(p)).toBe(false)
    expect(document.activeElement).toBe(p)
    expect(press(p, 'Enter').defaultPrevented).toBe(true)
    expect(pairingResponses()).toEqual([
      ['devices.respondPairing', { id: 'pair-1', response: { confirmed: true } }]
    ])
    // Answered once: Cancel after it is nothing.
    click(cancelOf(p))
    expect(pairingResponses()).toHaveLength(1)
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    render(layer(stateWith([], [PAIRING])))
    await settle()
    click(cancelOf(pairing()!))
    expect(pairingResponses()).toEqual([
      ['devices.respondPairing', { id: 'pair-1', response: null }]
    ])
  })

  it('providePin: a dialog with the six-digit field holding the keyboard, digits only, Pair at .4 until six are in, Enter in the field as Pair', async () => {
    render(layer(stateWith([], [{ ...PAIRING, kind: 'providePin' }])))
    await settle()
    const p = pairing()!
    expect(p.getAttribute('role')).toBe('dialog')
    expect(p.dataset.pairingKind).toBe('providePin')
    // Alone it carries a field: §9.20's 400.
    expect(p.style.width).toBe('400px')
    expect(p.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'Enter the six-digit PIN shown on Heart Rate Monitor.'
    )
    const field = p.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(field)
    // The primitive's field (§9.12): named by its aria-label, no visible label, no placeholder.
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('aria-label')).toBe('PIN')
    expect(field.getAttribute('maxlength')).toBe('6')
    expect(field.hasAttribute('placeholder')).toBe(false)
    expect(p.querySelector('label')).toBeNull()
    expect(waiting(p)).toBe(true)
    type(field, '12a3')
    expect(field.value).toBe('123')
    expect(waiting(p)).toBe(true)
    // Enter short of six digits is swallowed and pairs nothing.
    expect(press(field, 'Enter').defaultPrevented).toBe(true)
    expect(pairingResponses()).toHaveLength(0)
    type(field, '1234567')
    expect(field.value).toBe('123456')
    expect(waiting(p)).toBe(false)
    expect(press(field, 'Enter').defaultPrevented).toBe(true)
    expect(pairingResponses()).toEqual([
      ['devices.respondPairing', { id: 'pair-1', response: { confirmed: true, pin: '123456' } }]
    ])
  })

  it('confirmPin: the device’s PIN shown at the title size to compare, read digit by digit, Cancel then Pair', async () => {
    render(layer(stateWith([], [{ ...PAIRING, kind: 'confirmPin', pin: '482913' }])))
    await settle()
    const p = pairing()!
    expect(p.getAttribute('role')).toBe('dialog')
    expect(p.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'Check that this PIN matches the one shown on Heart Rate Monitor.'
    )
    const pin = p.querySelector<HTMLElement>('.zen-device-pairing-pin')!
    // The figure is the body slot's one element (the picker form's), at 400 alone.
    expect(pin.parentElement!.classList.contains('zen-confirm-dialog-slot')).toBe(true)
    expect(p.style.width).toBe('400px')
    expect(pin.textContent).toBe('482913')
    expect(pin.getAttribute('aria-label')).toBe('PIN 4 8 2 9 1 3')
    expect(p.querySelector('input')).toBeNull()
    expect(waiting(p)).toBe(false)
    click(verbOf(p))
    expect(pairingResponses()).toEqual([
      ['devices.respondPairing', { id: 'pair-1', response: { confirmed: true } }]
    ])
  })

  it('over the chooser it is the later sibling at the 320 notice whatever it carries; the chooser is inert under it; Escape answers the prompt, not the chooser', async () => {
    render(layer(stateWith([BLUETOOTH], [{ ...PAIRING, kind: 'providePin' }])))
    await settle()
    const c = chooser()!
    const p = pairing()!
    expect(p.parentElement).toBe(c.parentElement)
    expect(p.previousElementSibling).toBe(c)
    expect(c.hasAttribute('inert')).toBe(true)
    expect(p.hasAttribute('inert')).toBe(false)
    expect(c.style.width).toBe('400px')
    expect(p.style.width).toBe('320px')
    expect(p.querySelector('input')).not.toBeNull()
    pressEscape()
    expect(pairingResponses()).toEqual([
      ['devices.respondPairing', { id: 'pair-1', response: null }]
    ])
    expect(responses()).toHaveLength(0)
    // The prompt answered and gone: the chooser is itself again, holding the keyboard, and the
    // page stays covered through the handoff.
    rerender(layer(stateWith([BLUETOOTH], [])))
    await settle()
    expect(pairing()).toBeNull()
    expect(c.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(c)
    expect(uiStore.get().deviceChooserOpen).toBe(true)
    pressEscape()
    expect(responses()).toEqual([['devices.respond', { id: 'ch-2', deviceId: null }]])
  })
})

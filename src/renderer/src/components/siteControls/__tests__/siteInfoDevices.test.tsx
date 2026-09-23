// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DeviceGrant, Tab, UIState } from '@shared/types'
import type { SiteInfoSnapshot } from '@shared/siteInfo'

/*
 * Site information for sound and devices (MW-32..35): the words (lib/siteInfoCopy.ts) – when the
 * Permissions level carries the Sound row, its value, the device rows per kind the site is
 * connected to, the overview's summary – then the desktop popover's rows against a fake grant
 * list: Sound as a menulist row beside the stored decisions, "USB devices — 2" leading to the
 * kind's devices and their Revoke (`devices.forget`), a kind with no grants showing nothing;
 * and the phone sheet's one row of this program, the Sound switch.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  deviceRows,
  permissionRows,
  permissionsSummary,
  showsSoundRow,
  soundChoice,
  deviceLevelKind,
  SITE_INFO_LEVELS
} = await import('@renderer/lib/siteInfoCopy')
const { SiteInfoPopover } = await import('../SiteInfoPopover')
const { SiteInfoLayer } = await import('../../siteinfo/SiteInfoSheet')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')

function tab(patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url: 'https://web.flasher.example/flash',
    title: 'Web Flasher',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    ...patch
  } as Tab
}

function grant(patch: Partial<DeviceGrant>): DeviceGrant {
  return {
    origin: 'https://web.flasher.example',
    kind: 'usb',
    deviceId: 'usb-1',
    name: 'Arduino Uno',
    vendorId: 0x2341,
    productId: 0x0043,
    serialNumber: null,
    grantedAt: 10,
    ...patch
  }
}

const GRANTS: DeviceGrant[] = [
  grant({}),
  grant({
    deviceId: 'usb-2',
    name: 'FT232R USB UART',
    vendorId: 0x0403,
    productId: 0x6001,
    grantedAt: 20
  }),
  grant({
    kind: 'bluetooth',
    deviceId: 'bt-1',
    name: 'Heart Rate Monitor',
    vendorId: null,
    productId: null,
    grantedAt: 30
  }),
  // Another site's grant: not this site's row.
  grant({ origin: 'https://ports.example', kind: 'serial', deviceId: 'port-1', name: 'Port' })
]

function snapshot(patch: Partial<SiteInfoSnapshot> = {}): SiteInfoSnapshot {
  return {
    tabId: 't1',
    url: 'https://web.flasher.example/flash',
    host: 'web.flasher.example',
    site: 'flasher.example',
    origin: 'https://web.flasher.example',
    containerId: 'default',
    security: { state: 'secure', certificate: null, mixedContent: null },
    cookies: { items: [], thirdParty: [] },
    storage: {
      usageBytes: null,
      quotaBytes: null,
      origins: [],
      localStorageItems: null,
      sessionStorageItems: null,
      serviceWorkers: null
    },
    permissions: [{ permission: 'camera', decision: 'allow' }],
    siteData: { state: 'default', pattern: null, addable: '[*.]flasher.example', default: 'allow' },
    blocking: { blockedCount: 0, enabled: true, excepted: false, available: false },
    isPrivate: false,
    ...patch
  } as SiteInfoSnapshot
}

function stateWith(patch: Partial<UIState> = {}): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true, requestBlocking: false, translate: false },
    tabs: { t1: tab() },
    spaces: [
      {
        id: 'space',
        name: 'Work',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: ['t1'],
        activeTabId: 't1',
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    containers: [],
    extensions: [],
    settings: { urlbarBehavior: 'normal', blocking: { level: 'balanced' } },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    bookmarks: [],
    downloads: [],
    blockedPopups: {},
    blocking: { enabled: false, siteExceptions: [] },
    translate: { available: false, tabs: {} },
    media: [],
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    deviceGrants: GRANTS,
    deviceChoosers: [],
    devicePairings: [],
    permissionRules: [],
    permissionDefaults: {},
    ...patch
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

function click(target: Element | null | undefined): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const RECT = { x: 100, y: 40, width: 24, height: 24 }

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async (name) =>
    name === 'siteInfo.snapshot' || name === 'site.info' ? snapshot() : null
  )
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.body.innerHTML = ''
  uiStore.set({ siteInfoOpen: false })
  siteInfoStore.set({ tabId: null, anchor: null, revision: 0 })
})

describe('the words (lib/siteInfoCopy.ts)', () => {
  const stored = [{ permission: 'camera', decision: 'allow' as const }]

  it('carries the Sound row for a tab that plays or is muted, or a site with its own answer – not otherwise', () => {
    expect(showsSoundRow(stored, tab())).toBe(false)
    expect(showsSoundRow(stored, tab({ audible: true }))).toBe(true)
    expect(showsSoundRow(stored, tab({ muted: true }))).toBe(true)
    expect(showsSoundRow([{ permission: 'sound', decision: 'deny' }], tab())).toBe(true)
  })

  it('reads the Sound row’s value as the stored decision, else the default', () => {
    expect(soundChoice(stored)).toBe('default')
    expect(soundChoice([{ permission: 'sound', decision: 'deny' }])).toBe('deny')
    expect(soundChoice([{ permission: 'sound', decision: 'allow' }])).toBe('allow')
  })

  it('lists the stored decisions, then Sound at its default where the tab earns it without one', () => {
    expect(permissionRows(stored, tab())).toEqual([{ permission: 'camera', decision: 'allow' }])
    expect(permissionRows(stored, tab({ audible: true }))).toEqual([
      { permission: 'camera', decision: 'allow' },
      { permission: 'sound', decision: 'default' }
    ])
    // Stored, Sound stands where the engine lists it and is not added again.
    expect(
      permissionRows([{ permission: 'sound', decision: 'deny' }, ...stored], tab({ muted: true }))
    ).toEqual([
      { permission: 'sound', decision: 'deny' },
      { permission: 'camera', decision: 'allow' }
    ])
  })

  it('has one device row per kind the site is connected to, in the catalogue’s order with its count; none for a kind without grants', () => {
    expect(deviceRows(GRANTS, 'https://web.flasher.example')).toEqual([
      { kind: 'usb', label: 'USB devices', count: 2 },
      { kind: 'bluetooth', label: 'Bluetooth devices', count: 1 }
    ])
    expect(deviceRows(GRANTS, 'https://ports.example')).toEqual([
      { kind: 'serial', label: 'Serial ports', count: 1 }
    ])
    expect(deviceRows(GRANTS, 'https://nowhere.example')).toEqual([])
  })

  it('sums the overview: the stored permissions’ labels and the device kinds, or None', () => {
    expect(permissionsSummary(stored, GRANTS, 'https://web.flasher.example')).toBe(
      'Camera, USB devices, Bluetooth devices'
    )
    expect(permissionsSummary([], GRANTS, 'https://nowhere.example')).toBe('None')
    expect(permissionsSummary([{ permission: 'sound', decision: 'deny' }], [], 'x')).toBe('Sound')
  })

  it('names a level under Permissions per kind', () => {
    expect(SITE_INFO_LEVELS).toContain('devices:usb')
    expect(deviceLevelKind('devices:bluetooth')).toBe('bluetooth')
    expect(deviceLevelKind('permissions')).toBeNull()
  })
})

describe('the desktop popover (siteControls/SiteInfoPopover.tsx)', () => {
  function popover(state: UIState, t: Tab = tab()): ReactElement {
    return (
      <SiteInfoPopover
        tab={t}
        state={state}
        anchor={RECT}
        bar={RECT}
        closing={false}
        onDismiss={() => undefined}
        onClosed={() => undefined}
      />
    )
  }
  const panel = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="site-info"]')!
  /** A `ListRow`'s first text line (the primitive draws it as the text block's first child). */
  const labelOf = (row: Element): string | undefined =>
    row.querySelector<HTMLElement>(':scope > .min-w-0 > div')?.textContent ?? undefined
  const descriptionOf = (row: Element): string | undefined =>
    row.querySelector<HTMLElement>(':scope > .min-w-0 > .line-clamp-2')?.textContent ?? undefined
  const rowByLabel = (label: string): HTMLElement | null =>
    [...panel().querySelectorAll<HTMLElement>('.zen-v2-row')].find((r) => labelOf(r) === label) ??
    null

  it('sums the site’s permissions and device kinds on the overview, and the Permissions level lists Sound as a menulist row for an audible tab and a row per kind with its count', async () => {
    render(popover(stateWith(), tab({ audible: true })))
    await settle()
    const permissions = rowByLabel('Permissions')!
    expect(permissions.textContent).toContain('Camera, USB devices, Bluetooth devices')
    click(permissions)
    await settle()
    expect(panel().dataset.level).toBe('permissions')
    // The stored camera decision, then Sound at its default (the tab plays), as menulist rows.
    const camera = panel().querySelector<HTMLElement>('[data-permission="camera"]')!
    expect(labelOf(camera)).toBe('Camera')
    const sound = panel().querySelector<HTMLElement>('[data-permission="sound"]')!
    expect(labelOf(sound)).toBe('Sound')
    const menulist = sound.querySelector<HTMLElement>('button[aria-haspopup]')!
    expect(menulist.getAttribute('aria-label')).toBe('Sound')
    expect(menulist.textContent).toContain('Allow (default)')
    // The device rows: label, the count as the value, a chevron; the whole read "USB devices — 2".
    const usb = panel().querySelector<HTMLElement>('[data-device-kind="usb"]')!
    expect(labelOf(usb)).toBe('USB devices')
    expect(usb.getAttribute('aria-label')).toBe('USB devices — 2')
    expect(usb.textContent).toContain('2')
    const bluetooth = panel().querySelector<HTMLElement>('[data-device-kind="bluetooth"]')!
    expect(bluetooth.getAttribute('aria-label')).toBe('Bluetooth devices — 1')
    expect(panel().querySelector('[data-device-kind="serial"]')).toBeNull()
    expect(panel().querySelector('[data-device-kind="hid"]')).toBeNull()
  })

  it('a kind’s row opens the level of its devices – name, vendor:product under it, Revoke – and Revoke forgets the grant through devices.forget', async () => {
    render(popover(stateWith()))
    await settle()
    click(rowByLabel('Permissions'))
    await settle()
    // A tab that neither plays nor is muted, on a site with no answer of its own: no Sound row.
    expect(panel().querySelector('[data-permission="sound"]')).toBeNull()
    click(panel().querySelector('[data-device-kind="usb"]'))
    await settle()
    expect(panel().dataset.level).toBe('devices:usb')
    expect(panel().textContent).toContain('USB devices')
    const devices = [...panel().querySelectorAll<HTMLElement>('[data-device-id]')]
    expect(devices.map((d) => d.dataset.deviceId)).toEqual(['usb-1', 'usb-2'])
    expect(labelOf(devices[0]!)).toBe('Arduino Uno')
    expect(descriptionOf(devices[0]!)).toBe('2341:0043')
    const revoke = devices[1]!.querySelector<HTMLButtonElement>('button')!
    expect(revoke.textContent).toBe('Revoke')
    expect(revoke.getAttribute('aria-label')).toBe('Revoke FT232R USB UART')
    click(revoke)
    await settle()
    expect(invoke).toHaveBeenCalledWith('devices.forget', {
      origin: 'https://web.flasher.example',
      kind: 'usb',
      deviceId: 'usb-2'
    })
  })

  it('with no stored permission and no grants the level says so, and Reset permissions waits; grants alone make it live', async () => {
    invoke.mockImplementation(async (name) =>
      name === 'siteInfo.snapshot' ? snapshot({ permissions: [] }) : null
    )
    render(popover(stateWith({ deviceGrants: [] })))
    await settle()
    const reset = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent === 'Reset permissions' ||
        b.getAttribute('aria-label') === 'Reset permissions'
    )
    expect(rowByLabel('Permissions')!.textContent).toContain('None')
    if (reset) expect(reset.disabled).toBe(true)
    act(() => root!.unmount())
    root = null
    document.body.innerHTML = ''

    render(popover(stateWith()))
    await settle()
    expect(rowByLabel('Permissions')!.textContent).toContain('USB devices, Bluetooth devices')
    const reset2 = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent === 'Reset permissions' ||
        b.getAttribute('aria-label') === 'Reset permissions'
    )
    if (reset2) expect(reset2.disabled).toBe(false)
  })
})

describe('the phone sheet (siteinfo/SiteInfoSheet.tsx): the Sound row', () => {
  const initialViewport = viewportStore.get()
  const heights = {
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  }
  beforeEach(() => {
    // happy-dom lays nothing out: the layer 800 tall, the sheet's content 300 (as the pill
    // chips' sheet test has it) – the chassis measures its detents from these, and a sheet
    // measuring nothing takes itself for dismissed.
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
  })
  afterEach(() => {
    viewportStore.set(initialViewport)
    for (const [name, descriptor] of Object.entries(heights)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
    browserStore.set({ state: null })
  })

  function open(state: UIState): HTMLElement {
    browserStore.set({ state })
    // A phone, set after the browser state: the viewport re-derives itself from the window on
    // every snapshot, and happy-dom's window is a desktop's.
    viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null, revision: 0 })
    return render(<SiteInfoLayer />)
  }
  const soundRow = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="switch"][data-permission="sound"]')

  it('is a switch row for a tab that plays, on, that blocks the site’s sound through permissions.set', async () => {
    open(stateWith({ tabs: { t1: tab({ audible: true }) } }))
    await settle()
    const row = soundRow()!
    expect(row).not.toBeNull()
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.textContent).toContain('Sound')
    expect(row.querySelector('.zen-v2-switch')).not.toBeNull()
    click(row)
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: 'https://web.flasher.example',
      permission: 'sound',
      decision: 'deny'
    })
  })

  it('reads a blocked site as off, and turning it on forgets the block', async () => {
    invoke.mockImplementation(async (name) =>
      name === 'site.info'
        ? snapshot({ permissions: [{ permission: 'sound', decision: 'deny' }] })
        : null
    )
    open(stateWith({ tabs: { t1: tab({ muted: true }) } }))
    await settle()
    const row = soundRow()!
    expect(row.getAttribute('aria-checked')).toBe('false')
    click(row)
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://web.flasher.example',
      permission: 'sound'
    })
  })

  it('is absent for a silent tab on a site without its own answer, and the sheet has no device rows (not the phone’s)', async () => {
    open(stateWith())
    await settle()
    expect(soundRow()).toBeNull()
    expect(document.querySelector('[data-device-kind]')).toBeNull()
  })
})

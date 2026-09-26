// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Platform, Space, Tab, UIState } from '@shared/types'
import type { SiteInfo, SitePermission } from '@shared/siteInfo'
import { contentSetting } from '@shared/contentSettings'

/*
 * The Background video row of the phone site-information sheet (W6-S8; MED-08 / EDGE-32, the
 * lead's ruling on services' #523): a switch row in the Sound row's form, seated after Sound,
 * earned by a stored `background-video` answer or a media session that reports video, on Android
 * alone (the catalogue's `support.desktop` is `n-a`); on writes `permissions.set allow`, off takes
 * the stored answer away with `permissions.forget`; the words under it are the catalogue's; and
 * a row once earned stays for the life of the sheet, so it never leaves under the finger.
 */

const ORIGIN = 'https://clips.example'

function info(permissions: SitePermission[]): SiteInfo {
  return {
    tabId: 't1',
    url: `${ORIGIN}/watch`,
    host: 'clips.example',
    site: 'clips.example',
    origin: ORIGIN,
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
    permissions,
    siteData: { state: 'default', pattern: null, addable: '[*.]clips.example', default: 'allow' }
  }
}

let reading: SiteInfo = info([])
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'site.info' ? reading : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SiteInfoLayer } = await import('../SiteInfoSheet')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')
const { defaultShortcuts } = await import('@shared/shortcuts')

function tab(patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url: `${ORIGIN}/watch`,
    title: 'A clip',
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

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

/** The state of a phone showing the page: the platform, the tab and its media entry as given. */
function stateWith(platform: Platform, t: Tab, media: MediaState[]): UIState {
  return {
    platform,
    capabilities: { windowControls: false, requestBlocking: true, translate: true },
    tabs: { t1: t },
    spaces: [space],
    activeSpaceId: 'space',
    settings: {
      urlbarBehavior: 'normal',
      blocking: { level: 'balanced' },
      phoneBarPosition: 'bottom'
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    blocking: { enabled: true, siteExceptions: [] },
    translate: { available: true, tabs: {} },
    media,
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    siteData: { clearsAtNextLaunch: false },
    folders: {},
    essentialTabIds: [],
    containers: [],
    deviceGrants: [],
    glance: null
  } as unknown as UIState
}

/** The tab's media as the core lists a page with a video (`MediaState.video`). */
const VIDEO: MediaState[] = [{ tabId: 't1', playing: true, video: true, session: true }]

let root: Root | null = null
let mount: HTMLElement | null = null
const initialViewport = viewportStore.get()
const heights = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
}

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

/** The sheet up for the page, its reading of the site in. */
async function open(state: UIState): Promise<void> {
  browserStore.set({ state })
  // A phone, set after the browser state: the viewport re-derives itself from the window on
  // every snapshot, and happy-dom's window is a desktop's.
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
  uiStore.set({ siteInfoOpen: true })
  siteInfoStore.set({ tabId: 't1', anchor: null, revision: 0 })
  render(<SiteInfoLayer />)
  await settle()
  await settle()
}

const row = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="switch"][data-permission="background-video"]')
const soundRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="switch"][data-permission="sound"]')

const SETTING = contentSetting('background-video')!

beforeEach(() => {
  invoke.mockClear()
  reading = info([])
  // happy-dom lays nothing out: the layer 800 tall, the sheet's content 300 – the chassis
  // measures its detents from these, and a sheet measuring nothing takes itself for dismissed.
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
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.body.innerHTML = ''
  viewportStore.set(initialViewport)
  for (const [name, descriptor] of Object.entries(heights)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  browserStore.set({ state: null })
  uiStore.set({ siteInfoOpen: false })
  siteInfoStore.set({ tabId: null, anchor: null, revision: 0 })
})

describe('the phone sheet (siteinfo/SiteInfoSheet.tsx): the Background video row', () => {
  it('is a switch row after Sound for a tab whose media reports video, off by default, whose on stores an allow through permissions.set', async () => {
    await open(stateWith('android', tab({ audible: true }), VIDEO))
    const switchRow = row()!
    expect(switchRow).not.toBeNull()
    expect(switchRow.getAttribute('aria-checked')).toBe('false')
    expect(switchRow.textContent).toContain('Background video')
    expect(switchRow.querySelector('.zen-v2-switch')).not.toBeNull()
    // The catalogue's words for off, under the label and in the row's name.
    expect(switchRow.textContent).toContain(SETTING.description)
    expect(switchRow.getAttribute('aria-label')).toBe(`Background video, ${SETTING.description}`)
    // Seated right after the Sound row, its media neighbour.
    const sound = soundRow()!
    expect(sound).not.toBeNull()
    expect(sound.nextElementSibling).toBe(switchRow)
    click(switchRow)
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: ORIGIN,
      permission: 'background-video',
      decision: 'allow'
    })
  })

  it('reads a stored allow as on with the catalogue’s allow line, and turning it off forgets the answer; the row stays for the sheet’s life', async () => {
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('android', tab(), []))
    const switchRow = row()!
    expect(switchRow).not.toBeNull()
    expect(switchRow.getAttribute('aria-checked')).toBe('true')
    expect(switchRow.textContent).toContain(SETTING.descriptions?.allow)
    expect(switchRow.getAttribute('aria-label')).toBe(
      `Background video, ${SETTING.descriptions?.allow}`
    )
    // The next reading has no answer: what `permissions.forget` leaves.
    reading = info([])
    click(switchRow)
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: ORIGIN,
      permission: 'background-video'
    })
    expect(invoke).not.toHaveBeenCalledWith('permissions.set', expect.anything())
    await settle()
    await settle()
    // Nothing earns the row now – no answer, no video – yet it stands, reading off.
    const after = row()!
    expect(after).not.toBeNull()
    expect(after.getAttribute('aria-checked')).toBe('false')
    expect(after.textContent).toContain(SETTING.description)
  })

  it('reads a stored deny as off, like the default', async () => {
    reading = info([{ permission: 'background-video', decision: 'deny' }])
    await open(stateWith('android', tab(), []))
    const switchRow = row()!
    expect(switchRow).not.toBeNull()
    expect(switchRow.getAttribute('aria-checked')).toBe('false')
    click(switchRow)
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: ORIGIN,
      permission: 'background-video',
      decision: 'allow'
    })
  })

  it('is absent on a page with no video and no stored answer', async () => {
    await open(stateWith('android', tab({ audible: true }), []))
    expect(soundRow()).not.toBeNull()
    expect(row()).toBeNull()
  })

  it('is absent on a desktop host, whatever its window’s form factor: the catalogue marks the setting n-a there', async () => {
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('linux', tab(), VIDEO))
    expect(row()).toBeNull()
  })
})

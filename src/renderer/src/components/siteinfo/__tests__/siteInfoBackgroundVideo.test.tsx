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
 * the stored answer away with `permissions.forget`; the line under the label is the sheet's own,
 * one and constant in both states (the lead's ruling on #531: the switch carries the state); and
 * a row once earned stays while its origin is under the sheet, so it never leaves under the
 * finger – the hold is the origin's, not the tab's: another origin navigated to under the open
 * sheet has to earn the row itself, and only a reading of that origin can earn it.
 */

const ORIGIN = 'https://clips.example'
/** Another origin the same tab can be taken to under the open sheet. */
const ELSEWHERE = 'https://elsewhere.example'

/** The core's reading of the page at `url` (the site's origin as `describeSite` derives it). */
function info(permissions: SitePermission[], url = `${ORIGIN}/watch`): SiteInfo {
  const parsed = new URL(url)
  return {
    tabId: 't1',
    url,
    host: parsed.hostname,
    site: parsed.hostname,
    origin: parsed.origin,
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
    siteData: {
      state: 'default',
      pattern: null,
      addable: `[*.]${parsed.hostname}`,
      default: 'allow'
    }
  }
}

let reading: SiteInfo = info([])
/** The stand-in host: `site.info` answers with the reading of the moment, everything else with nothing. */
const answer = async (name: string): Promise<unknown> => (name === 'site.info' ? reading : null)
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(answer)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SiteInfoLayer } = await import('../SiteInfoSheet')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')
const { BACKGROUND_VIDEO_LINE } = await import('@renderer/lib/siteInfoCopy')
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

/**
 * The browser state given as a phone's: the viewport re-derives itself from the window on
 * every snapshot, and happy-dom's window is a desktop's, so the phone is set after each.
 */
function snapshot(state: UIState): void {
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
}

/** The sheet up for the page, its reading of the site in. */
async function open(state: UIState): Promise<void> {
  snapshot(state)
  uiStore.set({ siteInfoOpen: true })
  siteInfoStore.set({ tabId: 't1', anchor: null, revision: 0 })
  render(<SiteInfoLayer />)
  await settle()
  await settle()
}

/**
 * The same tab taken to `url` under the open sheet, the way a page's navigation reaches the
 * chrome: the core's next reading is of the new page, then the state carries the tab's new
 * address (the sheet re-reads on it) and the tab's media as the new page reports it.
 */
async function navigate(
  url: string,
  permissions: SitePermission[],
  media: MediaState[] = []
): Promise<void> {
  reading = info(permissions, url)
  act(() => snapshot(stateWith('android', tab({ url }), media)))
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
  invoke.mockImplementation(answer)
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
    // The sheet's own line under the label and in the row's name – this site's, constant, and not
    // the catalogue's Settings sentence: the switch alone says off.
    expect(switchRow.textContent).toContain(BACKGROUND_VIDEO_LINE)
    expect(switchRow.textContent).not.toContain(SETTING.description)
    expect(switchRow.getAttribute('aria-label')).toBe(`Background video, ${BACKGROUND_VIDEO_LINE}`)
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

  it('reads a stored allow as on under the same constant line, and turning it off forgets the answer; the row stays for the sheet’s life', async () => {
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('android', tab(), []))
    const switchRow = row()!
    expect(switchRow).not.toBeNull()
    expect(switchRow.getAttribute('aria-checked')).toBe('true')
    // On, the line is the same: the state is the switch's, never told again under the label.
    expect(switchRow.textContent).toContain(BACKGROUND_VIDEO_LINE)
    expect(switchRow.textContent).not.toContain(SETTING.descriptions?.allow)
    expect(switchRow.getAttribute('aria-label')).toBe(`Background video, ${BACKGROUND_VIDEO_LINE}`)
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
    // Nothing earns the row now – no answer, no video – yet it stands, reading off under the
    // same line.
    const after = row()!
    expect(after).not.toBeNull()
    expect(after.getAttribute('aria-checked')).toBe('false')
    expect(after.textContent).toContain(BACKGROUND_VIDEO_LINE)
    expect(after.getAttribute('aria-label')).toBe(`Background video, ${BACKGROUND_VIDEO_LINE}`)
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

  it('keeps the row through a same-origin navigation once earned there, and drops it when another origin comes under the sheet unless that origin earns it', async () => {
    // Earned on clips.example by its stored allow; the sheet stays up.
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('android', tab(), []))
    expect(row()).not.toBeNull()
    // Turned off there: the answer forgotten, the row standing (the hold).
    reading = info([])
    click(row())
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: ORIGIN,
      permission: 'background-video'
    })
    await settle()
    await settle()
    expect(row()).not.toBeNull()
    // Another page of the same origin, nothing earning the row there either: it stays – the hold
    // is the origin's for the life of the sheet.
    await navigate(`${ORIGIN}/another-clip`, [])
    expect(row()).not.toBeNull()
    expect(row()!.getAttribute('aria-checked')).toBe('false')
    // Another origin under the sheet, with no answer and no video: the hold does not carry; the
    // row goes.
    await navigate(`${ELSEWHERE}/page`, [])
    expect(row()).toBeNull()
    // A third origin with its own stored allow earns the row afresh, reading that origin's answer
    // – and a press writes that origin, not the one that earned the hold before.
    await navigate('https://third.example/', [
      { permission: 'background-video', decision: 'allow' }
    ])
    expect(row()).not.toBeNull()
    expect(row()!.getAttribute('aria-checked')).toBe('true')
    invoke.mockClear()
    reading = info([], 'https://third.example/')
    click(row())
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://third.example',
      permission: 'background-video'
    })
  })

  it('does not park the hold for an origin left behind: back on it with nothing earning the row, the row is absent until earned again', async () => {
    // Earned on clips.example by its video alone.
    await open(stateWith('android', tab(), VIDEO))
    expect(row()).not.toBeNull()
    // Elsewhere, nothing: the row goes.
    await navigate(`${ELSEWHERE}/page`, [])
    expect(row()).toBeNull()
    // Back on clips.example with the video stopped and no answer: the earlier hold dropped with
    // the origin change; nothing shows.
    await navigate(`${ORIGIN}/watch`, [])
    expect(row()).toBeNull()
    // Its video playing again earns the row again.
    await navigate(`${ORIGIN}/watch?t=2`, [], VIDEO)
    expect(row()).not.toBeNull()
    expect(row()!.getAttribute('aria-checked')).toBe('false')
  })

  it('lets only a reading of the site under the sheet earn the row: the last origin’s reading, still up while the new page is read, earns nothing for the new origin', async () => {
    // clips.example earned by its stored allow.
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('android', tab(), []))
    expect(row()).not.toBeNull()
    // The tab moves to another origin, but the core's reading of it never lands: the sheet holds
    // the last reading (clips.example's allow) with the new address under it.
    const pending: { release: (() => void) | null } = { release: null }
    invoke.mockImplementation(
      (name) =>
        new Promise((resolve) => {
          if (name !== 'site.info') {
            resolve(null)
            return
          }
          pending.release = () => resolve(info([], `${ELSEWHERE}/page`))
        })
    )
    act(() => snapshot(stateWith('android', tab({ url: `${ELSEWHERE}/page` }), [])))
    await settle()
    await settle()
    // The stale reading earns nothing for elsewhere.example: no row.
    expect(row()).toBeNull()
    expect(pending.release).not.toBeNull()
    // The new page's reading lands, with nothing in it: still no row.
    act(() => pending.release?.())
    await settle()
    await settle()
    expect(row()).toBeNull()
    invoke.mockImplementation(async (name) => (name === 'site.info' ? reading : null))
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

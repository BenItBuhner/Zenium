// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Platform, Space, Tab, UIState } from '@shared/types'
import type { ContentDefault } from '@shared/contentSettings'
import type { SiteInfo, SitePermission } from '@shared/siteInfo'

/*
 * The two switch rows of the phone site-information sheet read the site's EFFECTIVE state
 * (W6-S12; the lead's ruling on #531, §10.4): the row's position is the state in force for this
 * site – its own answer, else the default the core carries in `UIState.permissionDefaults` – and
 * a press writes the site's rule that gives the other state (an allow under a blocking default,
 * a deny under an allowing one), a forget only where the default already gives what the press
 * asks. Below: each row × each default × no answer / a stored allow / a stored deny – what the
 * switch reads and what the press writes; the default changing under the open sheet; Sound's
 * origin latch, the same as Background video's (W6-S8); and the Permissions row's summary, which
 * names what is STORED for the site and never the state in force.
 */

const ORIGIN = 'https://clips.example'
/** Another origin the same tab can be taken to under the open sheet. */
const ELSEWHERE = 'https://elsewhere.example'

type Row = 'sound' | 'background-video'
type Decision = 'allow' | 'deny'

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

/**
 * The state of a phone showing the page: the platform, the tab, its media entry and the
 * defaults in force as the core carries them (`permissionDefaults`, the user's where Settings
 * chose one, else the catalogue's).
 */
function stateWith(
  platform: Platform,
  t: Tab,
  media: MediaState[],
  defaults: Partial<Record<Row, ContentDefault>> = {}
): UIState {
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
    permissionDefaults: defaults,
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
 * address (the sheet re-reads on it), the tab as the new page leaves it and the defaults as
 * they stand.
 */
async function navigate(
  url: string,
  permissions: SitePermission[],
  patch: Partial<Tab> = {},
  defaults: Partial<Record<Row, ContentDefault>> = {}
): Promise<void> {
  reading = info(permissions, url)
  act(() => snapshot(stateWith('android', tab({ url, ...patch }), [], defaults)))
  await settle()
  await settle()
}

const row = (permission: Row): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="switch"][data-permission="${permission}"]`)

/** The Permissions detail row's value: what the sheet names as stored for the site. */
function permissionsValue(): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')]
  const target = rows.find(
    (el) => el.querySelector('.block.truncate')?.textContent?.trim() === 'Permissions'
  )
  return target?.querySelector('.zen-sheet-item-value')?.textContent ?? null
}

/** The state that earns `permission`'s row: an audible tab for Sound, a video for Background video. */
function earning(permission: Row): { t: Tab; media: MediaState[] } {
  return permission === 'sound'
    ? { t: tab({ audible: true }), media: [] }
    : { t: tab(), media: VIDEO }
}

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

/**
 * The whole rule as a table: for each row, under each default, with no answer, a stored allow
 * and a stored deny – the position read, and the write the press makes. `press` is the write:
 * the site's rule that gives the other state, or the answer forgotten where the default gives it.
 */
const TABLE: Array<{
  permission: Row
  fallback: Decision
  answer: Decision | null
  on: boolean
  press: { decision: Decision } | 'forget'
}> = [
  { permission: 'sound', fallback: 'allow', answer: null, on: true, press: { decision: 'deny' } },
  {
    permission: 'sound',
    fallback: 'allow',
    answer: 'allow',
    on: true,
    press: { decision: 'deny' }
  },
  { permission: 'sound', fallback: 'allow', answer: 'deny', on: false, press: 'forget' },
  { permission: 'sound', fallback: 'deny', answer: null, on: false, press: { decision: 'allow' } },
  { permission: 'sound', fallback: 'deny', answer: 'allow', on: true, press: 'forget' },
  {
    permission: 'sound',
    fallback: 'deny',
    answer: 'deny',
    on: false,
    press: { decision: 'allow' }
  },
  {
    permission: 'background-video',
    fallback: 'allow',
    answer: null,
    on: true,
    press: { decision: 'deny' }
  },
  {
    permission: 'background-video',
    fallback: 'allow',
    answer: 'allow',
    on: true,
    press: { decision: 'deny' }
  },
  { permission: 'background-video', fallback: 'allow', answer: 'deny', on: false, press: 'forget' },
  {
    permission: 'background-video',
    fallback: 'deny',
    answer: null,
    on: false,
    press: { decision: 'allow' }
  },
  { permission: 'background-video', fallback: 'deny', answer: 'allow', on: true, press: 'forget' },
  {
    permission: 'background-video',
    fallback: 'deny',
    answer: 'deny',
    on: false,
    press: { decision: 'allow' }
  }
]

describe('the phone sheet (siteinfo/SiteInfoSheet.tsx): the switch rows read the state in force for the site (§10.4)', () => {
  for (const { permission, fallback, answer, on, press } of TABLE) {
    const label = permission === 'sound' ? 'Sound' : 'Background video'
    it(`${label} under a default of ${fallback} with ${answer ? `a stored ${answer}` : 'no answer'} reads ${on ? 'on' : 'off'}, and a press ${press === 'forget' ? 'forgets the answer' : `stores ${press.decision}`}`, async () => {
      reading = info(answer ? [{ permission, decision: answer }] : [])
      const { t, media } = earning(permission)
      await open(stateWith('android', t, media, { [permission]: fallback }))
      const switchRow = row(permission)!
      expect(switchRow).not.toBeNull()
      expect(switchRow.getAttribute('aria-checked')).toBe(String(on))
      click(switchRow)
      await settle()
      if (press === 'forget') {
        expect(invoke).toHaveBeenCalledWith('permissions.forget', {
          origin: ORIGIN,
          permission
        })
        expect(invoke).not.toHaveBeenCalledWith('permissions.set', expect.anything())
      } else {
        expect(invoke).toHaveBeenCalledWith('permissions.set', {
          origin: ORIGIN,
          permission,
          decision: press.decision
        })
        expect(invoke).not.toHaveBeenCalledWith('permissions.forget', expect.anything())
      }
    })
  }

  it('reads the catalogue’s default where the state carries none: Sound on, Background video off', async () => {
    await open(stateWith('android', tab({ audible: true }), VIDEO))
    expect(row('sound')!.getAttribute('aria-checked')).toBe('true')
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('false')
  })

  it('follows the default changing under the open sheet with no answer for the site, and the press writes against the default of the moment', async () => {
    // Background video at the catalogue's Block: the row reads off on a page with a video.
    await open(stateWith('android', tab(), VIDEO, { 'background-video': 'deny' }))
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('false')
    // Settings turns the default to Allow: nothing stored for the site changes, and the row
    // reads on – the site plays on now.
    act(() => snapshot(stateWith('android', tab(), VIDEO, { 'background-video': 'allow' })))
    await settle()
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('true')
    // A press for off under the allowing default stores the site's deny, not a forget: the
    // core's next reading (the sheet re-reads after the write) carries the deny.
    reading = info([{ permission: 'background-video', decision: 'deny' }])
    click(row('background-video'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: ORIGIN,
      permission: 'background-video',
      decision: 'deny'
    })
    expect(invoke).not.toHaveBeenCalledWith('permissions.forget', expect.anything())
    // The deny stored, the row reads off; the press for on now forgets it – the default gives on.
    invoke.mockClear()
    await settle()
    await settle()
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('false')
    click(row('background-video'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: ORIGIN,
      permission: 'background-video'
    })
    expect(invoke).not.toHaveBeenCalledWith('permissions.set', expect.anything())
  })

  it('keeps Background video’s line constant whatever the default: the switch alone carries the state', async () => {
    const { BACKGROUND_VIDEO_LINE } = await import('@renderer/lib/siteInfoCopy')
    await open(stateWith('android', tab(), VIDEO, { 'background-video': 'allow' }))
    const switchRow = row('background-video')!
    expect(switchRow.getAttribute('aria-checked')).toBe('true')
    expect(switchRow.textContent).toContain(BACKGROUND_VIDEO_LINE)
    expect(switchRow.getAttribute('aria-label')).toBe(`Background video, ${BACKGROUND_VIDEO_LINE}`)
    // Sound keeps its own one word.
    await navigate(`${ORIGIN}/listen`, [], { audible: true }, { sound: 'deny' })
    expect(row('sound')!.getAttribute('aria-checked')).toBe('false')
    expect(row('sound')!.textContent?.trim()).toBe('Sound')
  })
})

describe('the phone sheet: the Permissions row names what is stored, not the state in force', () => {
  it('names nothing for a site with no answer whose row reads on from the default', async () => {
    await open(stateWith('android', tab({ audible: true }), VIDEO, { 'background-video': 'allow' }))
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('true')
    expect(row('sound')!.getAttribute('aria-checked')).toBe('true')
    expect(permissionsValue()).toBe('None asked for')
  })

  it('names a stored answer equal to the default, which the row reads as the default does', async () => {
    reading = info([{ permission: 'background-video', decision: 'allow' }])
    await open(stateWith('android', tab(), [], { 'background-video': 'allow' }))
    expect(row('background-video')!.getAttribute('aria-checked')).toBe('true')
    expect(permissionsValue()).toBe('Background video')
    // Sound's mirror on another page of the site: a stored deny under a default of Block reads
    // off, and is named as stored.
    await navigate(
      `${ORIGIN}/listen`,
      [{ permission: 'sound', decision: 'deny' }],
      {},
      {
        sound: 'deny'
      }
    )
    expect(row('sound')!.getAttribute('aria-checked')).toBe('false')
    expect(permissionsValue()).toBe('Sound')
  })
})

describe('the phone sheet: the Sound row’s origin latch (the same as Background video’s)', () => {
  it('keeps the row through a same-origin navigation once earned there, and drops it when another origin comes under the sheet unless that origin earns it', async () => {
    // Earned on clips.example by its stored deny (the tab quiet); the sheet stays up.
    reading = info([{ permission: 'sound', decision: 'deny' }])
    await open(stateWith('android', tab(), []))
    expect(row('sound')).not.toBeNull()
    expect(row('sound')!.getAttribute('aria-checked')).toBe('false')
    // Turned on there: under the default's Allow the press is the forget – the only stored
    // reason for the row – and the row stands (the hold), reading on from the default.
    reading = info([])
    click(row('sound'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: ORIGIN,
      permission: 'sound'
    })
    await settle()
    await settle()
    expect(row('sound')).not.toBeNull()
    expect(row('sound')!.getAttribute('aria-checked')).toBe('true')
    // Another page of the same origin, quiet and with no answer: it stays – the hold is the
    // origin's for the life of the sheet.
    await navigate(`${ORIGIN}/another-clip`, [])
    expect(row('sound')).not.toBeNull()
    expect(row('sound')!.getAttribute('aria-checked')).toBe('true')
    // Another origin under the sheet, quiet, with no answer: the hold does not carry; the row goes.
    await navigate(`${ELSEWHERE}/page`, [])
    expect(row('sound')).toBeNull()
    // A third origin with its own stored deny earns the row afresh, reading that origin's answer
    // – and a press writes that origin, not the one that earned the hold before.
    await navigate('https://third.example/', [{ permission: 'sound', decision: 'deny' }])
    expect(row('sound')).not.toBeNull()
    expect(row('sound')!.getAttribute('aria-checked')).toBe('false')
    invoke.mockClear()
    reading = info([], 'https://third.example/')
    click(row('sound'))
    await settle()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://third.example',
      permission: 'sound'
    })
  })

  it('does not park the hold for an origin left behind: back on it with nothing earning the row, the row is absent until earned again', async () => {
    // Earned on clips.example by its sound alone.
    await open(stateWith('android', tab({ audible: true }), []))
    expect(row('sound')).not.toBeNull()
    // Elsewhere, quiet: the row goes.
    await navigate(`${ELSEWHERE}/page`, [])
    expect(row('sound')).toBeNull()
    // Back on clips.example, quiet and with no answer: the earlier hold dropped with the origin
    // change; nothing shows.
    await navigate(`${ORIGIN}/watch`, [])
    expect(row('sound')).toBeNull()
    // Its sound playing again earns the row again.
    await navigate(`${ORIGIN}/watch?t=2`, [], { audible: true })
    expect(row('sound')).not.toBeNull()
    expect(row('sound')!.getAttribute('aria-checked')).toBe('true')
  })

  it('lets only a reading of the site under the sheet earn the row: the last origin’s reading, still up while the new page is read, earns nothing for the new origin', async () => {
    // clips.example earned by its stored deny.
    reading = info([{ permission: 'sound', decision: 'deny' }])
    await open(stateWith('android', tab(), []))
    expect(row('sound')).not.toBeNull()
    // The tab moves to another origin, but the core's reading of it never lands: the sheet holds
    // the last reading (clips.example's deny) with the new address under it.
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
    expect(row('sound')).toBeNull()
    expect(pending.release).not.toBeNull()
    // The new page's reading lands, with nothing in it: still no row.
    act(() => pending.release?.())
    await settle()
    await settle()
    expect(row('sound')).toBeNull()
    invoke.mockImplementation(async (name) => (name === 'site.info' ? reading : null))
  })
})

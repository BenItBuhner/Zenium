// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SiteInfoSnapshot } from '@shared/siteInfo'
import { DEFAULT_CONTAINER_ID, type Tab, type UIState } from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>()
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { closeAllPopovers } from '@renderer/lib/portals'
import { SITE_INFO_LEVELS } from '@renderer/lib/siteInfoCopy'
import { SiteInfoPopover } from '../SiteInfoPopover'

/*
 * The desktop site information popover's rows of wave 4 (omnibox-28, omnibox-38): the Site
 * settings row – Chrome's last row of page info – as a button in the tab order that opens
 * Settings › Privacy and security on the site's `?site=` landing and lets the popover go; and
 * the level the popover opens on, Permissions from the pill's in-use chip and its blocked
 * icons, with the permission's row there to change.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

const page: Tab = {
  id: 't1',
  url: 'https://meet.example/call?room=1',
  containerId: DEFAULT_CONTAINER_ID,
  title: 'Meet',
  favicon: null,
  loading: false,
  blockedCount: 0
} as unknown as Tab

const state = {
  platform: 'linux',
  capabilities: { requestBlocking: false },
  tabs: { t1: page },
  containers: [],
  extensions: [],
  deviceGrants: [],
  siteData: { clearsAtNextLaunch: false },
  settings: {},
  blocking: { enabled: true, siteExceptions: [] }
} as unknown as UIState

/** Enough of a reading for the levels under test: the site, no cookies, the permissions given. */
function snapshot(permissions: SiteInfoSnapshot['permissions']): SiteInfoSnapshot {
  return {
    tabId: 't1',
    url: page.url,
    host: 'meet.example',
    site: 'meet.example',
    origin: 'https://meet.example',
    containerId: 'default',
    security: { state: 'secure', certificate: null, mixedContent: null },
    cookies: { items: [], thirdParty: [], documentCookieNames: [] },
    storage: {
      usageBytes: null,
      quotaBytes: null,
      origins: [],
      localStorageItems: null,
      sessionStorageItems: null,
      serviceWorkers: null
    },
    permissions,
    siteData: { entry: null, pattern: null, addable: false, fallback: 'allow' },
    blocking: { available: false, enabled: false, excepted: false, blockedCount: 0 }
  } as unknown as SiteInfoSnapshot
}

function Popover({
  level,
  onDismiss
}: {
  level?: (typeof SITE_INFO_LEVELS)[number]
  onDismiss: () => void
}): ReactElement {
  return (
    <SiteInfoPopover
      tab={page}
      state={state}
      anchor={{ x: 40, y: 8, width: 24, height: 24 }}
      bar={{ x: 20, y: 4, width: 300, height: 32 }}
      closing={false}
      level={level}
      onDismiss={onDismiss}
      onClosed={() => undefined}
    />
  )
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="site-info"]')!

/** The reading has landed and the popover drew it. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  cmd.mockReset()
  run.mockReset()
  cmd.mockImplementation(async (name) => {
    if (name === 'siteInfo.snapshot') return snapshot([])
    return null
  })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the Site settings row (omnibox-28)', () => {
  it('is the overview’s last row, a button in the tab order trailing the open glyph', async () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)
    await settle()
    expect(dialog().getAttribute('data-level')).toBe('overview')
    const row = dialog().querySelector<HTMLElement>('[data-site-settings]')!
    expect(row.tagName).toBe('BUTTON')
    expect(row.tabIndex).toBe(0)
    expect(row.textContent).toBe('Site settings')
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    // The open glyph, not a level's chevron: the row leaves the popover for a tab.
    expect(row.querySelector('svg.lucide-external-link')).not.toBeNull()
    expect(row.querySelector('svg.lucide-chevron-right')).toBeNull()
    // Last of the rows, after Reset permissions; the footer's buttons follow it.
    const rows = Array.from(dialog().querySelectorAll<HTMLElement>('.zen-v2-row'))
    expect(rows.at(-1)).toBe(row)
    expect(rows.at(-2)?.textContent).toBe('Reset permissions')
    // Reachable by Tab like every button of the popover.
    const buttons = Array.from(dialog().querySelectorAll<HTMLElement>('button')).filter(
      (b) => !b.hasAttribute('disabled')
    )
    expect(buttons).toContain(row)
  })

  it('opens Settings › Privacy and security on the site’s landing and lets the popover go', async () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)
    await settle()
    const row = dialog().querySelector<HTMLElement>('[data-site-settings]')!
    row.focus()
    expect(document.activeElement).toBe(row)
    // Enter and Space on a button dispatch a click; so does a pointer.
    act(() => row.click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('page.open', {
      id: 'settings',
      section: 'privacy',
      query: { site: 'https://meet.example' }
    })
    expect(run).not.toHaveBeenCalledWith('tab.reload', expect.anything())
  })

  it('keeps off a page that is no site of the web', async () => {
    const internal = { ...page, url: 'zen://settings' } as Tab
    render(
      <SiteInfoPopover
        tab={internal}
        state={{ ...state, tabs: { t1: internal } } as UIState}
        anchor={null}
        bar={null}
        closing={false}
        onDismiss={() => undefined}
        onClosed={() => undefined}
      />
    )
    await settle()
    expect(document.querySelector('[data-site-settings]')).toBeNull()
  })
})

describe('the level the popover opens on (omnibox-38)', () => {
  it('opens on the overview by default, and on Permissions when asked, with the blocked row there to change', async () => {
    cmd.mockImplementation(async (name) => {
      if (name === 'siteInfo.snapshot')
        return snapshot([
          { permission: 'camera', decision: 'deny' },
          { permission: 'microphone', decision: 'allow' }
        ])
      return null
    })
    render(<Popover level="permissions" onDismiss={() => undefined} />)
    await settle()
    expect(dialog().getAttribute('data-level')).toBe('permissions')
    expect(dialog().querySelector('h2, [id^="site-info-"]')?.textContent).toContain('Permissions')
    const camera = dialog().querySelector<HTMLElement>('[data-permission="camera"]')!
    expect(camera).not.toBeNull()
    expect(camera.textContent).toContain('Camera')
    // Its menulist says Block, and is a control in the tab order.
    const control = camera.querySelector<HTMLElement>('button')!
    expect(control.textContent).toContain('Block')
    expect(control.tabIndex).toBe(0)
    expect(dialog().querySelector('[data-permission="microphone"]')?.textContent).toContain('Allow')
    // Back leads to the overview, as from any level.
    const back = dialog().querySelector<HTMLElement>('button[aria-label="Back"]')!
    act(() => back.click())
    expect(dialog().getAttribute('data-level')).toBe('overview')
    expect(SITE_INFO_LEVELS).toContain('permissions')
  })
})

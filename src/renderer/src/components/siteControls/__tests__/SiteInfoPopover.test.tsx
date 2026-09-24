// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SiteInfoSnapshot } from '@shared/siteInfo'
import { DEFAULT_CONTAINER_ID, type CertificateError, type Tab, type UIState } from '@shared/types'

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

/*
 * A certificate that failed verification (W5-2 (c), Android's #382): the Connection row and the
 * level's headline name the fault in the shared module's words – `certificateFault`, the phone
 * sheet's – in the danger tier's ink, never the refused certificate's issuer; the certificate's
 * rows stand under "Certificate that was refused".
 */
const DANGER_INK = 'text-[var(--v2-danger)]'

function refused(code: number, patch: Partial<CertificateError> = {}): CertificateError {
  return {
    code,
    url: page.url,
    certificate: {
      subjectName: 'meet.example',
      issuerName: 'Example Root CA',
      validStart: Date.UTC(2019, 0, 1),
      validExpiry: Date.UTC(2020, 0, 1),
      fingerprint: 'sha256/abc'
    },
    bypassed: false,
    ...patch
  }
}

function refusedSnapshot(error: CertificateError): SiteInfoSnapshot {
  return {
    ...snapshot([]),
    security: {
      state: 'insecure',
      certificate: {
        subject: 'meet.example',
        issuer: 'Example Root CA',
        validFrom: error.certificate?.validStart ?? null,
        validTo: error.certificate?.validExpiry ?? null,
        protocol: null
      },
      mixedContent: null,
      certificateError: error
    }
  }
}

const connectionRow = (): HTMLElement =>
  Array.from(dialog().querySelectorAll<HTMLElement>('.zen-v2-row')).find((row) =>
    row.textContent?.startsWith('Connection')
  )!

const titleLine = (): string => dialog().querySelector('h2 + p')?.textContent ?? ''

describe('a certificate named by its fault (W5-2 (c), #382)', () => {
  it.each([
    [-200, 'Certificate not valid for this site'],
    [-201, 'Certificate expired'],
    [-202, 'Certificate not trusted'],
    [-206, 'Certificate revoked'],
    [-213, 'Certificate not valid']
  ])(
    'ERR_CERT %d: the Connection row’s value is the fault in the danger ink, never the issuer',
    async (code, fault) => {
      cmd.mockImplementation(async (name) => {
        if (name === 'siteInfo.snapshot') return refusedSnapshot(refused(code))
        return null
      })
      render(<Popover onDismiss={() => undefined} />)
      await settle()
      const value = connectionRow().querySelector<HTMLElement>('[data-fault]')!
      expect(value).not.toBeNull()
      expect(value.getAttribute('data-fault')).toBe(fault)
      expect(value.textContent).toBe(fault)
      expect(value.classList.contains(DANGER_INK)).toBe(true)
      expect(value.classList.contains('text-[var(--v2-text-deemphasized)]')).toBe(false)
      expect(connectionRow().textContent).not.toContain('Example Root CA')
      // The title block's line says the same (the phone sheet's line).
      expect(titleLine()).toBe(`Not secure · ${fault}`)
    }
  )

  it('the Connection level: the fault as the headline in the danger ink, the shared sentence under it, the certificate’s rows under "Certificate that was refused"', async () => {
    cmd.mockImplementation(async (name) => {
      if (name === 'siteInfo.snapshot') return refusedSnapshot(refused(-201))
      return null
    })
    render(<Popover onDismiss={() => undefined} />)
    await settle()
    act(() => connectionRow().click())
    expect(dialog().getAttribute('data-level')).toBe('connection')
    const headline = dialog().querySelector<HTMLElement>('[data-fault]')!
    expect(headline.textContent).toBe('Certificate expired')
    expect(headline.classList.contains(DANGER_INK)).toBe(true)
    expect(headline.nextElementSibling?.textContent).toBe(
      'The certificate this site sent could not be verified, so Zenium did not load the page.'
    )
    const text = dialog().textContent ?? ''
    // The heading stands before the certificate's rows; the issuer is a fact of the certificate
    // there, not the row's credential.
    expect(text.indexOf('Certificate that was refused')).toBeGreaterThan(-1)
    expect(text.indexOf('Certificate that was refused')).toBeLessThan(text.indexOf('Issued by'))
    const issuedBy = Array.from(dialog().querySelectorAll<HTMLElement>('.zen-v2-row')).find((row) =>
      row.textContent?.startsWith('Issued by')
    )!
    expect(issuedBy.textContent).toContain('Example Root CA')
  })

  it('proceeded past the warning: the bypassed sentence, the fault still the word', async () => {
    cmd.mockImplementation(async (name) => {
      if (name === 'siteInfo.snapshot') return refusedSnapshot(refused(-202, { bypassed: true }))
      return null
    })
    render(<Popover level="connection" onDismiss={() => undefined} />)
    await settle()
    const headline = dialog().querySelector<HTMLElement>('[data-fault]')!
    expect(headline.textContent).toBe('Certificate not trusted')
    expect(headline.nextElementSibling?.textContent).toBe(
      'You chose to proceed past a certificate warning. What you send to this site could be read or changed on the way.'
    )
  })

  it('a sound certificate keeps the headline, muted, and no refused heading', async () => {
    cmd.mockImplementation(async (name) => {
      if (name === 'siteInfo.snapshot')
        return {
          ...snapshot([]),
          security: {
            state: 'secure',
            certificate: {
              subject: 'meet.example',
              issuer: 'Example CA',
              validFrom: null,
              validTo: null,
              protocol: 'TLS 1.3'
            },
            mixedContent: null
          }
        } as SiteInfoSnapshot
      return null
    })
    render(<Popover onDismiss={() => undefined} />)
    await settle()
    expect(dialog().querySelector('[data-fault]')).toBeNull()
    const value = connectionRow().querySelector<HTMLElement>('span.truncate')!
    expect(value.textContent).toBe('Secure')
    expect(value.classList.contains('text-[var(--v2-text-deemphasized)]')).toBe(true)
    expect(value.classList.contains(DANGER_INK)).toBe(false)
    expect(titleLine()).toBe('Secure · Example CA')
    act(() => connectionRow().click())
    expect(dialog().textContent).not.toContain('Certificate that was refused')
    expect(dialog().querySelector('[data-fault]')).toBeNull()
  })

  it('reads the tab’s refused certificate from the first frame, before the reading lands', async () => {
    // The reading never lands: the tab alone is the word.
    cmd.mockImplementation(() => new Promise(() => undefined))
    const error = refused(-201)
    const tab = { ...page, certificateError: error } as Tab
    render(
      <SiteInfoPopover
        tab={tab}
        state={{ ...state, tabs: { t1: tab } } as UIState}
        anchor={{ x: 40, y: 8, width: 24, height: 24 }}
        bar={{ x: 20, y: 4, width: 300, height: 32 }}
        closing={false}
        onDismiss={() => undefined}
        onClosed={() => undefined}
      />
    )
    await settle()
    expect(titleLine()).toBe('Not secure · Certificate expired')
    const value = connectionRow().querySelector<HTMLElement>('[data-fault]')!
    expect(value.textContent).toBe('Certificate expired')
    expect(value.classList.contains(DANGER_INK)).toBe(true)
  })
})

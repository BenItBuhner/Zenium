// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo, UIState } from '@shared/types'

/*
 * A synced landing on the Extensions page (services pass 16, ID-44): an extension another
 * device's record installed here arrives turned off with `pendingApproval`, and the page says
 * so under the card's version line – "Synced from another device — needs your permission" –
 * and again as the caption of its own details page. Its switch is the ordinary one: turning it
 * on runs `extension.setEnabled`, and the desktop answers with the install prompt (the
 * permission warnings) before anything is enabled – nothing is granted from the page.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { ExtensionDetails } = await import('../ExtensionDetails')
const { ExtensionsPage } = await import('../ExtensionsPage')
const { SYNCED_PENDING_LINE } = await import('@renderer/lib/extensions/promptCopy')

const ID = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const NOW = 1_800_000_000_000

function ext(over: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: ID,
    name: 'Dark Reader',
    version: '4.9.132',
    description: 'Dark mode for every website',
    path: '/x',
    enabled: true,
    icon: null,
    popup: null,
    error: null,
    source: 'chrome-web-store',
    publisher: 'chrome-web-store',
    updateUrl: null,
    installedAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: [],
    hostPermissions: [],
    optionsPage: null,
    newTabPage: null,
    newTabOverride: false,
    warnings: ['Read and change all your data on all websites'],
    pendingWarnings: null,
    updateState: 'unknown',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: null,
    errors: [],
    ...over
  }
}

const pending = (over: Partial<ExtensionInfo> = {}): ExtensionInfo =>
  ext({ enabled: false, pendingApproval: true, ...over })

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

function page(extensions: ExtensionInfo[]): HTMLElement {
  const state = {
    extensions,
    extensionUpdates: { lastCheckedAt: null, checking: false }
  } as unknown as UIState
  return render(createElement(ExtensionsPage, { state }))
}

function details(e: ExtensionInfo): HTMLElement {
  return render(
    createElement(ExtensionDetails, {
      ext: e,
      scrolled: false,
      menuOpen: false,
      onBack: () => undefined,
      onMenu: () => undefined
    })
  )
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.restoreAllMocks()
})

const pendingLine = (h: HTMLElement): HTMLElement | null =>
  h.querySelector<HTMLElement>('[data-pending-approval]')

describe('the synced landing’s line on the list card', () => {
  it('reads "Synced from another device — needs your permission" under the version line, in the warn tone, on the pending card alone', () => {
    expect(SYNCED_PENDING_LINE).toBe('Synced from another device — needs your permission')
    const h = page([pending(), ext({ id: OTHER, name: 'Quiet' })])
    const cards = [...h.querySelectorAll<HTMLElement>('.zen-ext-card')]
    expect(cards).toHaveLength(2)
    const line = pendingLine(cards[0]!)
    expect(line?.textContent).toBe(SYNCED_PENDING_LINE)
    expect(line?.classList.contains('zen-ext-sub')).toBe(true)
    expect(line?.getAttribute('data-tone')).toBe('warn')
    // Under the version-and-source line, inside the card's text block.
    const subs = [...cards[0]!.querySelectorAll<HTMLElement>('.zen-ext-sub')]
    expect(subs.map((s) => s.textContent)).toEqual([
      'v4.9.132 · Chrome Web Store',
      SYNCED_PENDING_LINE
    ])
    expect(pendingLine(cards[1]!)).toBeNull()
    expect(cards[1]!.textContent).not.toContain('Synced from another device')
    // The landing is off, so the card takes the disabled look of any extension turned off.
    expect(cards[0]!.hasAttribute('data-disabled')).toBe(true)
    expect(cards[1]!.hasAttribute('data-disabled')).toBe(false)
  })

  it('an extension the user installed here, on or off, says nothing of sync', () => {
    const h = page([
      ext({ enabled: false }),
      ext({ id: OTHER, source: 'unpacked', publisher: null })
    ])
    expect(h.querySelectorAll('[data-pending-approval]')).toHaveLength(0)
    expect(h.textContent).not.toContain('Synced from another device')
  })

  it('its switch is off and is the ordinary one: Enable runs extension.setEnabled, and the desktop’s prompt follows on the main side – the page grants nothing', () => {
    const h = page([pending()])
    const toggle = h.querySelector<HTMLButtonElement>('.zen-ext-card [role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Dark Reader enabled')
    act(() => toggle.click())
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', { id: ID, enabled: true })
    // Nothing else is asked of the main side from the page: no grant, no approval of its own.
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['extension.setEnabled'])
  })

  it('a load error keeps the red line first; the pending line still stands under it', () => {
    const h = page([pending({ error: 'Manifest file is missing or unreadable' })])
    const subs = [...h.querySelectorAll<HTMLElement>('.zen-ext-card .zen-ext-sub')]
    expect(subs.map((s) => [s.textContent, s.getAttribute('data-tone')])).toEqual([
      ['Manifest file is missing or unreadable', 'danger'],
      [SYNCED_PENDING_LINE, 'warn']
    ])
  })
})

describe('the synced landing’s line on the details page', () => {
  it('is the intro’s warn caption under the description, and the header switch runs extension.setEnabled', () => {
    const h = details(pending())
    const intro = h.querySelector<HTMLElement>('.zen-ext-intro')!
    expect(intro.querySelector('.zen-v2-body')?.textContent).toBe('Dark mode for every website')
    const line = pendingLine(intro)
    expect(line?.textContent).toBe(SYNCED_PENDING_LINE)
    expect(line?.classList.contains('zen-v2-caption')).toBe(true)
    expect(line?.getAttribute('data-tone')).toBe('warn')
    const toggle = h.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    act(() => toggle.click())
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', { id: ID, enabled: true })
  })

  it('shows the intro for the line alone when the extension has no description, and not at all for an ordinary extension without one', () => {
    const bare = details(pending({ description: '' }))
    expect(bare.querySelector('.zen-ext-intro')).not.toBeNull()
    expect(pendingLine(bare)?.textContent).toBe(SYNCED_PENDING_LINE)
    act(() => root?.unmount())
    host?.remove()
    const plain = details(ext({ description: '' }))
    expect(plain.querySelector('.zen-ext-intro')).toBeNull()
    expect(pendingLine(plain)).toBeNull()
  })
})

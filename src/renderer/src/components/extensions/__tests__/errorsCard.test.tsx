// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionErrorEntry, ExtensionInfo, UIState } from '@shared/types'

/*
 * The desktop's side of the error console (wave 4 of the extensions UI): the Errors card on the
 * details level – the lines newest first as static rows with the level's glyph, "Clear errors"
 * in a §9.11 footer once there is something to clear, the one-row empty state (§9.17) – and the
 * console's summary on the list card's trailing side in the status ink.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { ExtensionDetails } = await import('../ExtensionDetails')
const { ExtensionsPage } = await import('../ExtensionsPage')

const ID = 'a'.repeat(32)
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
    warnings: [],
    pendingWarnings: null,
    updateState: 'unknown',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: null,
    errors: [],
    ...over
  }
}

function entry(over: Partial<ExtensionErrorEntry>): ExtensionErrorEntry {
  return {
    id: 1,
    level: 'error',
    source: 'worker',
    message: 'Uncaught TypeError: x is not a function',
    url: `chrome-extension://${ID}/background.js`,
    line: 12,
    context: null,
    at: NOW - 3_600_000,
    lastAt: NOW - 3_600_000,
    count: 1,
    ...over
  }
}

const CONSOLE: ExtensionErrorEntry[] = [
  entry({}),
  entry({
    id: 2,
    level: 'warning',
    source: 'content',
    message: 'Deprecated API',
    url: 'https://news.example/app.js',
    line: null,
    at: NOW - 600_000,
    lastAt: NOW - 300_000,
    count: 3
  })
]

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
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

const card = (h: HTMLElement): HTMLElement => {
  const found = h.querySelector<HTMLElement>('.zen-ext-errors')
  if (!found) throw new Error('no Errors card')
  return found
}

describe('the Errors card on the details level', () => {
  it('lists the console newest first: the level’s glyph, the message, where and when', () => {
    const h = details(ext({ errors: CONSOLE }))
    const c = card(h)
    expect(c.querySelector('.zen-v2-card-title')?.textContent).toBe('Errors')
    expect(c.querySelector('.zen-v2-card-title svg')).not.toBeNull()
    const rows = [...c.querySelectorAll<HTMLElement>('.zen-v2-row')]
    expect(rows).toHaveLength(2)
    // Static rows (§9.34): no role, no tab stop; the glyph is the row's lead.
    for (const row of rows) {
      expect(row.hasAttribute('data-static')).toBe(true)
      expect(row.querySelector('.zen-v2-row-lead')).not.toBeNull()
    }
    expect(rows.map((r) => r.querySelector('.zen-v2-label')?.textContent)).toEqual([
      'Deprecated API',
      'Uncaught TypeError: x is not a function'
    ])
    expect(rows.map((r) => r.querySelector('.zen-v2-description')?.textContent)).toEqual([
      'Content script · 5 minutes ago · ×3 · https://news.example/app.js',
      'Service worker · 1 hour ago · background.js:12'
    ])
    expect(rows.map((r) => r.classList.contains('zen-ext-log-warning'))).toEqual([true, false])
    expect(rows.map((r) => r.classList.contains('zen-ext-log-error'))).toEqual([false, true])
    // Clear errors: a danger secondary in the card's footer, running the command.
    const clear = c.querySelector<HTMLButtonElement>('.zen-ext-card-footer .zen-v2-button')
    expect(clear?.textContent).toBe('Clear errors')
    expect(clear?.hasAttribute('data-danger')).toBe(true)
    expect(clear?.hasAttribute('data-primary')).toBe(false)
    act(() => clear!.click())
    expect(invoke).toHaveBeenCalledWith('extension.clearErrors', { id: ID })
  })

  it('with a clean console: the one plain row, no footer', () => {
    const c = card(details(ext({})))
    const rows = [...c.querySelectorAll<HTMLElement>('.zen-v2-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toBe('No errors')
    expect(rows[0]!.hasAttribute('data-static')).toBe(true)
    expect(c.querySelector('.zen-ext-card-footer')).toBeNull()
    expect(c.querySelector('.zen-v2-button')).toBeNull()
  })
})

describe('the list card’s console summary', () => {
  function page(extensions: ExtensionInfo[]): HTMLElement {
    const state = {
      extensions,
      extensionUpdates: { lastCheckedAt: null, checking: false }
    } as unknown as UIState
    return render(createElement(ExtensionsPage, { state }))
  }

  it('says how many errors and warnings on the trailing side, in the worst level’s ink', () => {
    const h = page([
      ext({ errors: CONSOLE }),
      ext({ id: 'b'.repeat(32), name: 'Quiet' }),
      ext({ id: 'c'.repeat(32), name: 'Warned', errors: [CONSOLE[1]!] })
    ])
    const cards = [...h.querySelectorAll<HTMLElement>('.zen-ext-card')]
    expect(cards).toHaveLength(3)
    const summary = (c: HTMLElement): [string | undefined, string | null] | null => {
      const el = c.querySelector<HTMLElement>('.zen-ext-card-errors')
      return el ? [el.textContent ?? undefined, el.getAttribute('data-tone')] : null
    }
    expect(summary(cards[0]!)).toEqual(['1 error, 1 warning', 'danger'])
    expect(summary(cards[1]!)).toBeNull()
    expect(summary(cards[2]!)).toEqual(['1 warning', 'warn'])
    // It sits among the controls, before the switch.
    const controls = cards[0]!.querySelector('.zen-ext-card-controls')
    expect(controls?.firstElementChild?.classList.contains('zen-ext-card-errors')).toBe(true)
  })

  it('says nothing while the load error is the sub-line: one red line per card', () => {
    const h = page([
      ext({
        error: 'Manifest file is missing or unreadable',
        errors: [entry({ source: 'load', message: 'Manifest file is missing or unreadable' })]
      })
    ])
    const card = h.querySelector<HTMLElement>('.zen-ext-card')!
    expect(card.textContent).toContain('Manifest file is missing or unreadable')
    expect(card.querySelector('.zen-ext-card-errors')).toBeNull()
  })
})

describe('the Options card’s private-windows switch', () => {
  const privateRow = (h: HTMLElement): HTMLLabelElement => {
    const row = [...h.querySelectorAll<HTMLLabelElement>('.zen-v2-check-row')].find((r) =>
      r.textContent?.includes('Allow in private windows')
    )
    if (!row) throw new Error('no private-windows row')
    return row
  }

  it('reads allowPrivate and runs extension.setAllowPrivate, like the phone switch', () => {
    const h = details(ext({ allowPrivate: false }))
    const row = privateRow(h)
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
    expect(row.getAttribute('aria-disabled')).not.toBe('true')
    expect(row.textContent).not.toContain('Not available yet')
    act(() => box.click())
    expect(invoke).toHaveBeenCalledWith('extension.setAllowPrivate', { id: ID, allowed: true })
  })

  it('is checked while the extension is allowed in private windows', () => {
    const on = privateRow(details(ext({ allowPrivate: true })))
    expect(on.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  })

  it('is disabled while the extension failed to load, as the file-URLs switch is', () => {
    const h = details(ext({ error: 'Manifest file is missing or unreadable' }))
    const boxes = [
      ...h.querySelectorAll<HTMLInputElement>('.zen-v2-check-row input[type="checkbox"]')
    ]
    expect(boxes).toHaveLength(2)
    expect(boxes.map((b) => b.disabled)).toEqual([true, true])
    expect(privateRow(h).getAttribute('aria-disabled')).toBe('true')
  })
})

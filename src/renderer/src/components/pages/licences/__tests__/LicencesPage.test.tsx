// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { licenceLine, type LicenceEntry } from '@shared/licences'
import type { Tab, UIState } from '@shared/types'

/*
 * The Licences page tab (`zen://licences`, Settings › About › Open-source licences; Chrome's
 * chrome://credits, settings-73): the title block and search field, the Engine group – Electron's
 * entry and the Chromium row that opens Electron's credits document in a tab beside – on desktop
 * hosts and not on Android, the Packages group counted in its aside, a row folding open on its
 * homepage link and licence text (or the line saying the package ships none), the search that
 * filters by name, version and licence, marks the terms and moves the tab's URL to `?q=` without
 * a history entry, and a query the URL brings.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ENTRIES: LicenceEntry[] = [
  { name: 'zustand', version: '5.0.0', licence: 'MIT', text: 'MIT License\n\nzustand text' },
  {
    name: 'electron',
    version: '44.4.5',
    licence: 'MIT',
    url: 'https://www.electronjs.org',
    text: 'Copyright (c) Electron contributors'
  },
  { name: 'lucide-react', version: '0.500.0', licence: 'ISC', url: 'https://lucide.dev/' },
  { name: 'Alpha-Sorted', version: '1.2.3', licence: '', url: 'https://github.com/a/sorted' }
]

vi.mock('virtual:zenium-licences', () => ({ default: ENTRIES }))

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { LicencesPage } = await import('../LicencesPage')
const { browserStore } = await import('@renderer/lib/browserStore')

function state(platform = 'linux'): UIState {
  return {
    platform,
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {}
  } as unknown as UIState
}

function tab(url = 'zen://licences'): Tab {
  return {
    id: 'licences',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Licences',
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
    openerTabId: null
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

/** Mounts the page and lets the lazy list land (one microtask past the import). */
async function mountPage(t: Tab = tab(), s: UIState = state()): Promise<HTMLElement> {
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(LicencesPage, { state: s, tab: t })))
  await act(async () => {
    await Promise.resolve()
  })
  return mount
}

function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A row's two lines, label then description, as one string. */
function rowText(button: HTMLElement): string {
  return `${text(button.querySelector('.zen-page-row-label'))} ${text(button.querySelector('.zen-page-row-desc'))}`
}

/** The packages a group lists, in order. */
function listed(el: HTMLElement, group: 'engine' | 'packages'): string[] {
  return [...el.querySelectorAll(`[data-testid="licences-${group}"] [data-package]`)].map(
    (r) => r.getAttribute('data-package') ?? ''
  )
}

function rowButton(el: HTMLElement, name: string): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>(`[data-package="${name}"] .zen-page-row-text`)!
}

function search(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('[data-testid="licences-search"]')!
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  vi.useRealTimers()
})

describe('LicencesPage', () => {
  it('lists the engine and the packages, sorted by name, each row naming version and licence', async () => {
    const el = await mountPage()
    expect(text(el.querySelector('h1.zen-page-title'))).toBe('Licences')
    expect(search(el).placeholder).toBe('Find a package')
    expect(listed(el, 'engine')).toEqual(['electron', 'chromium'])
    expect(listed(el, 'packages')).toEqual(['Alpha-Sorted', 'lucide-react', 'zustand'])
    expect(
      text(el.querySelector('[data-testid="licences-packages"] .zen-page-heading-aside'))
    ).toBe('3')
    expect(rowText(rowButton(el, 'zustand'))).toBe('zustand 5.0.0 · MIT')
    expect(rowText(rowButton(el, 'Alpha-Sorted'))).toBe('Alpha-Sorted 1.2.3 · No licence declared')
    expect(rowButton(el, 'zustand').getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('[data-testid="licences-loading"]')).toBeNull()
  })

  it('folds a row open on its homepage link and licence text, and closed again', async () => {
    const el = await mountPage()
    const button = rowButton(el, 'electron')
    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const fold = el.querySelector<HTMLElement>(`#${button.getAttribute('aria-controls')}`)
    expect(text(fold?.querySelector('.zen-licences-text'))).toBe(
      'Copyright (c) Electron contributors'
    )
    const link = fold!.querySelector<HTMLAnchorElement>('a.zen-licences-homepage')!
    expect(text(link)).toBe('www.electronjs.org')
    await act(async () => link.click())
    expect(calls('app.openExternal')).toEqual([{ url: 'https://www.electronjs.org' }])

    // A package that ships no licence file says so where the text would be.
    await act(async () => rowButton(el, 'lucide-react').click())
    expect(text(el.querySelector('[data-package="lucide-react"] .zen-licences-text-missing'))).toBe(
      'Released under ISC; the package ships no licence file.'
    )

    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('[data-package="electron"] .zen-licences-fold')).toBeNull()
  })

  it('opens Electron’s Chromium credits document in a tab beside this one', async () => {
    const el = await mountPage()
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[data-testid="licences-chromium"]')!.click()
    )
    expect(calls('tab.create')).toEqual([
      { url: 'zen://chromium-licences', afterTabId: 'licences' }
    ])
  })

  it('filters by name, version and licence, marks the terms and moves the URL without a history entry', async () => {
    const el = await mountPage()
    await type(search(el), 'mit')
    expect(listed(el, 'engine')).toEqual(['electron'])
    expect(listed(el, 'packages')).toEqual(['zustand'])
    expect(
      text(el.querySelector('[data-testid="licences-packages"] .zen-page-heading-aside'))
    ).toBe('1')
    expect(el.querySelector('[data-package="zustand"] mark')).not.toBeNull()
    expect(calls('page.navigate')).toEqual([
      { tabId: 'licences', section: null, replace: true, query: { q: 'mit' } }
    ])

    await type(search(el), '0.500')
    expect(listed(el, 'packages')).toEqual(['lucide-react'])
    expect(el.querySelector('[data-testid="licences-engine"]')).toBeNull()

    await type(search(el), 'nothing-like-it')
    expect(text(el.querySelector('[data-testid="licences-empty"]'))).toBe(
      'No packages match “nothing-like-it”'
    )
  })

  it('opens searching when the URL brings a query, without pushing it back', async () => {
    const el = await mountPage(tab('zen://licences?q=chromium'))
    expect(search(el).value).toBe('chromium')
    expect(listed(el, 'engine')).toEqual(['chromium'])
    expect(el.querySelector('[data-testid="licences-packages"]')).toBeNull()
    expect(calls('page.navigate')).toEqual([])
  })

  it('lists the packages alone on Android, where the engine is the device’s WebView', async () => {
    const el = await mountPage(tab(), state('android'))
    expect(el.querySelector('[data-testid="licences-engine"]')).toBeNull()
    expect(listed(el, 'packages')).toEqual(['Alpha-Sorted', 'electron', 'lucide-react', 'zustand'])
  })

  it('words a row’s second line from what the entry has', () => {
    expect(licenceLine({ name: 'a', version: '1.0.0', licence: 'MIT' })).toBe('1.0.0 · MIT')
    expect(licenceLine({ name: 'a', version: '', licence: 'MIT' })).toBe('MIT')
    expect(licenceLine({ name: 'a', version: '1.0.0', licence: '', text: 'x' })).toBe(
      '1.0.0 · Licence below'
    )
    expect(licenceLine({ name: 'a', version: '1.0.0', licence: '' })).toBe(
      '1.0.0 · No licence declared'
    )
  })
})

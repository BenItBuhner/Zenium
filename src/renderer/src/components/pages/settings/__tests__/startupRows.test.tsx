// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MAX_STARTUP_PAGES } from '@core/startup'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ExtensionControl, Settings, Tab, UIState } from '@shared/types'

/*
 * Settings › On startup (W6-3, settings-47): the group as data – the "When Zenium starts" choice
 * with Chrome's three options, and under "Open a specific page or set of pages" the list rows
 * (Edit… / Remove in each page's sheet), Add a new page, Use current pages, the empty state and
 * the cap; drawn controlled with an extension's pages as static rows while an enabled
 * extension's `chrome_settings_overrides.startup_pages` holds the setting; and the one-field
 * form Add and Edit share.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { currentPages, startupGroup } = await import('../startup')
const { StartupPageForm } = await import('../startupBlocks')
const { allRows, controlledRuns, findRow } = await import('../model')

type Row = ReturnType<typeof allRows>[number]

const EXT = 'a'.repeat(32)
const PAGES = ['https://example.com/', 'https://news.example/today']

function tab(id: string, url: string): Tab {
  return { id, url, title: id, spaceId: 'space', containerId: 'default' } as unknown as Tab
}

function state(
  settings: Partial<Settings> = {},
  patch: Partial<UIState> = {},
  extensionControls: Record<string, ExtensionControl> = {}
): UIState {
  return {
    platform: 'linux',
    settings: { ...DEFAULT_SETTINGS, ...settings },
    extensionControls,
    tabs: {
      a: tab('a', 'https://a.example/'),
      b: tab('b', 'https://b.example/path'),
      settings: tab('settings', 'zenium://settings'),
      pinned: tab('pinned', 'https://pinned.example/')
    },
    essentialTabIds: ['pinned'],
    spaces: [{ id: 'space', name: 'Personal', activeTabId: 'a', tabIds: ['a', 'settings', 'b'] }],
    window: { id: 'w', kind: 'main' },
    ...patch
  } as unknown as UIState
}

function group(
  settings: Partial<Settings> = {},
  patch: Partial<UIState> = {},
  extensionControls: Record<string, ExtensionControl> = {}
): { group: ReturnType<typeof startupGroup>; patches: Partial<Settings>[] } {
  const patches: Partial<Settings>[] = []
  const s = state(settings, patch, extensionControls)
  return { group: startupGroup({ state: s, set: (p) => patches.push(p) }), patches }
}

function row(g: ReturnType<typeof startupGroup>, id: string): Row {
  const found = findRow([g], id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

const ids = (g: ReturnType<typeof startupGroup>): string[] => g.rows.map((r) => r.id)

describe('Settings › On startup – the choice', () => {
  it('is one value row with Chrome\u2019s three options, reading and writing startup.mode', () => {
    const { group: g, patches } = group({ startup: { mode: 'continue', pages: PAGES } })
    expect(g.id).toBe('startup')
    expect(g.heading).toBe('On startup')
    expect(ids(g)).toEqual(['startup-mode'])
    const mode = row(g, 'startup-mode')
    if (mode.kind !== 'value') throw new Error('not a value row')
    expect(mode.label).toBe('When Zenium starts')
    expect(mode.value).toBe('continue')
    expect(mode.options.map((o) => o.label)).toEqual([
      'Open the New Tab page',
      'Continue where you left off',
      'Open a specific page or set of pages'
    ])
    expect(mode.controlled).toBeUndefined()
    mode.onChange('pages')
    // A mode change keeps the pages list the user built.
    expect(patches).toEqual([{ startup: { mode: 'pages', pages: PAGES } }])
  })

  it('shows no list under "Open the New Tab page" or "Continue where you left off"', () => {
    expect(ids(group({ startup: { mode: 'newTab', pages: PAGES } }).group)).toEqual([
      'startup-mode'
    ])
    expect(ids(group({ startup: { mode: 'continue', pages: PAGES } }).group)).toEqual([
      'startup-mode'
    ])
  })
})

describe('Settings › On startup – "Open a specific page or set of pages"', () => {
  it('lists each page as an item row, then Add a new page and Use current pages', () => {
    const { group: g } = group({ startup: { mode: 'pages', pages: PAGES } })
    expect(ids(g)).toEqual([
      'startup-mode',
      'startup-page:0',
      'startup-page:1',
      'startup-add-page',
      'startup-use-current'
    ])
    const first = row(g, 'startup-page:0')
    const second = row(g, 'startup-page:1')
    expect(first.kind).toBe('item')
    expect(first.label).toBe('example.com')
    expect(second.label).toBe('news.example/today')
    if (first.kind !== 'item') throw new Error('not an item row')
    expect(first.sheet.title).toBe('example.com')
    expect(first.sheet.description).toBe('https://example.com/')
    expect(allRows([first.sheet.groups[0]]).map((r) => r.id)).toEqual([
      'startup-page:0:edit',
      'startup-page:0:remove'
    ])
  })

  it('a page\u2019s sheet holds Edit… as a form and Remove as a destructive action', () => {
    const { group: g, patches } = group({ startup: { mode: 'pages', pages: PAGES } })
    const edit = row(g, 'startup-page:1:edit')
    if (edit.kind !== 'action') throw new Error('not an action row')
    expect(edit.button).toBe('Edit…')
    expect(edit.form?.title).toBe('Edit page')
    const remove = row(g, 'startup-page:1:remove')
    if (remove.kind !== 'action') throw new Error('not an action row')
    expect(remove.destructive).toBe(true)
    expect(remove.form).toBeUndefined()
    remove.onPress?.()
    expect(patches).toEqual([{ startup: { mode: 'pages', pages: [PAGES[0]] } }])
  })

  it('an empty list says so in one row and stands on the New Tab page', () => {
    const { group: g } = group({ startup: { mode: 'pages', pages: [] } })
    expect(ids(g)).toEqual([
      'startup-mode',
      'startup-pages-empty',
      'startup-add-page',
      'startup-use-current'
    ])
    const empty = row(g, 'startup-pages-empty')
    expect(empty.kind).toBe('info')
    expect(empty.label).toBe('No pages yet')
    expect(empty.description).toBe('Zenium opens the New Tab page until you add one.')
  })

  it('Add a new page opens the form; the list full, the row is held with the reason', () => {
    const { group: g } = group({ startup: { mode: 'pages', pages: PAGES } })
    const add = row(g, 'startup-add-page')
    if (add.kind !== 'action') throw new Error('not an action row')
    expect(add.button).toBe('Add…')
    expect(add.form?.title).toBe('Add a new page')
    expect(add.disabled).toBeFalsy()
    expect(add.description).toBeUndefined()

    const many = Array.from({ length: MAX_STARTUP_PAGES }, (_, i) => `https://p${i}.example/`)
    const full = row(group({ startup: { mode: 'pages', pages: many } }).group, 'startup-add-page')
    if (full.kind !== 'action') throw new Error('not an action row')
    expect(full.disabled).toBe(true)
    expect(full.description).toBe(`The list holds ${MAX_STARTUP_PAGES} pages at most.`)
  })

  it('Use current pages replaces the list with the open web pages in the sidebar\u2019s order', () => {
    const { group: g, patches } = group({ startup: { mode: 'pages', pages: PAGES } })
    const use = row(g, 'startup-use-current')
    if (use.kind !== 'action') throw new Error('not an action row')
    expect(use.button).toBe('Use current')
    expect(use.disabled).toBe(false)
    expect(use.description).toBe('Replaces the list with the 3 pages open now.')
    use.onPress?.()
    // Essentials first, then the space's tabs; the internal page left out.
    expect(patches).toEqual([
      {
        startup: {
          mode: 'pages',
          pages: ['https://pinned.example/', 'https://a.example/', 'https://b.example/path']
        }
      }
    ])
  })

  it('Use current pages is held with no web page open, and in a private window', () => {
    const none = row(
      group(
        { startup: { mode: 'pages', pages: [] } },
        { essentialTabIds: [], spaces: [{ id: 'space', tabIds: ['settings'] }] as never }
      ).group,
      'startup-use-current'
    )
    if (none.kind !== 'action') throw new Error('not an action row')
    expect(none.disabled).toBe(true)
    expect(none.description).toBe('Open the pages you want first.')

    const priv = state({}, { window: { id: 'p', kind: 'private' } as never })
    expect(currentPages(priv)).toEqual([])
    const one = state(
      {},
      { essentialTabIds: [], spaces: [{ id: 'space', tabIds: ['a'] }] as never }
    )
    expect(currentPages(one)).toEqual(['https://a.example/'])
    const singular = row(
      group(
        { startup: { mode: 'pages', pages: [] } },
        { essentialTabIds: [], spaces: [{ id: 'space', tabIds: ['a'] }] as never }
      ).group,
      'startup-use-current'
    )
    expect(singular.description).toBe('Replaces the list with the page open now.')
  })
})

describe('Settings › On startup – held by an extension\u2019s startup_pages', () => {
  const HELD = ['https://ext.example/one', 'https://ext.example/two']
  const controls: Record<string, ExtensionControl> = {
    'startup.mode': { extensionId: EXT, name: 'Startup Pages', value: 'pages' },
    'startup.pages': { extensionId: EXT, name: 'Startup Pages', value: HELD }
  }

  it('the mode row shows the choice in effect, controlled, whatever the user chose', () => {
    for (const own of ['newTab', 'continue', 'pages'] as const) {
      const { group: g } = group({ startup: { mode: own, pages: PAGES } }, {}, controls)
      const mode = row(g, 'startup-mode')
      if (mode.kind !== 'value') throw new Error('not a value row')
      expect(mode.value).toBe('pages')
      expect(mode.controlled?.extensionId).toBe(EXT)
      expect(mode.controlled?.name).toBe('Startup Pages')
    }
  })

  it('the extension\u2019s pages stand as static rows in one run; the editor\u2019s rows are left out', () => {
    const { group: g } = group({ startup: { mode: 'newTab', pages: PAGES } }, {}, controls)
    expect(ids(g)).toEqual(['startup-mode', 'startup-page:0', 'startup-page:1'])
    const first = row(g, 'startup-page:0')
    expect(first.kind).toBe('info')
    expect(first.label).toBe('ext.example/one')
    expect(first.controlled?.extensionId).toBe(EXT)
    expect(findRow([g], 'startup-add-page')).toBeNull()
    expect(findRow([g], 'startup-use-current')).toBeNull()
    expect(findRow([g], 'startup-pages-empty')).toBeNull()
    // One "Controlled by" indicator closes the run of the three rows (§10.5).
    expect(controlledRuns(g.rows)).toEqual([0, 0, 3])
  })

  it('Disable goes through the host\u2019s own path', () => {
    const { group: g } = group({}, {}, controls)
    const mode = row(g, 'startup-mode')
    mode.controlled?.onDisable()
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', { id: EXT, enabled: false })
  })

  it('with the extension gone the rows are the user\u2019s own again', () => {
    const { group: g } = group({ startup: { mode: 'pages', pages: PAGES } }, {}, {})
    expect(ids(g)).toEqual([
      'startup-mode',
      'startup-page:0',
      'startup-page:1',
      'startup-add-page',
      'startup-use-current'
    ])
    expect(row(g, 'startup-mode').controlled).toBeUndefined()
    expect(row(g, 'startup-page:0').kind).toBe('item')
  })
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

beforeEach(() => invoke.mockClear())

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function input(el: HTMLElement): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>('#startup-page-url')
  if (!found) throw new Error('no url input')
  return found
}

function type(field: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blur(field: HTMLInputElement): void {
  act(() => {
    field.dispatchEvent(new Event('blur', { bubbles: false }))
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function enter(field: HTMLInputElement): void {
  act(() => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

describe('StartupPageForm – Add a new page / Edit page', () => {
  it('takes a web address, completes it, and hands it over on the button or Enter', () => {
    const onSubmit = vi.fn()
    const close = vi.fn()
    const el = render(
      <StartupPageForm action="Add" pages={PAGES} onSubmit={onSubmit} close={close} />
    )
    expect(el.querySelector('[data-testid="startup-page-form"]')).not.toBeNull()
    expect(el.querySelector('label')?.textContent).toBe('Site URL')
    const field = input(el)
    expect(field.placeholder).toBe('example.com')
    expect(button(el, 'Add').disabled).toBe(true)
    type(field, 'docs.example/start')
    expect(button(el, 'Add').disabled).toBe(false)
    act(() => button(el, 'Add').click())
    expect(onSubmit).toHaveBeenCalledWith('https://docs.example/start')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Enter submits; Cancel closes without a page', () => {
    const onSubmit = vi.fn()
    const close = vi.fn()
    const el = render(
      <StartupPageForm action="Add" pages={PAGES} onSubmit={onSubmit} close={close} />
    )
    type(input(el), 'https://docs.example/')
    enter(input(el))
    expect(onSubmit).toHaveBeenCalledWith('https://docs.example/')
    act(() => button(el, 'Cancel').click())
    expect(close).toHaveBeenCalledTimes(2)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('refuses what is not a web page, and a page already in the list, once the field is left', () => {
    const onSubmit = vi.fn()
    const el = render(
      <StartupPageForm action="Add" pages={PAGES} onSubmit={onSubmit} close={vi.fn()} />
    )
    const field = input(el)
    type(field, 'zenium://settings')
    // Not shown while typing; the button is held.
    expect(el.querySelector('#startup-page-url-error')).toBeNull()
    expect(button(el, 'Add').disabled).toBe(true)
    blur(field)
    expect(el.querySelector('#startup-page-url-error')?.textContent).toBe(
      'Enter a web address, like example.com'
    )
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe('startup-page-url-error')
    type(field, 'example.com')
    expect(el.querySelector('#startup-page-url-error')?.textContent).toBe(
      'This page is already in the list'
    )
    enter(field)
    expect(onSubmit).not.toHaveBeenCalled()
    type(field, 'example.com/new')
    expect(el.querySelector('#startup-page-url-error')).toBeNull()
    enter(field)
    expect(onSubmit).toHaveBeenCalledWith('https://example.com/new')
  })

  it('editing, the page\u2019s own address is no duplicate and the verb is Save', () => {
    const onSubmit = vi.fn()
    const el = render(
      <StartupPageForm
        initial={PAGES[1]}
        action="Save"
        pages={PAGES}
        index={1}
        onSubmit={onSubmit}
        close={vi.fn()}
      />
    )
    const field = input(el)
    expect(field.value).toBe(PAGES[1])
    expect(button(el, 'Save').disabled).toBe(false)
    type(field, PAGES[0])
    blur(field)
    expect(el.querySelector('#startup-page-url-error')?.textContent).toBe(
      'This page is already in the list'
    )
    type(field, 'news.example/tomorrow')
    act(() => button(el, 'Save').click())
    expect(onSubmit).toHaveBeenCalledWith('https://news.example/tomorrow')
  })
})

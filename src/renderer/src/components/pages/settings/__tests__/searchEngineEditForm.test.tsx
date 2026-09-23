// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SEARCH_ENGINES, customSearchEngine } from '@shared/search'
import type { SearchEngine } from '@shared/types'

/*
 * Search › Added search engines › Edit's form (omnibox-09, settings-43): the Add form's fields
 * pre-filled from the engine with a Shortcut field between them, each checked as typed (§9.12),
 * Save held until the three are in order, the browser's refusal shown under the field it names.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SearchEngineEditForm } = await import('../SearchEngineEditForm')

const mine = customSearchEngine('Mine', 'https://mine.example/?q=%s', DEFAULT_SEARCH_ENGINES)
const wiki = customSearchEngine('Wiki', 'https://wiki.example/w?search=%s', [
  ...DEFAULT_SEARCH_ENGINES,
  mine
])
const ENGINES: SearchEngine[] = [...DEFAULT_SEARCH_ENGINES, mine, wiki]

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: React.ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function field(el: HTMLElement, id: string): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(`#${id}`)
  if (!found) throw new Error(`no field ${id}`)
  return found
}

function alerts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? '')
}

function form(
  onSave: (edits: unknown) => Promise<unknown> | void = vi.fn(),
  close = vi.fn()
): { el: HTMLElement; onSave: typeof onSave; close: typeof close } {
  const el = render(
    createElement(SearchEngineEditForm, { engine: mine, engines: ENGINES, onSave, close })
  )
  return { el, onSave, close }
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
})

describe('the Edit search engine form', () => {
  it('pre-fills name, shortcut and URL from the engine, its three fields labelled, Save ready', () => {
    const { el } = form()
    expect(field(el, 'search-engine-edit-name').value).toBe('Mine')
    expect(field(el, 'search-engine-edit-keyword').value).toBe('@mine')
    expect(field(el, 'search-engine-edit-url').value).toBe('https://mine.example/?q=%s')
    expect(el.querySelector('label[for="search-engine-edit-name"]')?.textContent).toBe('Name')
    expect(el.querySelector('label[for="search-engine-edit-keyword"]')?.textContent).toBe(
      'Shortcut'
    )
    expect(el.querySelector('label[for="search-engine-edit-url"]')?.textContent).toBe(
      'URL with %s in place of query'
    )
    expect(button(el, 'Save').disabled).toBe(false)
    expect(alerts(el)).toEqual([])
  })

  it('refuses a shortcut with spaces, one of Zenium’s scopes, or another engine’s word under the field as typed; empty derives from the name', () => {
    const { el } = form()
    const keyword = field(el, 'search-engine-edit-keyword')
    type(keyword, 'two words')
    expect(alerts(el)).toEqual(['A shortcut is one word, with no spaces'])
    expect(keyword.getAttribute('aria-invalid')).toBe('true')
    expect(button(el, 'Save').disabled).toBe(true)
    type(keyword, 'tabs')
    expect(alerts(el)).toEqual(['@tabs is one of Zenium’s own shortcuts'])
    type(keyword, '@wiki')
    expect(alerts(el)).toEqual(['Wiki already answers to @wiki'])
    // Its own current shortcut is no clash.
    type(keyword, '@mine')
    expect(alerts(el)).toEqual([])
    // Empty: the placeholder and the description name the shortcut the name derives.
    type(keyword, '')
    expect(alerts(el)).toEqual([])
    expect(keyword.placeholder).toBe('@mine')
    expect(el.textContent).toContain('empty for @mine')
    expect(button(el, 'Save').disabled).toBe(false)
    // The derived shortcut follows the name, unique among the other engines.
    type(field(el, 'search-engine-edit-name'), 'Google')
    expect(keyword.placeholder).toBe('@google2')
  })

  it('holds Save on an empty name or a template without %s, the template’s fault shown once left', () => {
    const { el } = form()
    type(field(el, 'search-engine-edit-name'), '   ')
    expect(button(el, 'Save').disabled).toBe(true)
    type(field(el, 'search-engine-edit-name'), 'Mine')
    const url = field(el, 'search-engine-edit-url')
    type(url, 'https://mine.example/?q=')
    expect(button(el, 'Save').disabled).toBe(true)
    // Not while typing …
    expect(alerts(el)).toEqual([])
    // … but on Enter, or on leaving the field.
    act(() => url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(alerts(el)).toEqual(['Put %s where the search terms go'])
    expect(url.getAttribute('aria-invalid')).toBe('true')
  })

  it('saves the trimmed name and URL with the shortcut as typed, then closes', async () => {
    const onSave = vi.fn(async () => null)
    const { el, close } = form(onSave)
    type(field(el, 'search-engine-edit-name'), '  Mine Search ')
    type(field(el, 'search-engine-edit-keyword'), 'MS')
    type(field(el, 'search-engine-edit-url'), ' https://mine.example/find?q=%s ')
    act(() => button(el, 'Save').click())
    await settle()
    expect(onSave).toHaveBeenCalledWith({
      name: 'Mine Search',
      searchUrl: 'https://mine.example/find?q=%s',
      keyword: 'MS'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Enter in a field saves too; Cancel closes with nothing saved', async () => {
    const onSave = vi.fn(async () => null)
    const { el, close } = form(onSave)
    act(() =>
      field(el, 'search-engine-edit-name').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
    )
    await settle()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    act(() => button(el, 'Cancel').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('shows the browser’s refusal under the URL field and stays open; typing clears it', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('DuckDuckGo already answers to @ddg')
    })
    const { el, close } = form(onSave)
    act(() => button(el, 'Save').click())
    await settle()
    expect(alerts(el)).toEqual(['DuckDuckGo already answers to @ddg'])
    expect(close).not.toHaveBeenCalled()
    type(field(el, 'search-engine-edit-keyword'), 'mine2')
    expect(alerts(el)).toEqual([])
  })
})

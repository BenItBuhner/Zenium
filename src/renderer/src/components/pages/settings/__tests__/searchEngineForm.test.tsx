// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SearchEngineForm } from '../blocks'

/*
 * Search › Add search engine and › Edit search engine as one form (W4-10, #409's ask): `initial`
 * fills the fields for an edit and the verb is the caller's; the Shortcut field (Chrome's
 * Shortcut column) is checked by the engine's own keyword rules from `shared/search.ts` – one
 * word, no spaces, at most 64 characters after the `@` the engine adds, not one of Zenium's own
 * scopes – in §9.12's validation form; the button is held until the name and the template are
 * in – and, editing, the shortcut too: an engine never holds an empty word, where adding leaves
 * it the engine's to derive (the core's `search.addEngine` takes none yet) – and submit hands
 * the caller the three values.
 */

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

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

function input(el: HTMLElement, id: string): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(`#${id}`)
  if (!found) throw new Error(`no input ${id}`)
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

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function fieldBlock(el: HTMLElement, id: string): HTMLElement {
  const block = input(el, id).closest<HTMLElement>('.zen-settings-field-block')
  if (!block) throw new Error(`no field block for ${id}`)
  return block
}

const WIKI = {
  name: 'Wikipedia',
  url: 'https://en.wikipedia.org/w/index.php?search=%s',
  shortcut: '@wiki'
}

describe('the search-engine form: Add and Edit from one component', () => {
  it('Add: empty fields, the three of them in Chrome’s order, the caller’s verb, the button held', () => {
    const el = render(<SearchEngineForm action="Add" onSubmit={vi.fn()} close={vi.fn()} />)
    const ids = Array.from(el.querySelectorAll('input')).map((i) => i.id)
    expect(ids).toEqual(['search-engine-name', 'search-engine-shortcut', 'search-engine-url'])
    expect(input(el, 'search-engine-name').value).toBe('')
    expect(input(el, 'search-engine-shortcut').value).toBe('')
    expect(input(el, 'search-engine-url').value).toBe('')
    expect(el.querySelector('label[for="search-engine-shortcut"]')?.textContent).toBe('Shortcut')
    expect(button(el, 'Add').disabled).toBe(true)
    expect(el.querySelector('button[aria-busy]')).toBeNull()
  })

  it('Edit: `initial` fills the fields and the caller’s verb is Save, the button ready at once', () => {
    const el = render(
      <SearchEngineForm initial={WIKI} action="Save" onSubmit={vi.fn()} close={vi.fn()} />
    )
    expect(input(el, 'search-engine-name').value).toBe('Wikipedia')
    expect(input(el, 'search-engine-shortcut').value).toBe('@wiki')
    expect(input(el, 'search-engine-url').value).toBe(WIKI.url)
    expect(button(el, 'Save').disabled).toBe(false)
    expect(el.querySelector('[data-testid="search-engine-form"]')).not.toBeNull()
  })

  it('submit hands the caller the three values, trimmed, and closes once it settles', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const close = vi.fn()
    const el = render(<SearchEngineForm action="Add" onSubmit={onSubmit} close={close} />)
    type(input(el, 'search-engine-name'), '  Wikipedia ')
    type(input(el, 'search-engine-shortcut'), ' wiki ')
    type(input(el, 'search-engine-url'), ` ${WIKI.url} `)
    expect(button(el, 'Add').disabled).toBe(false)
    act(() => button(el, 'Add').click())
    await settle()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Wikipedia', url: WIKI.url, shortcut: 'wiki' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Add: the shortcut may be left empty – the button is not held by it, and submit hands the caller shortcut: "" for the engine to derive its own', async () => {
    const onSubmit = vi.fn()
    const close = vi.fn()
    const el = render(<SearchEngineForm action="Add" onSubmit={onSubmit} close={close} />)
    type(input(el, 'search-engine-name'), 'Wikipedia')
    type(input(el, 'search-engine-url'), WIKI.url)
    const shortcut = input(el, 'search-engine-shortcut')
    expect(shortcut.value).toBe('')
    blur(shortcut)
    // Empty is no problem: no message, no aria-invalid, the button ready on name and template.
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(
      fieldBlock(el, 'search-engine-shortcut').querySelector('.zen-settings-validation')
    ).toBeNull()
    expect(button(el, 'Add').disabled).toBe(false)
    act(() => button(el, 'Add').click())
    await settle()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Wikipedia', url: WIKI.url, shortcut: '' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Add: a typed shortcut is checked all the same – a space holds the button, the message shows once left', () => {
    const el = render(<SearchEngineForm action="Add" onSubmit={vi.fn()} close={vi.fn()} />)
    type(input(el, 'search-engine-name'), 'Wikipedia')
    type(input(el, 'search-engine-url'), WIKI.url)
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'wi ki')
    expect(button(el, 'Add').disabled).toBe(true)
    blur(shortcut)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain(
      'A shortcut is one word, with no spaces'
    )
    type(shortcut, '')
    expect(button(el, 'Add').disabled).toBe(false)
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
  })

  it('Edit: Save hands the edited values back, the shortcut as typed', async () => {
    const onSubmit = vi.fn()
    const close = vi.fn()
    const el = render(
      <SearchEngineForm initial={WIKI} action="Save" onSubmit={onSubmit} close={close} />
    )
    type(input(el, 'search-engine-shortcut'), '@wp')
    act(() => button(el, 'Save').click())
    await settle()
    expect(onSubmit).toHaveBeenCalledWith({ ...WIKI, shortcut: '@wp' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('the caller’s refusal shows as the form’s validation line and the sheet stays open', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('Bing already answers to @b')
    })
    const close = vi.fn()
    const el = render(
      <SearchEngineForm initial={WIKI} action="Save" onSubmit={onSubmit} close={close} />
    )
    act(() => button(el, 'Save').click())
    await settle()
    expect(close).not.toHaveBeenCalled()
    const alert = el.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Bing already answers to @b')
  })
})

describe('the Shortcut field’s validation (the engine’s keyword rules)', () => {
  function form(initial = WIKI): HTMLElement {
    return render(
      <SearchEngineForm initial={initial} action="Save" onSubmit={vi.fn()} close={vi.fn()} />
    )
  }

  it('a space inside is refused once the field is left: §9.12’s message under the field, aria-invalid, the button held', () => {
    const el = form()
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'wi ki')
    // Not yet left: the button is held, the message waits.
    expect(button(el, 'Save').disabled).toBe(true)
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    blur(shortcut)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    const block = fieldBlock(el, 'search-engine-shortcut')
    const message = block.querySelector('.zen-settings-validation')
    expect(message?.getAttribute('role')).toBe('alert')
    expect(message?.textContent).toContain('A shortcut is one word, with no spaces')
    // The validation line replaces the description (§9.12), the glyph beside it.
    expect(block.querySelector('.zen-settings-description')).toBeNull()
    expect(message?.querySelector('svg')).not.toBeNull()
    expect(button(el, 'Save').disabled).toBe(true)
  })

  it('editing, an emptied shortcut is refused – an engine never holds an empty word: the button is held, with no message shouted', () => {
    const el = form()
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, '')
    blur(shortcut)
    expect(button(el, 'Save').disabled).toBe(true)
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(
      fieldBlock(el, 'search-engine-shortcut').querySelector('.zen-settings-validation')
    ).toBeNull()
  })

  it('the engine’s cap: more than 64 characters after the @ is too long', () => {
    const el = form()
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, `@${'w'.repeat(64)}`)
    blur(shortcut)
    expect(button(el, 'Save').disabled).toBe(false)
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    type(shortcut, `@${'w'.repeat(65)}`)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain(
      'The shortcut is too long'
    )
    expect(button(el, 'Save').disabled).toBe(true)
  })

  it('Zenium’s own scopes (@bookmarks, @history, @tabs) answer before any engine, so none can be a shortcut – with or without the @, any case', () => {
    const el = form()
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'Tabs')
    blur(shortcut)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain(
      '@tabs is one of Zenium’s own shortcuts'
    )
    expect(button(el, 'Save').disabled).toBe(true)
    type(shortcut, '@history')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain('@history is one of')
    type(shortcut, '@bookmarks')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain('@bookmarks is one of')
    // A word of its own is fine, @ or not.
    type(shortcut, 'wiki')
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(button(el, 'Save').disabled).toBe(false)
  })

  it('the caller’s `problem` – another engine’s word, which only its list can tell – is the field’s message too', () => {
    const el = render(
      <SearchEngineForm
        initial={WIKI}
        action="Save"
        problem={(s) => (s.toLowerCase() === '@ddg' ? 'DuckDuckGo already answers to @ddg' : null)}
        onSubmit={vi.fn()}
        close={vi.fn()}
      />
    )
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, '@ddg')
    blur(shortcut)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain(
      'DuckDuckGo already answers to @ddg'
    )
    expect(button(el, 'Save').disabled).toBe(true)
  })

  it('Enter with a problem marks the fields instead of submitting', () => {
    const onSubmit = vi.fn()
    const el = render(
      <SearchEngineForm initial={WIKI} action="Save" onSubmit={onSubmit} close={vi.fn()} />
    )
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'no spaces allowed')
    act(() => {
      shortcut.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { customSearchEngine, DEFAULT_SEARCH_ENGINES } from '@shared/search'
import type { SearchEngine } from '@shared/types'
import { SearchEngineForm } from '../blocks'

/*
 * Search › Add search engine and › Edit search engine as one form (W4-10, #409's ask): `initial`
 * fills the fields for an edit and the verb is the caller's; the Shortcut field (Chrome's
 * Shortcut column) is checked by the engine's own keyword rules – the shared
 * `engineKeywordProblem` of `shared/search.ts` against the caller's `engines`, the engine being
 * edited (`engineId`) excepted: one word, no spaces, at most 64 characters after the `@` the
 * engine adds, a word after the `@`, not one of Zenium's own scopes, not a word another engine
 * answers to – in §9.12's validation form, each field once it is left (its own leaving, not the
 * other field's) or on Enter, the line named as the field's description; the button is held
 * until the name and the template are in – and, editing, the shortcut too: an engine never holds
 * an empty word, so an emptied one says "Give the engine a shortcut" once left or on Enter, the
 * focus moved to it on Enter (§9.12's line on submit, the #419 lead check's ruling 1), where
 * adding leaves it the engine's to derive (the core's `search.addEngine` takes none yet) – and
 * submit hands the caller the three values.
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

/** The shipped engines (`@google`, `@ddg`, `@ecosia`, `@bing`, `@wikipedia`): the Add form's list. */
const SHIPPED: readonly SearchEngine[] = DEFAULT_SEARCH_ENGINES
/** The engine `WIKI` edits, as the profile holds it – its own word `@wiki`. */
const WIKI_ENGINE: SearchEngine = {
  ...customSearchEngine(WIKI.name, WIKI.url, SHIPPED),
  keyword: WIKI.shortcut
}
/** The Edit form's list: the shipped engines and the one being edited. */
const ENGINES: readonly SearchEngine[] = [...SHIPPED, WIKI_ENGINE]

type FormProps = ComponentProps<typeof SearchEngineForm>

/** The Add form over the shipped engines: no `engineId`, every engine's word another's. */
function addForm(props: Partial<Pick<FormProps, 'onSubmit' | 'close'>> = {}): HTMLElement {
  return render(
    <SearchEngineForm
      action="Add"
      engines={SHIPPED}
      onSubmit={props.onSubmit ?? vi.fn()}
      close={props.close ?? vi.fn()}
    />
  )
}

/** The Edit form on `WIKI_ENGINE`, its list the shipped engines and itself. */
function editForm(props: Partial<Pick<FormProps, 'onSubmit' | 'close'>> = {}): HTMLElement {
  return render(
    <SearchEngineForm
      initial={WIKI}
      action="Save"
      engines={ENGINES}
      engineId={WIKI_ENGINE.id}
      onSubmit={props.onSubmit ?? vi.fn()}
      close={props.close ?? vi.fn()}
    />
  )
}

describe('the search-engine form: Add and Edit from one component', () => {
  it('Add: empty fields, the three of them in Chrome’s order, the caller’s verb, the button held', () => {
    const el = addForm()
    const ids = Array.from(el.querySelectorAll('input')).map((i) => i.id)
    expect(ids).toEqual(['search-engine-name', 'search-engine-shortcut', 'search-engine-url'])
    expect(input(el, 'search-engine-name').value).toBe('')
    expect(input(el, 'search-engine-shortcut').value).toBe('')
    expect(input(el, 'search-engine-url').value).toBe('')
    expect(el.querySelector('label[for="search-engine-shortcut"]')?.textContent).toBe('Shortcut')
    // The Shortcut's description names its object (the #419 lead check, Q5a).
    expect(
      fieldBlock(el, 'search-engine-shortcut').querySelector('.zen-settings-description')
        ?.textContent
    ).toBe('Type it in the address bar, then a space, to search with this engine.')
    expect(button(el, 'Add').disabled).toBe(true)
    expect(el.querySelector('button[aria-busy]')).toBeNull()
  })

  it('Edit: `initial` fills the fields and the caller’s verb is Save, the button ready at once – the engine’s own word is no collision with itself', () => {
    const el = editForm()
    expect(input(el, 'search-engine-name').value).toBe('Wikipedia')
    expect(input(el, 'search-engine-shortcut').value).toBe('@wiki')
    expect(input(el, 'search-engine-url').value).toBe(WIKI.url)
    expect(button(el, 'Save').disabled).toBe(false)
    expect(el.querySelector('[data-testid="search-engine-form"]')).not.toBeNull()
  })

  it('submit hands the caller the three values, trimmed, and closes once it settles', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const close = vi.fn()
    const el = addForm({ onSubmit, close })
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
    const el = addForm({ onSubmit, close })
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
    const el = addForm()
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
    const el = editForm({ onSubmit, close })
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
    const el = editForm({ onSubmit, close })
    act(() => button(el, 'Save').click())
    await settle()
    expect(close).not.toHaveBeenCalled()
    const alert = el.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Bing already answers to @b')
  })
})

describe('the Shortcut field’s validation (the engine’s keyword rules, `engineKeywordProblem`)', () => {
  it('a space inside is refused once the field is left: §9.12’s message under the field, aria-invalid, the button held', () => {
    const el = editForm()
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
    // The line is the field's description for a reader on the field (the sheet's own pattern).
    expect(message?.id).toBeTruthy()
    expect(shortcut.getAttribute('aria-describedby')).toBe(message?.id)
    expect(button(el, 'Save').disabled).toBe(true)
    // The word mended, the line and the name go with it.
    type(shortcut, 'wiki')
    expect(shortcut.getAttribute('aria-describedby')).toBeNull()
    expect(block.querySelector('.zen-settings-description')).not.toBeNull()
  })

  it('leaving the Shortcut does not set the URL speaking as it is typed – each field is checked by its own leaving (§9.12), the URL once it is left', () => {
    const el = addForm()
    type(input(el, 'search-engine-name'), 'Wikipedia')
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'wiki')
    blur(shortcut)
    const url = input(el, 'search-engine-url')
    const block = fieldBlock(el, 'search-engine-url')
    type(url, 'h')
    // Typing, the URL says nothing: its description stands, no line, no aria-invalid; the button
    // is held by the template all the same.
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    expect(block.querySelector('.zen-settings-description')?.textContent).toContain('Example:')
    expect(url.getAttribute('aria-invalid')).toBeNull()
    expect(url.getAttribute('aria-describedby')).toBeNull()
    expect(button(el, 'Add').disabled).toBe(true)
    type(url, 'https://en.wikipedia.org/w/index.php?search=')
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    // Left, it speaks – the line in the description's place, named as the field's description.
    blur(url)
    const message = block.querySelector('.zen-settings-validation')
    expect(message?.textContent).toContain('Put %s where the search terms go')
    expect(url.getAttribute('aria-invalid')).toBe('true')
    expect(url.getAttribute('aria-describedby')).toBe(message?.id)
    expect(block.querySelector('.zen-settings-description')).toBeNull()
  })

  it('Enter on a held form marks both fields at once, each with its own line, and submits nothing', () => {
    const onSubmit = vi.fn()
    const el = addForm({ onSubmit })
    const name = input(el, 'search-engine-name')
    type(name, 'Wikipedia')
    type(input(el, 'search-engine-shortcut'), 'wi ki')
    type(input(el, 'search-engine-url'), 'h')
    // Neither field left: nothing shows yet.
    expect(el.querySelectorAll('.zen-settings-validation')).toHaveLength(0)
    enter(name)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input(el, 'search-engine-shortcut').getAttribute('aria-invalid')).toBe('true')
    expect(input(el, 'search-engine-url').getAttribute('aria-invalid')).toBe('true')
    expect(fieldBlock(el, 'search-engine-shortcut').textContent).toContain(
      'A shortcut is one word, with no spaces'
    )
    expect(fieldBlock(el, 'search-engine-url').textContent).toContain(
      'Put %s where the search terms go'
    )
  })

  it('a bare @ is a word missing, not a word too long: its own line once left, the button held (the shared helper’s line, so #409’s Edit form and the core’s refusal say it too)', () => {
    const el = editForm()
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, '@')
    expect(button(el, 'Save').disabled).toBe(true)
    blur(shortcut)
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    const block = fieldBlock(el, 'search-engine-shortcut')
    expect(block.textContent).toContain('Type a word after the @')
    expect(block.textContent).not.toContain('too long')
    // Trimmed, a lone @ with spaces around it is the same bare @.
    type(shortcut, ' @ ')
    expect(block.textContent).toContain('Type a word after the @')
    // A word after it, and the line goes.
    type(shortcut, '@w')
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    expect(button(el, 'Save').disabled).toBe(false)
  })

  it('editing, an emptied shortcut is refused – an engine never holds an empty word: the button held and nothing said while typing; left, "Give the engine a shortcut" under the field', () => {
    const el = editForm()
    const shortcut = input(el, 'search-engine-shortcut')
    const block = fieldBlock(el, 'search-engine-shortcut')
    type(shortcut, '')
    expect(button(el, 'Save').disabled).toBe(true)
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    blur(shortcut)
    const message = block.querySelector('.zen-settings-validation')
    expect(message?.textContent).toContain('Give the engine a shortcut')
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(shortcut.getAttribute('aria-describedby')).toBe(message?.id)
    expect(button(el, 'Save').disabled).toBe(true)
    // (Adding, the same empty field left says nothing – pinned above, "Add: the shortcut may be
    // left empty".)
  })

  it('editing, Enter with the shortcut emptied (§9.12’s line on submit, the lead check’s ruling 1): the line under the field, aria-invalid, the focus moved to it, nothing submitted – a word typed and Enter again submits', async () => {
    const onSubmit = vi.fn()
    const close = vi.fn()
    const el = editForm({ onSubmit, close })
    const name = input(el, 'search-engine-name')
    const shortcut = input(el, 'search-engine-shortcut')
    const block = fieldBlock(el, 'search-engine-shortcut')
    type(shortcut, '')
    // Enter from another field: the held form answers at the shortcut, and takes the focus there.
    enter(name)
    expect(onSubmit).not.toHaveBeenCalled()
    const message = block.querySelector('.zen-settings-validation')
    expect(message?.textContent).toContain('Give the engine a shortcut')
    expect(message?.getAttribute('role')).toBe('alert')
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(shortcut.getAttribute('aria-describedby')).toBe(message?.id)
    expect(block.querySelector('.zen-settings-description')).toBeNull()
    expect(document.activeElement).toBe(shortcut)
    expect(button(el, 'Save').disabled).toBe(true)
    // A word typed: the line goes as it is typed; Enter again submits it.
    type(shortcut, '@w')
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    enter(shortcut)
    await settle()
    expect(onSubmit).toHaveBeenCalledWith({ ...WIKI, shortcut: '@w' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('the engine’s cap: more than 64 characters after the @ is too long', () => {
    const el = editForm()
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
    const el = editForm()
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

  it('editing, a word another engine answers to is refused once left – the shared helper against the caller’s `engines`, the engine’s own word (`engineId`) excepted', () => {
    const el = editForm()
    const shortcut = input(el, 'search-engine-shortcut')
    const block = fieldBlock(el, 'search-engine-shortcut')
    type(shortcut, '@ddg')
    // Typing, nothing yet; the button is held by the collision all the same.
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    expect(button(el, 'Save').disabled).toBe(true)
    blur(shortcut)
    const message = block.querySelector('.zen-settings-validation')
    expect(message?.textContent).toContain('DuckDuckGo already answers to @ddg')
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(shortcut.getAttribute('aria-describedby')).toBe(message?.id)
    expect(button(el, 'Save').disabled).toBe(true)
    // The @ left off, the same word; the engine's other names too (its id, its name).
    type(shortcut, 'ddg')
    expect(block.textContent).toContain('DuckDuckGo already answers to @ddg')
    type(shortcut, 'DuckDuckGo')
    expect(block.textContent).toContain('DuckDuckGo already answers to @duckduckgo')
    // Its own word, in any case, is its own – no collision with itself.
    type(shortcut, ' @Wiki ')
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(block.querySelector('.zen-settings-validation')).toBeNull()
    expect(button(el, 'Save').disabled).toBe(false)
  })

  it('adding, no engine is this one – every engine’s word is another’s, the one being edited elsewhere included', () => {
    const el = render(
      <SearchEngineForm action="Add" engines={ENGINES} onSubmit={vi.fn()} close={vi.fn()} />
    )
    type(input(el, 'search-engine-name'), 'Wiki mirror')
    type(input(el, 'search-engine-url'), 'https://wiki.example/?q=%s')
    const shortcut = input(el, 'search-engine-shortcut')
    const block = fieldBlock(el, 'search-engine-shortcut')
    type(shortcut, 'wiki')
    blur(shortcut)
    expect(block.textContent).toContain('Wikipedia already answers to @wiki')
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    expect(button(el, 'Add').disabled).toBe(true)
    // A word of its own, and the form is ready.
    type(shortcut, 'mirror')
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(button(el, 'Add').disabled).toBe(false)
  })

  it('Enter with a problem marks the fields instead of submitting', () => {
    const onSubmit = vi.fn()
    const el = editForm({ onSubmit })
    const shortcut = input(el, 'search-engine-shortcut')
    type(shortcut, 'no spaces allowed')
    act(() => {
      shortcut.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
  })
})

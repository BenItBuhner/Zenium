// @vitest-environment happy-dom
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchEngine, Settings, Tab, UIState } from '@shared/types'
import { INTERNAL_PAGES } from '@shared/internalPages'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyAgentSkillStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES, engineKeywordProblem } from '@shared/search'
import { defaultShortcuts } from '@shared/shortcuts'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import { emptyBlockingStatus } from '@shared/blocking'
import { emptyPrivacyStatus } from '@shared/privacy'
import { emptySiteDataStatus } from '@shared/siteData'
import { emptyUpdateStatus } from '@shared/updates'
import { FrameDialogHost } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'

/*
 * Search › Added search engines › an engine's Edit (omnibox-09, settings-43) on the chassis's one
 * Add / Edit form (`SearchEngineForm`, #419): the form dialog opened over the engine's item
 * dialog is `SearchEngineForm` pre-filled from the engine – name, shortcut, URL, Chrome's order
 * – with Save as its verb, the shortcut checked by the shared keyword rule against the profile's
 * other engines (the engine's own word excepted), Save going to `search.updateEngine` with the
 * form's `shortcut` as the command's `keyword`; the dialog itself is §9.20's stacked 320. #409's
 * own Edit form (`SearchEngineEditForm.tsx`) is retired – this is its wiring test's successor.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { buildSection } = await import('../sections')
const { onLayout } = await import('../model')
const { DialogStack } = await import('../dialogs')
const { SheetStack } = await import('../sheets')

type Ctx = Parameters<typeof buildSection>[1]
type RowGroups = ReturnType<typeof buildSection>['groups']

const SEARCH = INTERNAL_PAGES.settings.sections.find((s) => s.id === 'search')!

const SITE: Tab = { id: 'site', url: 'https://example.com/a', title: 'A', openerTabId: null } as Tab
const SETTINGS_TAB: Tab = {
  id: 'settings',
  url: 'zen://settings/search',
  title: 'Settings',
  openerTabId: 'site'
} as Tab

/** The profile's own engines: the default (`@mine`) and the one under edit (`@wiki`). */
const MINE: SearchEngine = {
  id: 'custom:mine',
  name: 'Mine',
  searchUrl: 'https://mine.example/?q=%s',
  suggestUrl: null,
  keyword: '@mine',
  glyph: 'M',
  source: 'custom',
  favicon: null
}
const WIKI: SearchEngine = {
  id: 'custom:wiki',
  name: 'Wiki',
  searchUrl: 'https://wiki.example/w?search=%s',
  suggestUrl: null,
  keyword: '@wiki',
  glyph: 'W',
  source: 'custom',
  favicon: null
}
/** A visited site's engine the user deactivated (settings-43): under Inactive, Activate on its sheet. */
const FORUM: SearchEngine = {
  id: 'discovered:forum.example',
  name: 'Forum',
  searchUrl: 'https://forum.example/search?q=%s',
  suggestUrl: null,
  keyword: '@forum',
  glyph: 'F',
  source: 'discovered',
  favicon: null,
  visitedAt: 5,
  active: false
}
const ENGINES: SearchEngine[] = [...DEFAULT_SEARCH_ENGINES, MINE, WIKI]

function state(extra: SearchEngine[] = []): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true, windowControls: true, pageControls: false },
    version: '0.4.27-test',
    tabs: { site: SITE, settings: SETTINGS_TAB },
    essentialTabIds: [],
    spaces: [
      { id: 'space', name: 'Personal', activeTabId: 'settings', tabIds: ['site', 'settings'] }
    ],
    activeSpaceId: 'space',
    containers: DEFAULT_CONTAINERS,
    folders: {},
    splitGroups: {},
    settings: {
      ...DEFAULT_SETTINGS,
      searchEngines: [MINE, WIKI, ...extra],
      searchEngineId: MINE.id
    } as Settings,
    shortcuts: defaultShortcuts('linux', 'chrome'),
    searchEngines: [...ENGINES, ...extra],
    extensionControls: {},
    glance: null,
    compactSidebarRevealed: false,
    window: { id: 'w', kind: 'main', maximized: false, fullscreen: false, focused: true },
    downloads: [],
    bookmarks: [],
    media: [],
    resources: emptyResourceSnapshot(),
    boosts: [],
    extensions: [],
    mods: [],
    webApps: [],
    agents: [],
    awayAgents: [],
    agentServer: emptyAgentServerStatus(),
    agentSkills: emptyAgentSkillStatus(),
    updates: emptyUpdateStatus('0.4.27-test', { os: 'linux', arch: 'x64', kind: 'appimage' }),
    passwords: emptyPasswordsStatus(),
    autofill: emptyAutofillUIState(),
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    siteData: emptySiteDataStatus(),
    translate: { available: true, tabs: {} },
    spellcheck: UNAVAILABLE_SPELLCHECK
  } as unknown as UIState
}

/**
 * The Search section's groups as the page builds them – the desktop's, or the phone's – with
 * `extra` engines of the user's beside Mine and Wiki.
 */
function searchGroups(
  formFactor: 'desktop' | 'phone' = 'desktop',
  extra: SearchEngine[] = []
): RowGroups {
  const ctx = {
    state: state(extra),
    tab: SETTINGS_TAB,
    pointer: formFactor === 'desktop',
    formFactor,
    set: () => undefined,
    navigate: () => undefined,
    openBarEditor: () => undefined
  } as unknown as Ctx
  return buildSection(SEARCH, ctx).groups
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}

afterEach(() => {
  unmount()
  invoke.mockReset()
  invoke.mockImplementation(async () => null)
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

function alerts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? '')
}

/** Wiki's Edit form over Wiki's item dialog, over the real Search groups. */
function openEdit(closeTop = vi.fn()): {
  h: HTMLElement
  form: HTMLElement
  closeTop: ReturnType<typeof vi.fn>
} {
  const h = render(
    <FrameDialogHost>
      <DialogStack
        requests={[
          { kind: 'item', rowId: `search-engine:${WIKI.id}` },
          { kind: 'form', rowId: `search-engine:${WIKI.id}:edit` }
        ]}
        groups={searchGroups()}
        ctx={{ open: () => undefined }}
        closeTop={closeTop}
      />
    </FrameDialogHost>
  )
  const form = h.querySelector<HTMLElement>(`[data-dialog="form:search-engine:${WIKI.id}:edit"]`)
  if (!form) throw new Error('no Edit form dialog')
  return { h, form, closeTop }
}

describe('Search › an engine’s Edit dialog on the chassis’s SearchEngineForm (#419)', () => {
  it('opens over the engine’s item dialog as the stacked 320 form, titled as #409’s, its body the chassis form – not a form of its own', () => {
    const { h, form } = openEdit()
    const dialogs = [...h.querySelectorAll<HTMLElement>('[role="dialog"]')]
    expect(dialogs.map((d) => d.getAttribute('data-dialog'))).toEqual([
      `item:search-engine:${WIKI.id}`,
      `form:search-engine:${WIKI.id}:edit`
    ])
    // The item dialog under keeps the form's 400 and is inert; the form over it is §9.20's 320
    // (the #409 ruling, #419's `stacked`).
    expect(dialogs[0]!.style.width).toBe('400px')
    expect(dialogs[0]!.hasAttribute('inert')).toBe(true)
    expect(form.style.width).toBe('320px')
    expect(form.hasAttribute('data-stacked')).toBe(true)
    expect(form.hasAttribute('inert')).toBe(false)
    // #409's title (the dialog's accessible name) and its line on the template.
    const titleId = form.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(form.querySelector(`#${titleId}`)?.textContent).toBe('Edit search engine')
    expect(form.querySelector('.zen-v2-title-block-description')?.textContent).toBe(
      'Put %s in the URL where the search terms go.'
    )
    // The chassis form, by its mark and its field ids; #409's `search-engine-edit-*` are gone.
    expect(form.querySelector('[data-testid="search-engine-form"]')).not.toBeNull()
    expect(form.querySelector('[data-testid="search-engine-edit-form"]')).toBeNull()
    expect(form.querySelector('[id^="search-engine-edit-"]')).toBeNull()
    expect(
      existsSync(resolve(__dirname, '../SearchEngineEditForm.tsx')),
      '#409’s SearchEngineEditForm.tsx is retired'
    ).toBe(false)
  })

  it('pre-fills name, shortcut and URL from the engine in Chrome’s order, Save the verb and ready at once', () => {
    const { form } = openEdit()
    const ids = [...form.querySelectorAll('input')].map((i) => i.id)
    expect(ids).toEqual(['search-engine-name', 'search-engine-shortcut', 'search-engine-url'])
    expect(input(form, 'search-engine-name').value).toBe('Wiki')
    expect(input(form, 'search-engine-shortcut').value).toBe('@wiki')
    expect(input(form, 'search-engine-url').value).toBe('https://wiki.example/w?search=%s')
    expect(form.querySelector('label[for="search-engine-shortcut"]')?.textContent).toBe('Shortcut')
    expect(button(form, 'Save').disabled).toBe(false)
    expect(button(form, 'Cancel').disabled).toBe(false)
    expect(alerts(form)).toEqual([])
  })

  it('the shortcut is checked by the shared keyword rule against the profile’s other engines, the engine’s own word excepted – the message the helper itself gives, once the field is left', () => {
    const { form } = openEdit()
    const shortcut = input(form, 'search-engine-shortcut')
    // Another of the profile's engines' word: held, and named once left – by the shared line.
    type(shortcut, '@mine')
    expect(button(form, 'Save').disabled).toBe(true)
    expect(alerts(form)).toEqual([])
    blur(shortcut)
    expect(alerts(form)).toEqual(['Mine already answers to @mine'])
    expect(alerts(form)).toEqual([engineKeywordProblem('@mine', WIKI.id, ENGINES)])
    expect(shortcut.getAttribute('aria-invalid')).toBe('true')
    // A shipped engine's word, and one of Zenium's own scopes: the same rule.
    type(shortcut, 'ddg')
    expect(alerts(form)).toEqual([engineKeywordProblem('ddg', WIKI.id, ENGINES)])
    expect(alerts(form)[0]).toContain('DuckDuckGo already answers to @ddg')
    type(shortcut, 'tabs')
    expect(alerts(form)).toEqual(['@tabs is one of Zenium’s own shortcuts'])
    // Its own word is no clash with itself.
    type(shortcut, '@Wiki')
    expect(alerts(form)).toEqual([])
    expect(shortcut.getAttribute('aria-invalid')).toBeNull()
    expect(button(form, 'Save').disabled).toBe(false)
  })

  it('Save goes to search.updateEngine with the form’s shortcut as the command’s keyword and its URL as searchUrl, then the dialog closes', async () => {
    const { form, closeTop } = openEdit()
    type(input(form, 'search-engine-name'), ' Wiki mirror ')
    type(input(form, 'search-engine-shortcut'), 'mg')
    type(input(form, 'search-engine-url'), ' https://wiki.example/find?q=%s ')
    act(() => button(form, 'Save').click())
    await settle()
    expect(invoke).toHaveBeenCalledWith('search.updateEngine', {
      id: WIKI.id,
      name: 'Wiki mirror',
      searchUrl: 'https://wiki.example/find?q=%s',
      keyword: 'mg'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(closeTop).toHaveBeenCalledTimes(1)
  })

  it('the browser’s refusal shows as the form’s line and the dialog stays; Cancel closes with nothing saved', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('Google already answers to @google')
    })
    const { form, closeTop } = openEdit()
    act(() => button(form, 'Save').click())
    await settle()
    expect(invoke).toHaveBeenCalledWith('search.updateEngine', expect.anything())
    expect(alerts(form)).toContain('Google already answers to @google')
    expect(closeTop).not.toHaveBeenCalled()
    act(() => button(form, 'Cancel').click())
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

/*
 * The same Edit on the phone (SET-10; Chrome 152's `SiteSearchDialogCoordinator.showEditDialog`
 * – the Add dialog's view model pre-filled, Save its verb, the edit in place on the engine's own
 * key): the row is no longer the desktop's alone, so the form opens as the second sheet over
 * the engine's sheet (§9.24) on the phone sheet chassis, pre-filled, and Save goes to the same
 * command with the engine's id – the default flag (`searchEngineId`) is untouched by it.
 */

/** A hand-cranked animation frame for the sheets' springs: 16 ms a frame. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

describe('Search › an engine’s Edit on the phone: the second sheet over the engine’s (SET-10)', () => {
  const frames = new Frames()
  let sizes: Array<[string, PropertyDescriptor | undefined]> = []

  beforeEach(() => {
    frames.install()
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    sizes = ['clientHeight', 'offsetHeight'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ])
    // The layer 800 px tall, a sheet's content 300: sheets with room to stand.
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
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
    vi.unstubAllGlobals()
    frames.now = 0
    for (const [name, descriptor] of sizes) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  /** Let the sheets come up and their springs run to rest. */
  async function land(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
    })
    for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
    expect(frames.scheduled).toBe(false)
  }

  function layers(h: HTMLElement): HTMLElement[] {
    return [...h.querySelectorAll<HTMLElement>('.zen-frame-dialogs-slot > [data-sheet-layer]')]
  }

  /** Wiki's Edit form sheet over Wiki's sheet, over the real Search groups built for the phone. */
  async function openEditSheet(closeTop = vi.fn()): Promise<{
    h: HTMLElement
    sheet: HTMLElement
    form: HTMLElement
    closeTop: ReturnType<typeof vi.fn>
  }> {
    const h = render(
      <FrameDialogHost>
        <SheetStack
          requests={[
            { kind: 'item', rowId: `search-engine:${WIKI.id}` },
            { kind: 'form', rowId: `search-engine:${WIKI.id}:edit` }
          ]}
          groups={searchGroups('phone')}
          ctx={{ open: () => undefined }}
          closeTop={closeTop}
        />
      </FrameDialogHost>
    )
    await land()
    const sheet = layers(h)[1]
    if (!sheet) throw new Error('no Edit form sheet')
    const form = sheet.querySelector<HTMLElement>('[data-testid="search-engine-form"]')
    if (!form) throw new Error('no SearchEngineForm in the sheet')
    return { h, sheet, form, closeTop }
  }

  it('the engine’s sheet carries Edit beside Make default and Remove, and the Edit form stands over it as the second sheet, titled and pre-filled as the desktop’s', async () => {
    const { h, sheet, form } = await openEditSheet()
    const stack = layers(h)
    expect(stack).toHaveLength(2)
    expect(stack.map((l) => l.querySelector('.zen-sheet-title-block h2')?.textContent)).toEqual([
      'Wiki',
      'Edit search engine'
    ])
    expect(sheet.querySelector('.zen-sheet-title-block p')?.textContent).toBe(
      'Put %s in the URL where the search terms go.'
    )
    // The engine's sheet under: Make default, Edit, Deactivate, Remove – the desktop's rows in
    // the desktop's order, each the phone's pressable row, the whole row the target (§10.4);
    // the desktop's inline "Edit…" button is not drawn here.
    const rows = [...stack[0]!.querySelectorAll<HTMLElement>('[data-row]')].map(
      (r) => r.dataset.row
    )
    expect(rows).toEqual([
      `search-engine:${WIKI.id}:default`,
      `search-engine:${WIKI.id}:edit`,
      `search-engine:${WIKI.id}:deactivate`,
      `search-engine:${WIKI.id}:remove`
    ])
    const editRow = stack[0]!.querySelector<HTMLElement>(
      `[data-row="search-engine:${WIKI.id}:edit"]`
    )!
    expect(editRow.textContent).toContain('Edit')
    expect(editRow.textContent).toContain('The name, the shortcut and the URL the terms go into.')
    expect(editRow.querySelector('button.zen-v2-button')).toBeNull()
    const pressable = editRow.matches('[aria-haspopup]')
      ? editRow
      : editRow.querySelector<HTMLElement>('[aria-haspopup]')
    expect(pressable?.getAttribute('aria-haspopup')).toBe('dialog')
    // The form pre-filled in Chrome's order, Save ready at once.
    expect([...form.querySelectorAll('input')].map((i) => i.id)).toEqual([
      'search-engine-name',
      'search-engine-shortcut',
      'search-engine-url'
    ])
    expect(input(form, 'search-engine-name').value).toBe('Wiki')
    expect(input(form, 'search-engine-shortcut').value).toBe('@wiki')
    expect(input(form, 'search-engine-url').value).toBe('https://wiki.example/w?search=%s')
    expect(button(sheet, 'Save').disabled).toBe(false)
    expect(alerts(sheet)).toEqual([])
  })

  it('Save goes to search.updateEngine with the engine’s own id – the edit in place, the default flag not the command’s – and the sheet closes; a clash holds Save as Add’s does', async () => {
    const { sheet, form, closeTop } = await openEditSheet()
    type(input(form, 'search-engine-shortcut'), '@mine')
    expect(button(sheet, 'Save').disabled).toBe(true)
    blur(input(form, 'search-engine-shortcut'))
    expect(alerts(sheet)).toEqual(['Mine already answers to @mine'])
    type(input(form, 'search-engine-name'), ' Wiki mirror ')
    type(input(form, 'search-engine-shortcut'), 'mg')
    type(input(form, 'search-engine-url'), ' https://wiki.example/find?q=%s ')
    expect(button(sheet, 'Save').disabled).toBe(false)
    act(() => button(sheet, 'Save').click())
    await settle()
    expect(invoke).toHaveBeenCalledWith('search.updateEngine', {
      id: WIKI.id,
      name: 'Wiki mirror',
      searchUrl: 'https://wiki.example/find?q=%s',
      keyword: 'mg'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalledWith('search.addEngine', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('search.removeEngine', expect.anything())
    await land()
    expect(closeTop).toHaveBeenCalledTimes(1)
  })

  /**
   * An engine's sheet on the phone over the Search groups as the phone's page draws them –
   * `onLayout('phone')` applied, so a row kept from the phone would be missing here.
   */
  async function openEngineSheet(id: string, extra: SearchEngine[]): Promise<HTMLElement> {
    const h = render(
      <FrameDialogHost>
        <SheetStack
          requests={[{ kind: 'item', rowId: `search-engine:${id}` }]}
          groups={onLayout(searchGroups('phone', extra), 'phone')}
          ctx={{ open: () => undefined }}
          closeTop={vi.fn()}
        />
      </FrameDialogHost>
    )
    await land()
    const sheet = layers(h)[0]
    if (!sheet) throw new Error(`no sheet for ${id}`)
    return sheet
  }

  it('Deactivate and Activate stand on the phone’s sheet as the desktop’s rows (SET-10’s tail): an inactive engine’s sheet offers Activate in Deactivate’s place, each press going to search.setEngineActive', async () => {
    // Wiki, active and not the default: Deactivate between Edit and Remove, pressable.
    const wiki = await openEngineSheet(WIKI.id, [FORUM])
    const deactivate = wiki.querySelector<HTMLButtonElement>(
      `[data-row="search-engine:${WIKI.id}:deactivate"]`
    )
    if (!deactivate) throw new Error('no Deactivate row')
    expect(deactivate.textContent).toContain('Deactivate')
    expect(deactivate.textContent).toContain(
      'Keeps Wiki in the list but out of the URL bar until you activate it.'
    )
    expect(deactivate.getAttribute('aria-disabled')).toBeNull()
    act(() => deactivate.click())
    expect(invoke).toHaveBeenCalledWith('search.setEngineActive', { id: WIKI.id, active: false })
    unmount()
    invoke.mockClear()

    // Forum, deactivated: its sheet is Edit, Activate, Remove – no Make default – and Activate
    // brings the shortcut back.
    const forum = await openEngineSheet(FORUM.id, [FORUM])
    expect(forum.querySelector('.zen-sheet-title-block h2')?.textContent).toBe('Forum')
    expect(
      [...forum.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.dataset.row)
    ).toEqual([
      `search-engine:${FORUM.id}:edit`,
      `search-engine:${FORUM.id}:activate`,
      `search-engine:${FORUM.id}:remove`
    ])
    const activate = forum.querySelector<HTMLButtonElement>(
      `[data-row="search-engine:${FORUM.id}:activate"]`
    )
    if (!activate) throw new Error('no Activate row')
    expect(activate.textContent).toContain('Activate')
    expect(activate.textContent).toContain('@forum works in the URL bar again.')
    act(() => activate.click())
    expect(invoke).toHaveBeenCalledWith('search.setEngineActive', { id: FORUM.id, active: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    unmount()
    invoke.mockClear()

    // The default engine's Deactivate is held on the phone as on the desktop: the row says so
    // and a press sends nothing.
    const mine = await openEngineSheet(MINE.id, [FORUM])
    const held = mine.querySelector<HTMLButtonElement>(
      `[data-row="search-engine:${MINE.id}:deactivate"]`
    )
    if (!held) throw new Error('no held Deactivate row')
    expect(held.getAttribute('aria-disabled')).toBe('true')
    expect(held.textContent).toContain('The default search engine stays active.')
    act(() => held.click())
    expect(invoke).not.toHaveBeenCalled()
  })
})

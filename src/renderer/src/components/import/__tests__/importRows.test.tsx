// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ImportKindOutcome, ImportProgress, ImportSource, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { uiStore } from '@renderer/lib/ui'
import { idleAutofillSettings } from '@renderer/lib/autofillSettings'
import { idleDictionaryWords } from '@renderer/lib/spellcheckWords'
import { onLayout } from '../../pages/settings/model'
import { GroupList } from '../../pages/settings/rows'
import type { SectionContext } from '../../pages/settings/sections'
import { foundLine, importGroups } from '../importRows'

/*
 * Settings › Import's desktop pane on the shared builder (the Settings tab, #193), drawn in the
 * desktop vocabulary (§10.5): the two dialog rows trail their hugging buttons (§9.21), and the
 * Last import row – #259's lead verdict, §9.33 – stands alone in a pane whose every other label
 * sits on the one text edge, so its status glyph TRAILS, before Dismiss, rather than leading
 * and indenting its one label past its neighbours (a status glyph leads only where every row
 * of the list carries one, the Safety Check rows). The glyph and the label share the §1 status
 * ink on a failure; an empty run takes the aside glyph; the row draws nothing in its leading
 * slot. The phone's rows never reach the desktop's pane.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHROMIUM: ImportSource = {
  id: 'chromium:Profile 1',
  browser: 'chromium',
  browserName: 'Chromium',
  profileId: 'Profile 1',
  name: 'Work',
  path: '',
  running: false,
  kinds: ['bookmarks', 'history', 'passwords'],
  limits: {}
}

const FIREFOX: ImportSource = {
  id: 'firefox:abcd.default',
  browser: 'firefox',
  browserName: 'Firefox',
  profileId: 'abcd.default',
  name: 'default',
  path: '',
  running: false,
  kinds: ['bookmarks', 'history', 'passwords'],
  limits: {}
}

const HTML: ImportSource = {
  id: 'file:bookmarks',
  browser: 'file',
  browserName: 'Bookmarks HTML file',
  profileId: '',
  name: 'Bookmarks HTML file',
  path: '',
  running: false,
  kinds: ['bookmarks'],
  limits: {}
}

const SETTINGS_TAB = { id: 'settings', url: 'zenium://settings/import' } as Tab

function outcome(patch: Partial<ImportKindOutcome> = {}): ImportKindOutcome {
  return { imported: 0, duplicates: 0, unreadable: 0, invalid: 0, error: null, ...patch }
}

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    source: CHROMIUM,
    kinds: ['bookmarks', 'passwords'],
    status: 'done',
    current: null,
    results: {
      bookmarks: outcome({ imported: 1 }),
      passwords: outcome({ imported: 1 })
    },
    error: null,
    folderId: null,
    startedAt: 1,
    finishedAt: 2,
    ...patch
  }
}

/** The pane reads the finished import, the vault capability and the tab; nothing else. */
function state(last: ImportProgress | null): UIState {
  return {
    platform: 'linux',
    import: last,
    capabilities: { passwords: true, pageTabs: true },
    tabs: { settings: SETTINGS_TAB },
    settings: { ...DEFAULT_SETTINGS }
  } as unknown as UIState
}

function context(
  s: UIState,
  importSources: ImportSource[] | null | undefined = [CHROMIUM, FIREFOX, HTML]
): SectionContext {
  return {
    state: s,
    tab: SETTINGS_TAB,
    pointer: true,
    formFactor: 'desktop',
    set: () => undefined,
    navigate: () => undefined,
    openBarEditor: () => undefined,
    boost: () => undefined,
    autofill: idleAutofillSettings(),
    screenLock: false,
    dictionary: idleDictionaryWords(),
    readAloudVoices: null,
    importSources
  }
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

/** The desktop pane: the Import groups on the desktop layout, in the desktop vocabulary. */
function pane(last: ImportProgress | null, sources?: ImportSource[] | null): HTMLElement {
  const groups = onLayout(importGroups(context(state(last), sources)), 'desktop')
  return render(<GroupList groups={groups} ctx={{ open: () => undefined }} variant="desktop" />)
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ importDialog: null })
  vi.mocked(run).mockReset()
})

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

describe('the desktop pane', () => {
  it('is the two dialog rows, each a control row trailing its hugging button, and the phone’s file rows stay off it', () => {
    const el = pane(null)
    expect(
      Array.from(el.querySelectorAll('[data-row]')).map((r) => r.getAttribute('data-row'))
    ).toEqual(['import-browser', 'import-file-dialog'])
    expect(el.querySelector('[data-row="import-bookmarks-file"]')).toBeNull()
    expect(el.querySelector('[data-group="import-last"]')).toBeNull()
    const browsers = rowOf(el, 'import-browser')
    expect(browsers.classList.contains('zen-settings-control-row')).toBe(true)
    expect(browsers.querySelector('.zen-settings-label')?.textContent).toBe(
      'Bookmarks, history and passwords'
    )
    expect(browsers.querySelector('button')?.textContent).toBe('Import…')
    expect(rowOf(el, 'import-file-dialog').querySelector('button')?.textContent).toBe(
      'Import file…'
    )
    // The group's line under its heading names what the engine found.
    expect(
      el.querySelector('[data-group="import-browsers"] .zen-settings-group-description')
        ?.textContent
    ).toBe('Found on this computer: Chromium and Firefox.')
  })

  it('names the browsers found, looks while the answer is out, and says when there are none', () => {
    expect(foundLine(undefined)).toBe('Looking for other browsers on this computer…')
    expect(foundLine(null)).toBe('Looking for other browsers on this computer…')
    expect(foundLine([HTML])).toBe('No other browsers were found on this computer.')
    expect(foundLine([CHROMIUM, HTML])).toBe('Found on this computer: Chromium.')
    expect(foundLine([CHROMIUM, FIREFOX, HTML])).toBe(
      'Found on this computer: Chromium and Firefox.'
    )
  })

  it('its buttons open the import dialog over the tab – the file row on the file sources', async () => {
    const el = pane(null)
    act(() => rowOf(el, 'import-browser').querySelector('button')!.click())
    await vi.waitFor(() => expect(uiStore.get().importDialog).toEqual({ source: null }))
    uiStore.set({ importDialog: null })
    act(() => rowOf(el, 'import-file-dialog').querySelector('button')!.click())
    await vi.waitFor(() => expect(uiStore.get().importDialog).toEqual({ source: 'file:bookmarks' }))
  })
})

describe('the pane’s Last import row', () => {
  it('trails its status glyph before Dismiss and draws nothing leading, so its label sits on the pane’s one text edge (§9.33, §10.3)', () => {
    const el = pane(progress())
    expect(
      Array.from(el.querySelectorAll('[data-group="import-last"] [data-row]')).map((r) =>
        r.getAttribute('data-row')
      )
    ).toEqual(['import-last-summary'])
    const row = rowOf(el, 'import-last-summary')
    const children = Array.from(row.children)
    // The row's children are the text block and the trailing slot – no leading span before the text.
    expect(children).toHaveLength(2)
    const [text, trailing] = children as HTMLElement[]
    expect(text.classList.contains('zen-settings-row-text')).toBe(true)
    expect(text.querySelector('.zen-settings-label')?.textContent).toBe(
      'Your bookmarks and settings are ready'
    )
    expect(text.querySelector('.zen-settings-description')?.textContent).toBe(
      'From Chromium (Work) · 1 bookmark imported · 1 password imported'
    )
    expect(text.querySelector('svg')).toBeNull()
    // The trailing slot: the glyph first, Dismiss after it.
    expect(trailing.classList.contains('zen-settings-trailing')).toBe(true)
    const glyph = trailing.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph?.classList.contains('lucide-circle-check')).toBe(true)
    const dismiss = trailing.querySelector<HTMLButtonElement>('[data-testid="import-dismiss-last"]')
    expect(dismiss?.textContent).toBe('Dismiss')
    expect(glyph!.compareDocumentPosition(dismiss!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The whole row is one static row (the button is the target, not the row), no danger ink.
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.classList.contains('zen-settings-row-danger')).toBe(false)
  })

  it('a failed run is the danger ink on label and glyph alike, the glyph still trailing', () => {
    const failed = progress({
      status: 'failed',
      error: 'Chromium is open. Close Chromium and try again.',
      results: {}
    })
    const el = pane(failed)
    const row = rowOf(el, 'import-last-summary')
    // The row's danger class: its label rule inks the sentence, the description keeps its 69%.
    expect(row.classList.contains('zen-settings-row-danger')).toBe(true)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe(
      'Chromium is open. Close Chromium and try again.'
    )
    expect(row.querySelector('.zen-settings-description')?.hasAttribute('data-tone')).toBe(false)
    const glyph = row.querySelector('svg')
    expect(glyph?.classList.contains('lucide-circle-alert')).toBe(true)
    expect(glyph?.getAttribute('class')).toContain('text-[var(--v2-danger)]')
    expect(row.children[0]!.querySelector('svg')).toBeNull()
    expect(glyph!.parentElement?.classList.contains('zen-settings-trailing')).toBe(true)
  })

  it('a run that brought nothing in and failed nowhere takes the aside glyph (the lead’s ruling: the `none` outcome as built)', () => {
    const empty = progress({
      results: { bookmarks: outcome({ duplicates: 2 }), passwords: outcome() }
    })
    const row = rowOf(pane(empty), 'import-last-summary')
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('Nothing was imported')
    expect(row.querySelector('svg')?.classList.contains('lucide-info')).toBe(true)
    expect(row.classList.contains('zen-settings-row-danger')).toBe(false)
  })

  it('Dismiss asks the engine to drop the finished import', () => {
    const el = pane(progress())
    act(() => {
      rowOf(el, 'import-last-summary')
        .querySelector<HTMLButtonElement>('[data-testid="import-dismiss-last"]')!
        .click()
    })
    expect(run).toHaveBeenCalledWith('import.dismiss', undefined)
  })
})

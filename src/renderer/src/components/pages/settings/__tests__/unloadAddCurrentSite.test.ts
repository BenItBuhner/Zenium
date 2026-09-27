// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Settings, Tab, UIState } from '@shared/types'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import { DEFAULT_SETTINGS, emptyResourceSnapshot } from '@shared/defaults'

/*
 * Performance › Always keep these sites active › "Add current site" (settings-25, Chrome's
 * Performance › "Add current site"; W8-2 moved the row from Tab Management › Tab unloading
 * with the rest of Memory Saver): the desktop and tablet shells' button row after "Add a site"
 * adds the registrable domain of the page Settings was opened from – what the core's unload
 * pass matches the list against – and is a dependent row of the Memory Saver switch: laid out
 * at .4 with its reason while there is no site (a chrome-page opener, no opener, a private
 * window, a site already listed) or while Memory Saver is off.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { buildSection } = await import('../sections')
const { findRow } = await import('../model')

type Ctx = Parameters<typeof buildSection>[1]
type ActionRow = Extract<NonNullable<ReturnType<typeof findRow>>, { kind: 'action' }>

const PERFORMANCE = INTERNAL_PAGES.settings.sections.find((s) => s.id === 'performance')!
const TABS = INTERNAL_PAGES.settings.sections.find((s) => s.id === 'tabs')!

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return { id, url, title: url, openerTabId: null, ...patch } as Tab
}

/** The slice of the state the Performance builder reads, with Settings opened from `opener`. */
function state(
  opener: Tab | null,
  settings: Partial<Settings> = {},
  windowKind: 'main' | 'private' = 'main'
): UIState {
  const settingsTab = tab('settings', 'zen://settings/performance', {
    openerTabId: opener ? opener.id : null
  })
  return {
    platform: 'linux',
    capabilities: { windows: true },
    tabs: opener ? { [opener.id]: opener, settings: settingsTab } : { settings: settingsTab },
    settings: { ...DEFAULT_SETTINGS, unloadEnabled: true, ...settings },
    resources: emptyResourceSnapshot(),
    extensionControls: {},
    window: { id: 'w', kind: windowKind }
  } as unknown as UIState
}

function addRow(s: UIState): { row: ActionRow; patches: Partial<Settings>[] } {
  const patches: Partial<Settings>[] = []
  const ctx = {
    state: s,
    tab: s.tabs.settings,
    pointer: true,
    formFactor: 'desktop',
    set: (patch: Partial<Settings>) => patches.push(patch),
    navigate: () => undefined
  } as unknown as Ctx
  const model = buildSection(PERFORMANCE, ctx)
  const row = findRow(model.groups, 'keep-active-current')
  if (!row || row.kind !== 'action') throw new Error('no Add current site row')
  return { row, patches }
}

describe('Performance › Always keep these sites active › Add current site', () => {
  it('sits in the Add group right after "Add a site" as a button row of the desktop and tablet shells', () => {
    const s = state(tab('site', 'https://mail.google.com/mail/u/0/'))
    for (const formFactor of ['desktop', 'tablet'] as const) {
      const model = buildSection(PERFORMANCE, {
        state: s,
        tab: s.tabs.settings,
        pointer: true,
        formFactor,
        set: () => undefined,
        navigate: () => undefined
      } as unknown as Ctx)
      const group = model.groups.find((g) => g.id === 'keep-active-add')!
      const ids = group.rows.map((r) => r.id)
      expect(ids.indexOf('keep-active-current')).toBe(ids.indexOf('keep-active-add') + 1)
    }
    const { row } = addRow(s)
    expect(row.label).toBe('Add current site')
    expect(row.button).toBe('Add')
    expect(row.destructive).toBeUndefined()
    expect(row.form).toBeUndefined()
  })

  it('adds the registrable domain of the opener – what the unload pass matches – and names it first', () => {
    const { row, patches } = addRow(
      state(tab('site', 'https://mail.google.com/mail/u/0/'), {
        unloadExcludedDomains: ['notion.so']
      })
    )
    expect(row.disabled).toBe(false)
    expect(row.description).toBe('google.com – every page of the site stays loaded.')
    row.onPress?.()
    expect(patches).toEqual([{ unloadExcludedDomains: ['notion.so', 'google.com'] }])
  })

  it('keeps a country-code second level (bbc.co.uk) as the core does', () => {
    const { row, patches } = addRow(state(tab('site', 'https://www.bbc.co.uk/news')))
    row.onPress?.()
    expect(patches).toEqual([{ unloadExcludedDomains: ['bbc.co.uk'] }])
  })

  it('is laid out at .4 and says so when the site is on the list already, and never adds a twin', () => {
    const { row, patches } = addRow(
      state(tab('site', 'https://docs.google.com/'), { unloadExcludedDomains: ['Google.com'] })
    )
    expect(row.disabled).toBe(true)
    expect(row.description).toBe('google.com is already on the list.')
    row.onPress?.()
    expect(patches).toEqual([])
  })

  it('has no site for Settings opened from nowhere, from a chrome page, from an extension page or in a private window', () => {
    const reason = 'Open a page, then come back to Settings from it.'
    for (const s of [
      state(null),
      state(tab('site', 'zen://history')),
      state(tab('site', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')),
      state(tab('site', 'about:blank')),
      state(tab('site', 'https://news.example/'), {}, 'private')
    ]) {
      const { row, patches } = addRow(s)
      expect(row.disabled).toBe(true)
      expect(row.description).toBe(reason)
      row.onPress?.()
      expect(patches).toEqual([])
    }
  })

  it('follows the Memory Saver switch: off, the row is a dependent at .4 and still names the site it would add', () => {
    const { row } = addRow(state(tab('site', 'https://news.example/'), { unloadEnabled: false }))
    expect(row.disabled).toBe(true)
    expect(row.description).toBe('news.example – every page of the site stays loaded.')
  })

  it('is the desktop and tablet shells’ row: the phone keeps its never-sleep list and never lists Performance', () => {
    const s = state(tab('site', 'https://news.example/'))
    const model = buildSection(TABS, {
      state: s,
      tab: s.tabs.settings,
      pointer: false,
      formFactor: 'phone',
      set: () => undefined,
      navigate: () => undefined
    } as unknown as Ctx)
    expect(findRow(model.groups, 'keep-active-current')).toBeNull()
    expect(findRow(model.groups, 'unloading-add-current')).toBeNull()
    expect(
      availableSections(INTERNAL_PAGES.settings, s.capabilities, 'phone').map((x) => x.id)
    ).not.toContain('performance')
  })
})

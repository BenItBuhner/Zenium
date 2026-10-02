import { describe, expect, it } from 'vitest'
import {
  counted,
  isOverviewMenuSeparator,
  otherOverviewView,
  overviewMenu,
  overviewMenuTitle,
  selectionTitle,
  switchViewRow,
  tabsWord,
  type OverviewMenuContext,
  type OverviewMenuEntry,
  type OverviewMenuRow
} from '../overviewMenu'

const spaces = [
  { id: 's1', label: 'Default', current: true },
  { id: 's2', label: 'Work', current: false }
]

function ctx(over: Partial<OverviewMenuContext> = {}): OverviewMenuContext {
  return {
    view: 'tabs',
    privateTabs: true,
    counts: { closable: 3, selectable: 3, regular: 3, private: 0, inactive: 0, recentlyClosed: 0 },
    spaces,
    selection: null,
    ...over
  }
}

function labels(entries: OverviewMenuEntry[]): string[] {
  return entries.map((e) => (isOverviewMenuSeparator(e) ? '—' : e.label))
}

describe('overviewMenu (tab-overview-cleanup-spec §4)', () => {
  it('writes the rows in §4 order with nothing else at rest', () => {
    expect(labels(overviewMenu(ctx()))).toEqual([
      'New Tab',
      'New Private Tab',
      'Select Tabs',
      'Search Tabs',
      '—',
      'Close All Tabs (3)',
      'Switch Space'
    ])
  })

  it('shows every conditional row when its count is above zero', () => {
    const rows = overviewMenu(
      ctx({
        counts: {
          closable: 4,
          selectable: 5,
          regular: 5,
          private: 2,
          inactive: 3,
          recentlyClosed: 6
        }
      })
    )
    expect(labels(rows)).toEqual([
      'New Tab',
      'New Private Tab',
      'Private Tabs (2)',
      'Select Tabs',
      'Search Tabs',
      'Inactive Tabs (3)',
      'Recently Closed (6)',
      '—',
      'Close All Tabs (4)',
      'Switch Space'
    ])
  })

  it('hides the private rows on a host without private tabs', () => {
    const rows = overviewMenu(ctx({ privateTabs: false, counts: { ...ctx().counts, private: 2 } }))
    expect(labels(rows)).not.toContain('New Private Tab')
    expect(labels(rows).some((l) => l.startsWith('Private Tabs'))).toBe(false)
  })

  it('reads "Tabs (N)" and "Close Private Tabs (N)" from the private view, with no space to switch', () => {
    const rows = overviewMenu(
      ctx({
        view: 'private',
        counts: {
          closable: 2,
          selectable: 2,
          regular: 7,
          private: 2,
          inactive: 3,
          recentlyClosed: 6
        }
      })
    )
    expect(labels(rows)).toEqual([
      'New Tab',
      'New Private Tab',
      'Tabs (7)',
      'Select Tabs',
      'Search Tabs',
      '—',
      'Close Private Tabs (2)'
    ])
  })

  it('keeps the way back from the private view even with no regular tab', () => {
    const row = switchViewRow({
      view: 'private',
      privateTabs: true,
      counts: { closable: 1, selectable: 1, regular: 0, private: 1, inactive: 0, recentlyClosed: 0 }
    })
    expect(row).toEqual({ command: 'switch-view', label: 'Tabs (0)' })
    expect(otherOverviewView('private')).toBe('tabs')
    expect(otherOverviewView('tabs')).toBe('private')
  })

  it('disables Select Tabs and Close All at zero rather than hiding them', () => {
    const rows = overviewMenu(
      ctx({
        counts: {
          closable: 0,
          selectable: 0,
          regular: 0,
          private: 0,
          inactive: 0,
          recentlyClosed: 0
        }
      })
    )
    const byCommand = (c: string): OverviewMenuRow =>
      rows.find((e) => !isOverviewMenuSeparator(e) && e.command === c) as OverviewMenuRow
    expect(byCommand('select-tabs').disabled).toBe(true)
    expect(byCommand('close-all')).toMatchObject({
      label: 'Close All Tabs (0)',
      destructive: true,
      disabled: true
    })
    expect(byCommand('search-tabs').disabled).toBeUndefined()
  })

  it('lists the spaces as rows under Switch Space with the current one checked, only with two or more', () => {
    const rows = overviewMenu(ctx())
    const sw = rows.find((e) => !isOverviewMenuSeparator(e) && e.command === 'switch-space')
    expect(sw && !isOverviewMenuSeparator(sw) ? sw.spaces : null).toEqual([
      { spaceId: 's1', label: 'Default', checked: true },
      { spaceId: 's2', label: 'Work', checked: false }
    ])
    expect(labels(overviewMenu(ctx({ spaces: [spaces[0]] })))).not.toContain('Switch Space')
  })

  it('puts the destructive row after the one hairline and marks only it destructive', () => {
    const rows = overviewMenu(ctx({ counts: { ...ctx().counts, recentlyClosed: 1 } }))
    const separators = rows.filter(isOverviewMenuSeparator)
    expect(separators).toHaveLength(1)
    const at = rows.findIndex(isOverviewMenuSeparator)
    const after = rows[at + 1]
    expect(after && !isOverviewMenuSeparator(after) ? after.command : null).toBe('close-all')
    const destructive = rows.filter((e) => !isOverviewMenuSeparator(e) && e.destructive)
    expect(destructive).toHaveLength(1)
  })

  it('is the selection menu while selecting (§5): Select All, Deselect All, the one hairline, Close Selected', () => {
    expect(overviewMenu(ctx({ selection: { selected: 2, total: 5 } }))).toEqual([
      { command: 'select-all', label: 'Select All', disabled: false },
      { command: 'deselect-all', label: 'Deselect All', disabled: false },
      { separator: true },
      { command: 'close-selected', label: 'Close Selected (2)', destructive: true, disabled: false }
    ])
    const none = overviewMenu(ctx({ selection: { selected: 0, total: 5 } }))
    expect(none.map((e) => !isOverviewMenuSeparator(e) && e.disabled)).toEqual([
      false,
      true,
      false,
      true
    ])
    const all = overviewMenu(ctx({ selection: { selected: 5, total: 5 } }))
    expect(all.map((e) => !isOverviewMenuSeparator(e) && e.disabled)).toEqual([
      true,
      false,
      false,
      false
    ])
  })

  it('draws the selection menu’s one hairline right before Close Selected, the only destructive row', () => {
    const rows = overviewMenu(ctx({ selection: { selected: 1, total: 3 } }))
    expect(rows.filter(isOverviewMenuSeparator)).toHaveLength(1)
    const at = rows.findIndex(isOverviewMenuSeparator)
    expect(at).toBe(2)
    const after = rows[at + 1]
    expect(after && !isOverviewMenuSeparator(after) ? after.command : null).toBe('close-selected')
    expect(rows.length - 1).toBe(at + 1)
    const destructive = rows.filter((e) => !isOverviewMenuSeparator(e) && e.destructive)
    expect(destructive).toHaveLength(1)
  })

  it('writes counts in parentheses', () => {
    expect(counted('Recently Closed', 12)).toBe('Recently Closed (12)')
  })

  it('titles the sheet as the overview is titled – the space’s name and count, "Private" and the session’s, the selection’s – never "Zenium"', () => {
    expect(overviewMenuTitle(ctx({ counts: { ...ctx().counts, regular: 10 } }), 'Work')).toBe(
      'Work · 10 tabs'
    )
    expect(overviewMenuTitle(ctx({ counts: { ...ctx().counts, regular: 1 } }), 'Work')).toBe(
      'Work · 1 tab'
    )
    // The private session is one across the spaces: the space's name is not in its title.
    expect(
      overviewMenuTitle(
        ctx({ view: 'private', counts: { ...ctx().counts, regular: 10, private: 1 } }),
        'Work'
      )
    ).toBe('Private · 1 tab')
    // The select-tabs mode's header word: the count, the mode's name before the first pick.
    expect(overviewMenuTitle(ctx({ selection: { selected: 1, total: 5 } }), 'Work')).toBe(
      '1 selected'
    )
    expect(overviewMenuTitle(ctx({ selection: { selected: 0, total: 5 } }), 'Work')).toBe(
      'Select tabs'
    )
    expect(selectionTitle(3)).toBe('3 selected')
    expect(tabsWord(0)).toBe('0 tabs')
  })
})

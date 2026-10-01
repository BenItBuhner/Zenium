import { describe, expect, it } from 'vitest'
import type { OverviewMenuContext } from '../../shared/overviewMenu'
import { overviewMenuTemplate, type OverviewMenuActs } from '../overviewMenu'
import type { MenuItemTemplate } from '../platform'

/*
 * The tab overview's ⋯ menu as the core's template (tab overview cleanup spec §4, §5): the
 * rows `overviewMenu` writes, each mapped to the host's item – the three the core runs itself
 * (New Tab, New Private Tab, a Switch Space ▸ row) and every other row handed to the chrome as
 * its command; the destructive row in the danger ink; a zero-count row greyed, not gone; the
 * hairline a separator; the spaces as radio rows with the current one checked.
 */

function acts(): OverviewMenuActs & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    newTab: () => calls.push('newTab'),
    newPrivateTab: () => calls.push('newPrivateTab'),
    switchSpace: (id) => calls.push(`switchSpace:${id}`),
    chrome: (command) => calls.push(`chrome:${command}`)
  }
}

const AT_REST: OverviewMenuContext = {
  view: 'tabs',
  privateTabs: true,
  counts: { closable: 3, selectable: 3, regular: 3, private: 2, inactive: 1, recentlyClosed: 4 },
  spaces: [
    { id: 'work', label: 'Work', current: true },
    { id: 'home', label: 'Home', current: false }
  ],
  selection: null
}

const labels = (items: MenuItemTemplate[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '—' : i.label!))

describe('the overview menu template (§4)', () => {
  it('maps every row in order: the core’s three to its own acts, the rest to the chrome’s command', () => {
    const a = acts()
    const items = overviewMenuTemplate(AT_REST, a)
    expect(labels(items)).toEqual([
      'New Tab',
      'New Private Tab',
      'Private Tabs (2)',
      'Select Tabs',
      'Search Tabs',
      'Inactive Tabs (1)',
      'Recently Closed (4)',
      '—',
      'Close All Tabs (3)',
      'Switch Space'
    ])
    for (const item of items) if (item.type !== 'separator' && !item.submenu) item.click?.()
    expect(a.calls).toEqual([
      'newTab',
      'newPrivateTab',
      'chrome:switch-view',
      'chrome:select-tabs',
      'chrome:search-tabs',
      'chrome:inactive-tabs',
      'chrome:recently-closed',
      'chrome:close-all'
    ])
  })

  it('writes the destructive row in the danger ink after the one separator, and greys a zero count', () => {
    const items = overviewMenuTemplate(
      { ...AT_REST, counts: { ...AT_REST.counts, closable: 0, selectable: 0 } },
      acts()
    )
    const closeAll = items.find((i) => i.label?.startsWith('Close All Tabs'))!
    expect(closeAll.danger).toBe(true)
    expect(closeAll.enabled).toBe(false)
    expect(items.find((i) => i.label === 'Select Tabs')!.enabled).toBe(false)
    expect(items.filter((i) => i.danger)).toHaveLength(1)
    expect(items.filter((i) => i.type === 'separator')).toHaveLength(1)
    expect(items.indexOf(closeAll) - items.findIndex((i) => i.type === 'separator')).toBe(1)
    // The plain rows carry no danger and are enabled.
    expect(items.find((i) => i.label === 'New Tab')!.danger).toBeUndefined()
    expect(items.find((i) => i.label === 'New Tab')!.enabled).toBe(true)
  })

  it('Switch Space ▸ is a submenu of radio rows, the current space checked, each switching the window', () => {
    const a = acts()
    const items = overviewMenuTemplate(AT_REST, a)
    const switchSpace = items.find((i) => i.label === 'Switch Space')!
    expect(switchSpace.click).toBeUndefined()
    expect(switchSpace.submenu!.map((s) => [s.type, s.label, s.checked])).toEqual([
      ['radio', 'Work', true],
      ['radio', 'Home', false]
    ])
    switchSpace.submenu![1]!.click?.()
    expect(a.calls).toEqual(['switchSpace:home'])
  })

  it('in selection mode is the selection’s three rows, Close Selected in the danger ink', () => {
    const a = acts()
    const items = overviewMenuTemplate({ ...AT_REST, selection: { selected: 2, total: 3 } }, a)
    expect(labels(items)).toEqual(['Select All', 'Deselect All', 'Close Selected (2)'])
    expect(items[2]!.danger).toBe(true)
    for (const item of items) item.click?.()
    expect(a.calls).toEqual(['chrome:select-all', 'chrome:deselect-all', 'chrome:close-selected'])
  })

  it('in the private view: Close Private Tabs, Tabs (N) the way back, no Switch Space', () => {
    const items = overviewMenuTemplate({ ...AT_REST, view: 'private' }, acts())
    expect(labels(items)).toEqual([
      'New Tab',
      'New Private Tab',
      'Tabs (3)',
      'Select Tabs',
      'Search Tabs',
      '—',
      'Close Private Tabs (3)'
    ])
    expect(items.some((i) => i.submenu)).toBe(false)
  })
})

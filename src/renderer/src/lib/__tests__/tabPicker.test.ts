import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import type { SplitGroup, Tab, TabSearchCandidate, UIState } from '@shared/types'
import { run } from '../api'
import { isEmptySplitPane } from '../selectors'
import { buildRows, closeTabSearch, openTabPicker, pickCandidates } from '../tabSearch'
import { overlayCoversContent, type TabPickRequest, uiStore } from '../ui'

/*
 * The empty pane's tab picker (split-04): the tab search popover in its pick mode lists the
 * window's other open tabs alone, the chrome knows which pane is the empty one it draws itself,
 * and the URL bar floating in that pane hides no page.
 */

function candidate(over: Partial<TabSearchCandidate> & { id: string }): TabSearchCandidate {
  return {
    title: over.id,
    url: `https://${over.id}.example/`,
    favicon: null,
    customIcon: null,
    containerId: 'default',
    windowLabel: null,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    discarded: false,
    lastActiveAt: 0,
    ...over
  }
}

const pick: TabPickRequest = {
  paneTabId: 'blank',
  groupId: 'g1',
  pane: { x: 300, y: 40, width: 600, height: 900 }
}

const group: SplitGroup = {
  id: 'g1',
  spaceId: 's1',
  tabIds: ['a', 'blank'],
  layout: 'vertical',
  sizes: [0.5, 0.5]
}

afterEach(() => {
  closeTabSearch()
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false, pane: false } }))
  vi.mocked(run).mockClear()
})

describe('pickCandidates', () => {
  it("offers the window's other open tabs: not the pane, not the split's tabs, not another window's, no chrome page", () => {
    const list = [
      candidate({ id: 'a' }),
      candidate({ id: 'blank', url: 'zen://blank' }),
      candidate({ id: 'b' }),
      candidate({ id: 'elsewhere', windowLabel: 'Window 2' }),
      candidate({ id: 'settings', url: 'zen://settings' }),
      candidate({ id: 'pdf', url: 'zen://pdf?id=1' }),
      candidate({ id: 'c', audible: true })
    ]
    expect(pickCandidates(list, pick, group).map((c) => c.id)).toEqual(['b', 'pdf', 'c'])
  })

  it('leaves out only the pane itself when the split is not known', () => {
    const list = [candidate({ id: 'a' }), candidate({ id: 'blank' })]
    expect(pickCandidates(list, pick, undefined).map((c) => c.id)).toEqual(['a'])
  })
})

describe('buildRows in pick mode', () => {
  const closedEntry = {
    id: 'closed-1',
    kind: 'tab' as const,
    title: 'Closed news',
    url: 'https://news.example/',
    favicon: null,
    closedAt: 0,
    tabCount: 1
  }

  it('lists the open tabs under no heading and skips the sound and closed sections', () => {
    const rows = buildRows(
      [candidate({ id: 'news', audible: true }), candidate({ id: 'docs' })],
      [closedEntry],
      '',
      true
    )
    expect(rows.map((r) => r.kind)).toEqual(['tab', 'tab'])
    expect(rows.map((r) => (r.kind === 'tab' ? r.index : -1))).toEqual([0, 1])
  })

  it('filters by the query and says so when nothing matches', () => {
    const tabs = [candidate({ id: 'news' }), candidate({ id: 'docs' })]
    const matching = buildRows(tabs, [closedEntry], 'doc', true)
    expect(matching.map((r) => (r.kind === 'tab' ? r.ranked.tab.id : r.kind))).toEqual(['docs'])
    // "news" matches the closed entry, which a pane cannot show.
    expect(buildRows(tabs, [closedEntry], 'zzz', true)).toEqual([{ kind: 'empty', id: 'empty' }])
  })

  it('keeps the sections without the flag', () => {
    const rows = buildRows([candidate({ id: 'news', audible: true })], [closedEntry], '')
    expect(rows.filter((r) => r.kind === 'heading').map((r) => r.id)).toEqual([
      'heading:media',
      'heading:open',
      'heading:closed'
    ])
  })
})

describe('openTabPicker', () => {
  it('puts the request in the store with the keyboard in the chrome and the drawer closed', () => {
    uiStore.set({ drawerOpen: true })
    openTabPicker(pick)
    expect(uiStore.get().tabSearch).toEqual({ keyboard: true, pick })
    expect(uiStore.get().drawerOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })
})

describe('isEmptySplitPane', () => {
  const tab = (id: string, patch: Partial<Tab> = {}): Tab =>
    ({
      id,
      spaceId: 's1',
      url: `https://${id}.example/`,
      splitGroupId: null,
      ...patch
    }) as Tab

  const state = (over: Partial<UIState> = {}): UIState =>
    ({
      tabs: {
        a: tab('a', { splitGroupId: 'g1' }),
        blank: tab('blank', { url: 'zen://blank', splitGroupId: 'g1' }),
        loose: tab('loose', { url: 'zen://blank/' }),
        other: tab('other')
      },
      splitGroups: { g1: group },
      spaces: [{ id: 's1', tabIds: ['a', 'blank', 'loose', 'other'], activeTabId: 'a' }],
      activeSpaceId: 's1',
      essentialTabIds: [],
      ...over
    }) as unknown as UIState

  it('is the blank tab of the split on screen', () => {
    const s = state()
    expect(isEmptySplitPane(s, 'blank')).toBe(true)
    expect(isEmptySplitPane(s, 'a')).toBe(false)
    expect(isEmptySplitPane(s, 'other')).toBe(false)
    expect(isEmptySplitPane(s, null)).toBe(false)
  })

  it('is not a blank tab outside a split, nor one of a split that is not on screen', () => {
    expect(isEmptySplitPane(state(), 'loose')).toBe(false)
    const elsewhere = state({
      spaces: [{ id: 's1', tabIds: ['a', 'blank', 'loose', 'other'], activeTabId: 'other' }]
    } as unknown as Partial<UIState>)
    expect(isEmptySplitPane(elsewhere, 'blank')).toBe(false)
  })

  it('is the active pane too, while the blank tab itself is the active one', () => {
    const s = state({
      spaces: [{ id: 's1', tabIds: ['a', 'blank', 'loose', 'other'], activeTabId: 'blank' }]
    } as unknown as Partial<UIState>)
    expect(isEmptySplitPane(s, 'blank')).toBe(true)
  })
})

describe("the empty pane's URL bar", () => {
  it('covers no page: the views beside it stay live', () => {
    const ui = uiStore.get()
    expect(overlayCoversContent({ ...ui, urlbar: { ...ui.urlbar, open: true } })).toBe(true)
    expect(overlayCoversContent({ ...ui, urlbar: { ...ui.urlbar, open: true, pane: true } })).toBe(
      false
    )
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem, Tab, UIState } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

vi.mock('../api', () => ({
  cmd: vi.fn(() => Promise.resolve(null)),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import {
  ANNOUNCE_CLEAR_MS,
  ANNOUNCE_REPEAT_MS,
  announce,
  announcerStore,
  downloadAnnouncement,
  findAnnouncement,
  muteAnnouncements,
  resetAnnouncer,
  startAnnouncer,
  stateAnnouncements,
  tabSwitchAnnouncement,
  zoomAnnouncement
} from '../announce'
import { browserStore } from '../ui'

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    title: `Page ${id}`,
    url: `https://${id}.example/`,
    pinned: false,
    muted: false,
    ...over
  } as Tab
}

/**
 * A snapshot with one space whose strip holds Essentials `e`, pinned `p`, folder `f`'s `f1`,
 * and the loose rows `a`, `b`, `c` – the order the strip (and `tabOrderOf`) reads them in.
 */
function state(over: {
  active?: string | null
  focused?: boolean
  tabs?: Record<string, Tab>
}): UIState {
  const tabs = over.tabs ?? {
    e: tab('e', { title: 'Mail' }),
    p: tab('p', { pinned: true }),
    f1: tab('f1', { folderId: 'f' }),
    a: tab('a', { title: 'Example Domain' }),
    b: tab('b', { title: '', customTitle: undefined, url: 'https://b.example/path' }),
    c: tab('c', { title: 'Third', customTitle: 'My notes' })
  }
  return {
    tabs,
    essentialTabIds: ['e'],
    folders: { f: { id: 'f', spaceId: 's', name: 'Work' } },
    spaces: [
      {
        id: 's',
        containerId: null,
        activeTabId: over.active === undefined ? 'a' : over.active,
        tabIds: ['p', 'f1', 'a', 'b', 'c']
      }
    ],
    activeSpaceId: 's',
    settings: { containerSpecificEssentials: false },
    window: { focused: over.focused ?? true }
  } as unknown as UIState
}

describe('announcement text', () => {
  it('names the front tab by its place in the strip order and its title', () => {
    const s = state({})
    expect(tabSwitchAnnouncement(s, 'e')).toBe('Tab 1 of 6, Mail')
    expect(tabSwitchAnnouncement(s, 'p')).toBe('Tab 2 of 6, Page p')
    expect(tabSwitchAnnouncement(s, 'f1')).toBe('Tab 3 of 6, Page f1')
    expect(tabSwitchAnnouncement(s, 'a')).toBe('Tab 4 of 6, Example Domain')
  })

  it("falls back to the address for an untitled tab and prefers the user's own title", () => {
    const s = state({})
    expect(tabSwitchAnnouncement(s, 'b')).toBe('Tab 5 of 6, https://b.example/path')
    expect(tabSwitchAnnouncement(s, 'c')).toBe('Tab 6 of 6, My notes')
  })

  it('names a tab the strip does not list without a place, and nothing for an unknown id', () => {
    const s = state({ tabs: { x: tab('x', { title: 'Popup' }) } })
    expect(tabSwitchAnnouncement(s, 'x')).toBe('Tab, Popup')
    expect(tabSwitchAnnouncement(s, 'nope')).toBeNull()
  })

  it('says a download starting and how it ended, by file name; progress and removal say nothing', () => {
    const named = (over: Partial<DownloadItem>): DownloadItem =>
      downloadItem({ id: 'd', filename: 'report.txt', ...over })
    expect(downloadAnnouncement(named({ state: 'progressing' }), 'started')).toBe(
      'Download started: report.txt'
    )
    expect(downloadAnnouncement(named({ state: 'progressing' }), 'progress')).toBeNull()
    expect(downloadAnnouncement(named({ state: 'completed' }), 'done')).toBe(
      'Download finished: report.txt'
    )
    expect(downloadAnnouncement(named({ state: 'interrupted' }), 'done')).toBe(
      'Download failed: report.txt'
    )
    expect(downloadAnnouncement(named({ state: 'cancelled' }), 'done')).toBe(
      'Download cancelled: report.txt'
    )
    expect(downloadAnnouncement(named({ state: 'completed' }), 'removed')).toBeNull()
    // The name on disk wins once the engine settled it (a "(1)" suffix).
    expect(
      downloadAnnouncement(named({ state: 'completed', finalName: 'report (1).txt' }), 'done')
    ).toBe('Download finished: report (1).txt')
  })

  it('reads the find count as words, and nothing before the page answers', () => {
    expect(findAnnouncement('lorem', { tabId: 't', activeMatchOrdinal: 3, matches: 12 })).toBe(
      '3 of 12 matches'
    )
    expect(findAnnouncement('lorem', { tabId: 't', activeMatchOrdinal: 1, matches: 1 })).toBe(
      '1 of 1 match'
    )
    expect(findAnnouncement('zzz', { tabId: 't', activeMatchOrdinal: 0, matches: 0 })).toBe(
      'No matches'
    )
    expect(findAnnouncement('lorem', null)).toBeNull()
    expect(findAnnouncement('', { tabId: 't', activeMatchOrdinal: 0, matches: 0 })).toBeNull()
  })

  it('reads the zoom as a percentage', () => {
    expect(zoomAnnouncement(1.25)).toBe('Zoom 125%')
    expect(zoomAnnouncement(1)).toBe('Zoom 100%')
    expect(zoomAnnouncement(0.5)).toBe('Zoom 50%')
  })

  it('names one muted or unmuted tab, counts several, and says a mixed change as two', () => {
    const before = state({})
    const oneMuted = state({
      tabs: { ...before.tabs, a: tab('a', { title: 'Example Domain', muted: true }) }
    })
    expect(muteAnnouncements(before, oneMuted)).toEqual(['Tab muted, Example Domain'])
    expect(muteAnnouncements(oneMuted, before)).toEqual(['Tab unmuted, Example Domain'])
    const site = state({
      tabs: {
        ...before.tabs,
        a: tab('a', { muted: true }),
        b: tab('b', { muted: true }),
        c: tab('c', { muted: true })
      }
    })
    expect(muteAnnouncements(before, site)).toEqual(['3 tabs muted'])
    const mixed = state({
      tabs: { ...oneMuted.tabs, b: tab('b', { muted: true }), c: tab('c', { muted: true }) }
    })
    const flipped = state({
      tabs: { ...mixed.tabs, a: tab('a', { title: 'Example Domain', muted: false }) }
    })
    expect(muteAnnouncements(mixed, flipped)).toEqual(['Tab unmuted, Example Domain'])
    expect(muteAnnouncements(before, flipped)).toEqual(['2 tabs muted'])
    expect(
      muteAnnouncements(state({ tabs: { ...before.tabs, b: tab('b', { muted: true }) } }), oneMuted)
    ).toEqual(['Tab muted, Example Domain', 'Tab unmuted, https://b.example/path'])
    // A tab that appeared muted (opened from a muted site) is not a change.
    expect(
      muteAnnouncements(before, state({ tabs: { ...before.tabs, n: tab('n', { muted: true }) } }))
    ).toEqual([])
    expect(muteAnnouncements(before, before)).toEqual([])
  })

  it('reads a switch of the front tab and mute changes from two states, in the focused window only', () => {
    const before = state({ active: 'a' })
    expect(stateAnnouncements(before, state({ active: 'c' }))).toEqual(['Tab 6 of 6, My notes'])
    expect(stateAnnouncements(before, state({ active: 'a' }))).toEqual([])
    expect(stateAnnouncements(before, state({ active: null }))).toEqual([])
    expect(stateAnnouncements(before, state({ active: 'c', focused: false }))).toEqual([])
    const muted = state({
      active: 'c',
      tabs: { ...before.tabs, a: tab('a', { title: 'Example Domain', muted: true }) }
    })
    expect(stateAnnouncements(before, muted)).toEqual([
      'Tab 6 of 6, My notes',
      'Tab muted, Example Domain'
    ])
  })
})

describe('the status region', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAnnouncer()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes a message, says the same words once within the repeat window, and empties itself', () => {
    expect(announce('Zoom 110%', 1000)).toBe(true)
    expect(announcerStore.get()).toEqual({ text: 'Zoom 110%', seq: 1 })
    // The same words again, at once: quiet (a key held down); the window slides with each press.
    expect(announce('Zoom 110%', 1000 + ANNOUNCE_REPEAT_MS - 1)).toBe(false)
    expect(announce('Zoom 110%', 1000 + 2 * ANNOUNCE_REPEAT_MS - 2)).toBe(false)
    expect(announcerStore.get().seq).toBe(1)
    // Other words go through, and the earlier ones may then follow again.
    expect(announce('Zoom 125%', 1100)).toBe(true)
    expect(announce('Zoom 110%', 1200)).toBe(true)
    expect(announcerStore.get()).toEqual({ text: 'Zoom 110%', seq: 3 })
    // After the repeat window the same words are said again, as a new message.
    expect(announce('Zoom 110%', 1200 + ANNOUNCE_REPEAT_MS)).toBe(true)
    expect(announcerStore.get().seq).toBe(4)
    // Empty text says nothing.
    expect(announce('   ')).toBe(false)
    expect(announcerStore.get().seq).toBe(4)
    // The region empties a while after the last message; the count stays so a repeat is a new node.
    vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS - 1)
    expect(announcerStore.get().text).toBe('Zoom 110%')
    vi.advanceTimersByTime(1)
    expect(announcerStore.get()).toEqual({ text: '', seq: 4 })
  })

  it('follows the browser state for the front tab and mute changes', () => {
    browserStore.set({ state: state({ active: 'a' }) })
    const stop = startAnnouncer()
    browserStore.set({ state: state({ active: 'b' }) })
    expect(announcerStore.get().text).toBe('Tab 5 of 6, https://b.example/path')
    // A snapshot with the same front tab says nothing.
    browserStore.set({ state: state({ active: 'b' }) })
    expect(announcerStore.get().seq).toBe(1)
    // A background window's snapshot says nothing either.
    browserStore.set({ state: state({ active: 'c', focused: false }) })
    expect(announcerStore.get().seq).toBe(1)
    stop()
    browserStore.set({ state: state({ active: 'a' }) })
    expect(announcerStore.get().seq).toBe(1)
  })
})

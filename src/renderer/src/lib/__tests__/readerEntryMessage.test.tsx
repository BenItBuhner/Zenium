// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab } from '@shared/types'
import { run } from '../api'
import { READER_ENTRY_ACTION, READER_ENTRY_CLOCK_MS, READER_ENTRY_TITLE } from '../readerEntry'
import { READER_BANNER_KEY, readerMutes, useReaderEntryMessage } from '../readerEntryMessage'
import {
  dismissBanner,
  holdBanner,
  pickBannerAction,
  showBanner,
  uiStore,
  type Banner
} from '../ui'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * The reader entry's strip (PUI-14): the shell's hook puts "Show Reader View?" on the §9.33
 * banner stack for an article page in front and takes it down as the page goes; a refusal –
 * every end but the action – mutes the site for the session, Chrome's `ReaderModeManager` rule.
 */

function article(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    url: 'https://news.example.com/story',
    readerable: true,
    discarded: false,
    ...overrides
  } as Tab
}

function Probe({ tab, enabled }: { tab: Tab | null; enabled: boolean }): JSX.Element {
  useReaderEntryMessage(tab, enabled)
  return createElement('i')
}

let root: Root
let container: HTMLDivElement

const banners = (): Banner[] => uiStore.get().banners.filter((b) => !b.leaving)
const offer = (): Banner | undefined => banners().find((b) => b.key === READER_BANNER_KEY)
const render = (tab: Tab | null, enabled = true): void => {
  act(() => root.render(createElement(Probe, { tab, enabled })))
}

beforeEach(() => {
  vi.mocked(run).mockReset()
  readerMutes.clear()
  uiStore.set({ banners: [], toasts: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the offer', () => {
  it('stands for an article page with Chrome-shaped words and one action', () => {
    render(article())
    const banner = offer()
    expect(banner).toBeDefined()
    expect(banner!.title).toBe(READER_ENTRY_TITLE)
    expect(banner!.action?.label).toBe(READER_ENTRY_ACTION)
    expect(banner!.duration).toBe(READER_ENTRY_CLOCK_MS)
    expect(banners()).toHaveLength(1)
  })

  it('is not made for a page the probe did not read, a reader tab, or no tab', () => {
    render(article({ readerable: false }))
    expect(offer()).toBeUndefined()
    render(article({ url: 'zen://reader?id=a&url=https%3A%2F%2Fnews.example.com%2Fstory' }))
    expect(offer()).toBeUndefined()
    render(null)
    expect(offer()).toBeUndefined()
  })

  it('never doubles on re-render and stays one banner for the same document', () => {
    render(article())
    const id = offer()!.id
    render(article())
    render(article({ title: 'renamed' }))
    expect(banners()).toHaveLength(1)
    expect(offer()!.id).toBe(id)
  })

  it('opens Reader View for the tab on its action and leaves the site unmuted', () => {
    render(article())
    act(() => pickBannerAction(offer()!.id))
    expect(run).toHaveBeenCalledWith('reader.toggle', { tabId: 't1' })
    expect(readerMutes.has('news.example.com')).toBe(false)
    expect(offer()).toBeUndefined()
  })
})

describe("Chrome's dismissal memory", () => {
  it('a swipe mutes the site for the session: the next page on it gets no offer, another site does', () => {
    render(article())
    act(() => dismissBanner(offer()!.id, 'swipe'))
    expect(readerMutes.has('news.example.com')).toBe(true)
    render(article({ url: 'https://news.example.com/other-story' }))
    expect(offer()).toBeUndefined()
    render(article({ id: 't2', url: 'https://blog.example.org/post' }))
    expect(offer()).toBeDefined()
  })

  it('the X mutes as the swipe does', () => {
    render(article())
    act(() => dismissBanner(offer()!.id, 'close'))
    expect(readerMutes.has('news.example.com')).toBe(true)
  })

  it("the clock's running out mutes as the X does: the offer left standing is gone at about 10 s and the site is muted for the session (§9.33 as amended)", () => {
    vi.useFakeTimers()
    try {
      render(article())
      expect(offer()).toBeDefined()
      act(() => vi.advanceTimersByTime(READER_ENTRY_CLOCK_MS - 1))
      expect(offer()).toBeDefined()
      expect(readerMutes.has('news.example.com')).toBe(false)
      act(() => vi.advanceTimersByTime(1))
      expect(offer()).toBeUndefined()
      expect(readerMutes.has('news.example.com')).toBe(true)
      // The next page on the site gets no offer, as after the X.
      render(article({ url: 'https://news.example.com/other-story' }))
      expect(offer()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a finger on the banner pauses the clock (the §9.33 host’s hold); it resumes on the release', () => {
    vi.useFakeTimers()
    try {
      render(article())
      const id = offer()!.id
      act(() => vi.advanceTimersByTime(4000))
      act(() => holdBanner(id, true))
      act(() => vi.advanceTimersByTime(READER_ENTRY_CLOCK_MS))
      expect(offer()).toBeDefined()
      expect(readerMutes.has('news.example.com')).toBe(false)
      act(() => holdBanner(id, false))
      act(() => vi.advanceTimersByTime(READER_ENTRY_CLOCK_MS - 4000))
      expect(offer()).toBeUndefined()
      expect(readerMutes.has('news.example.com')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Reader View entered by another door while the offer stood (the menu’s row, the sheet’s) is the offer taken: no mute', () => {
    render(article())
    expect(offer()).toBeDefined()
    // The core drops `readerable` on the reader document; the same tab now shows the page's reader.
    render(
      article({
        url: `zen://reader?id=article_1&url=${encodeURIComponent('https://news.example.com/story')}`,
        readerable: false
      })
    )
    expect(offer()).toBeUndefined()
    expect(readerMutes.has('news.example.com')).toBe(false)
    // Back on the article after the exit, the offer returns (gate (f): the memory works as Chrome's).
    render(article())
    expect(offer()).toBeDefined()
  })

  it('leaving the page with the offer standing mutes the site (the scope destroyed)', () => {
    render(article())
    expect(offer()).toBeDefined()
    render(article({ url: 'https://news.example.com/next', readerable: false }))
    expect(offer()).toBeUndefined()
    expect(readerMutes.has('news.example.com')).toBe(true)
  })

  it('another tab in front with the offer standing mutes the site', () => {
    render(article())
    render(article({ id: 't2', url: 'https://other.example.net/', readerable: false }))
    expect(readerMutes.has('news.example.com')).toBe(true)
  })

  it('a hash jump inside the article is the same document: no mute', () => {
    render(article())
    // The core drops `readerable` on an in-page navigation; the offer goes, the site is not muted.
    render(article({ url: 'https://news.example.com/story#footnote-3', readerable: false }))
    expect(offer()).toBeUndefined()
    expect(readerMutes.has('news.example.com')).toBe(false)
  })

  it('a gate closing over the page (fullscreen, the lock, onboarding) is no answer: the offer returns with the gate', () => {
    render(article())
    render(article(), false)
    expect(offer()).toBeUndefined()
    expect(readerMutes.has('news.example.com')).toBe(false)
    render(article(), true)
    expect(offer()).toBeDefined()
  })

  it('a third banner pushing the offer off the stack is not the user’s answer', () => {
    render(article())
    act(() => {
      showBanner({ title: 'one', duration: null })
      showBanner({ title: 'two', duration: null })
      showBanner({ title: 'three', duration: null })
    })
    expect(offer()).toBeUndefined()
    expect(readerMutes.has('news.example.com')).toBe(false)
  })

  it('the action un-mutes a site muted earlier in the session', () => {
    readerMutes.mute('news.example.com')
    render(article())
    expect(offer()).toBeUndefined()
    // Reached another way (the app menu) and offered again after the mute is lifted by hand:
    readerMutes.unmute('news.example.com')
    render(article({ url: 'https://news.example.com/again' }))
    expect(offer()).toBeDefined()
    act(() => pickBannerAction(offer()!.id))
    expect(readerMutes.has('news.example.com')).toBe(false)
  })
})

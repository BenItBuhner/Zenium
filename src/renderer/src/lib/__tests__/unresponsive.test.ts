import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { run } from '../api'
import {
  closeUnresponsivePrompt,
  openUnresponsivePrompt,
  unresponsiveTabs,
  unresponsiveWords,
  unresponsiveWordsFor
} from '../unresponsive'
import { chromeNeedsKeyboard, overlayCoversContent, panelAloneOverContent, uiStore } from '../ui'

/*
 * The "Page unresponsive" prompt's facts (lib/unresponsive.ts, tabs-45): which pages the
 * window's prompt names – every hung page still loaded, for the window looking at one of them –
 * Chrome's words for one page and for several, and the page's way under the prompt: captured
 * and hidden behind its picture while the prompt is up, live again as it leaves.
 */

afterEach(() => {
  closeUnresponsivePrompt()
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
})

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    discarded: false,
    splitGroupId: null,
    ...over
  } as Tab
}

function state(tabs: Tab[], activeTabId: string): UIState {
  return {
    platform: 'linux',
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: DEFAULT_CONTAINER_ID,
        tabIds: tabs.map((t) => t.id),
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: {},
    essentialTabIds: [],
    settings: {},
    window: { kind: 'normal', fullscreen: false, prompt: null }
  } as unknown as UIState
}

describe('unresponsiveTabs', () => {
  it('names every hung page still loaded when the window looks at one of them, in the state’s order', () => {
    const s = state(
      [tab('a', { unresponsive: true }), tab('b'), tab('c', { unresponsive: true })],
      'a'
    )
    expect(unresponsiveTabs(s).map((t) => t.id)).toEqual(['a', 'c'])
  })

  it('names none when the page in front answers: the prompt is the window’s whose page stands still', () => {
    const s = state([tab('a', { unresponsive: true }), tab('b')], 'b')
    expect(unresponsiveTabs(s)).toEqual([])
  })

  it('counts a hung pane of the front tab’s split as looked at', () => {
    const s = state(
      [tab('a', { splitGroupId: 'g' }), tab('b', { splitGroupId: 'g', unresponsive: true })],
      'a'
    )
    expect(unresponsiveTabs(s).map((t) => t.id)).toEqual(['b'])
  })

  it('leaves a sleeping tab out: it has no renderer to be hung', () => {
    const s = state(
      [tab('a', { unresponsive: true }), tab('b', { unresponsive: true, discarded: true })],
      'a'
    )
    expect(unresponsiveTabs(s).map((t) => t.id)).toEqual(['a'])
    expect(
      unresponsiveTabs(state([tab('a', { unresponsive: true, discarded: true })], 'a'))
    ).toEqual([])
  })

  it('names none when nothing is hung', () => {
    expect(unresponsiveTabs(state([tab('a'), tab('b')], 'a'))).toEqual([])
  })
})

describe('unresponsiveWords', () => {
  it("are Chrome's for one page", () => {
    expect(unresponsiveWords(['Docs'])).toEqual({
      title: 'Page unresponsive',
      description: 'You can wait for it to become responsive or exit the page.',
      action: 'Exit page'
    })
    expect(unresponsiveWords([])).toEqual(unresponsiveWords(['Docs']))
  })

  it('name the pages in one description for several, and the verb takes the plural', () => {
    expect(unresponsiveWords(['Docs', 'Sheets'])).toEqual({
      title: 'Pages unresponsive',
      description:
        '“Docs”, “Sheets” are not responding. You can wait for them to become responsive or exit the pages.',
      action: 'Exit pages'
    })
  })

  it('read the rows’ titles: a custom title over the page’s', () => {
    const words = unresponsiveWordsFor([tab('a', { customTitle: 'Mine' }), tab('b')])
    expect(words.description).toContain('“Mine”, “B”')
    expect(unresponsiveWordsFor([tab('a')])).toEqual(unresponsiveWords(['A']))
  })
})

describe('openUnresponsivePrompt / closeUnresponsivePrompt', () => {
  it('hides the page behind its picture once the capture is in, takes the keyboard, and gives both back on close', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    expect(uiStore.get().unresponsivePromptOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)

    await openUnresponsivePrompt('a')
    expect(uiStore.get().unresponsivePromptOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    // The prompt covers the page (the view hides, the capture stands in) and, a frame dialog,
    // dims it: not one of the panels that leave the picture undimmed.
    expect(overlayCoversContent(uiStore.get())).toBe(true)
    expect(panelAloneOverContent(uiStore.get())).toBe(false)
    expect(chromeNeedsKeyboard()).toBe(true)

    vi.mocked(run).mockClear()
    closeUnresponsivePrompt()
    expect(uiStore.get().unresponsivePromptOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    expect(chromeNeedsKeyboard()).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('a close overtakes an open still waiting for the picture: the page answered first', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    const opening = openUnresponsivePrompt('a')
    closeUnresponsivePrompt()
    await opening
    expect(uiStore.get().unresponsivePromptOpen).toBe(false)
    expect(run).not.toHaveBeenCalledWith('focus.chrome', undefined)
  })
})

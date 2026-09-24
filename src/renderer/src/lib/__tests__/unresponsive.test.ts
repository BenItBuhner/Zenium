import { describe, expect, it } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { unresponsiveTabs, unresponsiveWords, unresponsiveWordsFor } from '../unresponsive'

/*
 * The "Page unresponsive" prompt's facts (lib/unresponsive.ts, tabs-45): which pages the
 * window's prompt names – every hung page still loaded, for the window looking at one of them –
 * and Chrome's words for one page and for several.
 */

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

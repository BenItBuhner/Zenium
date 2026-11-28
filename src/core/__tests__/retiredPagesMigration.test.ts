import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import { BrowserState } from '../state'

/**
 * A profile from a build that had a reading list or an inactive-tabs archive loads their pages
 * as bookmarks, and the next
 * state written writes no `readingList` back: the fold runs once.
 */
describe('a saved reading list or inactive-tabs archive at load', () => {
  it('becomes a Reading List bookmarks folder and is not persisted again', () => {
    const writes: string[] = []
    const saved = JSON.stringify({
      version: 6,
      readingList: [
        { id: 'rl_1', url: 'https://later.example/', title: 'Later', addedAt: 2, updatedAt: 2 },
        { id: 'rl_0', url: 'https://first.example/', title: 'First', addedAt: 1, updatedAt: 1 }
      ],
      archivedTabs: [
        {
          kind: 'tab',
          id: 'c1',
          tab: { url: 'https://idle.example/', title: 'Idle', lastActiveAt: 5 }
        }
      ]
    })
    const io: StoreIO = {
      readSync: () => saved,
      write: async (_name: string, text: string) => {
        writes.push(text)
      },
      writeSync: (_name: string, text: string) => {
        writes.push(text)
      }
    }
    const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
    state.load()
    const folder = state.bookmarks.find((n) => n.type === 'folder' && n.title === 'Reading List')
    expect(folder?.parentId).toBe(OTHER_BOOKMARKS_ID)
    const pages = state.bookmarks
      .filter((n) => n.parentId === folder?.id)
      .sort((a, b) => a.index - b.index)
      .map((n) => n.title)
    expect(pages).toEqual(['First', 'Later'])
    state.flushSync()
    const last = JSON.parse(writes.at(-1)!) as Record<string, unknown>
    expect(last).not.toHaveProperty('readingList')
    expect(last).not.toHaveProperty('archivedTabs')
    const idle = state.bookmarks.find((n) => n.type === 'folder' && n.title === 'Inactive Tabs')
    expect(state.bookmarks.filter((n) => n.parentId === idle?.id).map((n) => n.url)).toEqual([
      'https://idle.example/'
    ])
  })
})

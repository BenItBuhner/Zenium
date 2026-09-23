import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The toast a bookmark delete leaves (lib/bookmarkUndo.ts; bookmarks-31; v2 draft §9.33): one
 * line naming what went, one action – Undo – that asks the core for that one delete back by its
 * token, so a move made since stays. One such toast at a time; its clock outlasts a plain
 * action toast's.
 */

const calls: Array<[string, unknown]> = []
vi.stubGlobal('window', {
  zen: {
    invoke: async (name: string, args: unknown) => {
      calls.push([name, args])
      return null
    },
    on: () => () => undefined
  }
})

const { BOOKMARK_UNDO_TOAST_MS, bookmarkDeletedMessage, bookmarkEditUndone, showBookmarkDeleted } =
  await import('../bookmarkUndo')
const { TOAST_ACTION_DURATION, pickToastAction, uiStore } = await import('../ui')

const live = (): Array<[string, string | undefined]> =>
  uiStore
    .get()
    .toasts.filter((t) => !t.leaving)
    .map((t) => [t.message, t.action?.label])

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  uiStore.set({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what the toast says', () => {
  it('names one bookmark or folder, counts several, and calls a mix items', () => {
    expect(bookmarkDeletedMessage({ token: 1, count: 1, kind: 'bookmark' })).toBe(
      'Bookmark deleted'
    )
    expect(bookmarkDeletedMessage({ token: 1, count: 1, kind: 'folder' })).toBe('Folder deleted')
    expect(bookmarkDeletedMessage({ token: 1, count: 3, kind: 'bookmark' })).toBe(
      '3 bookmarks deleted'
    )
    expect(bookmarkDeletedMessage({ token: 1, count: 2, kind: 'folder' })).toBe('2 folders deleted')
    expect(bookmarkDeletedMessage({ token: 1, count: 4, kind: 'mixed' })).toBe('4 items deleted')
  })
})

describe('the toast', () => {
  it('offers Undo, which asks the core for that delete by its token', async () => {
    showBookmarkDeleted({ token: 7, count: 1, kind: 'bookmark' })
    expect(live()).toEqual([['Bookmark deleted', 'Undo']])
    const toast = uiStore.get().toasts[0]
    expect(toast.duration).toBe(BOOKMARK_UNDO_TOAST_MS)
    expect(BOOKMARK_UNDO_TOAST_MS).toBeGreaterThan(TOAST_ACTION_DURATION)
    pickToastAction(toast.id)
    await Promise.resolve()
    expect(calls).toEqual([['bookmark.undo', { token: 7 }]])
    expect(live()).toEqual([])
  })

  it('a second delete replaces the first toast; the first delete stays for the manager to undo', () => {
    showBookmarkDeleted({ token: 1, count: 1, kind: 'bookmark' })
    showBookmarkDeleted({ token: 2, count: 1, kind: 'folder' })
    expect(live()).toEqual([['Folder deleted', 'Undo']])
    // Nothing was undone by the replacement: the manager's Ctrl+Z still has both.
    expect(calls).toEqual([])
  })

  it('leaves on its own after its clock runs out', () => {
    showBookmarkDeleted({ token: 3, count: 1, kind: 'bookmark' })
    vi.advanceTimersByTime(BOOKMARK_UNDO_TOAST_MS - 1)
    expect(live()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(live()).toHaveLength(0)
    expect(calls).toEqual([])
  })

  it("goes down when its delete is undone elsewhere (the manager's Ctrl+Z), and stays for another edit's undo", () => {
    showBookmarkDeleted({ token: 4, count: 1, kind: 'bookmark' })
    // A move taken back, or an older delete: not this toast's business.
    bookmarkEditUndone({ token: 9, kind: 'move' })
    bookmarkEditUndone({ token: 3, kind: 'remove' })
    expect(live()).toEqual([['Bookmark deleted', 'Undo']])
    bookmarkEditUndone({ token: 4, kind: 'remove' })
    expect(live()).toEqual([])
    // Nothing was asked of the core: the undo already happened.
    expect(calls).toEqual([])
    // A later word about the same token finds no toast and does nothing.
    bookmarkEditUndone({ token: 4, kind: 'remove' })
    showBookmarkDeleted({ token: 5, count: 2, kind: 'folder' })
    bookmarkEditUndone({ token: 4, kind: 'remove' })
    expect(live()).toEqual([['2 folders deleted', 'Undo']])
  })
})

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  dropEffectFor,
  dropKeyFor,
  droppedBookmark,
  feedbackKeyFor,
  payloadKind,
  readInputs,
  slotInRows,
  type ChromeDropTarget,
  type TransferLike
} from '../dropIntent'

/*
 * The drop-intent classifier (`lib/dropIntent.ts`): what a drag from outside the tab strip
 * carries, where in a list it points, and what a drop of X on target Y does – Chrome's drop
 * semantics for the tab strip, the omnibox and the bookmarks bar.
 */

function transfer(
  data: Record<string, string>,
  files: Array<{ name: string; path?: string }> = []
): TransferLike {
  const types = Object.keys(data)
  if (files.length) types.push('Files')
  return {
    types,
    getData: (type) => data[type] ?? '',
    files: files.map((f) => ({ name: f.name, path: f.path }) as unknown as File)
  }
}
const pathOf = (file: File): string | undefined => (file as unknown as { path?: string }).path

describe('payloadKind', () => {
  it('reads the links first, then the files, then the text', () => {
    expect(payloadKind(['text/plain', 'text/uri-list', 'Files'])).toBe('urls')
    expect(payloadKind(['text/plain', 'Files'])).toBe('files')
    expect(payloadKind(['text/plain', 'text/html'])).toBe('text')
  })
  it('is no drop for the chrome without any of them', () => {
    expect(payloadKind([])).toBeNull()
    expect(payloadKind(['text/html', 'application/x-moz-file'])).toBeNull()
  })
})

describe('readInputs', () => {
  it('takes every link of a uri-list, comments and blank lines dropped', () => {
    const dt = transfer({
      'text/uri-list': '# a comment\r\nhttps://a.example/\r\n\r\n  https://b.example/x \r\n',
      'text/plain': 'ignored when links are there'
    })
    expect(readInputs(dt, pathOf)).toEqual(['https://a.example/', 'https://b.example/x'])
  })
  it('opens dropped files as file: URLs, skipping one the host cannot place', () => {
    const dt = transfer({}, [
      { name: 'report.pdf', path: '/home/me/My Docs/report.pdf' },
      { name: 'ghost.txt' },
      { name: 'page.html', path: '/tmp/page.html' }
    ])
    expect(readInputs(dt, pathOf)).toEqual([
      'file:///home/me/My%20Docs/report.pdf',
      'file:///tmp/page.html'
    ])
  })
  it('collapses dropped text to one line, as the omnibox takes a drop', () => {
    const dt = transfer({ 'text/plain': '  hello\n  drag and\tdrop  ' })
    expect(readInputs(dt, pathOf)).toEqual(['hello drag and drop'])
  })
  it('is nothing for an empty selection', () => {
    expect(readInputs(transfer({ 'text/plain': '   ' }), pathOf)).toEqual([])
    expect(readInputs(transfer({ 'text/uri-list': '# only a comment' }), pathOf)).toEqual([])
  })
})

describe('droppedBookmark', () => {
  it('names a dragged link by its text', () => {
    const dt = transfer({
      'text/uri-list': 'https://example.com/docs',
      'text/plain': 'https://example.com/docs',
      'text/html': '<a href="https://example.com/docs">The <b>docs</b></a>'
    })
    expect(droppedBookmark(dt, pathOf)).toEqual({
      url: 'https://example.com/docs',
      title: 'The docs'
    })
  })
  it('bookmarks URL text by its host, and a bare host upgraded', () => {
    expect(
      droppedBookmark(transfer({ 'text/plain': 'https://www.example.com/a' }), pathOf)
    ).toEqual({ url: 'https://www.example.com/a', title: 'example.com' })
    expect(droppedBookmark(transfer({ 'text/plain': 'example.org' }), pathOf)).toEqual({
      url: 'https://example.org',
      title: 'example.org'
    })
  })
  it('is no bookmark for text that is not an address, nor for a Zenium page', () => {
    expect(droppedBookmark(transfer({ 'text/plain': 'drag and drop' }), pathOf)).toBeNull()
    expect(droppedBookmark(transfer({ 'text/uri-list': 'zen://settings' }), pathOf)).toBeNull()
  })
  it('bookmarks a dropped file under its name', () => {
    const dt = transfer({}, [{ name: 'notes.txt', path: '/tmp/notes.txt' }])
    expect(droppedBookmark(dt, pathOf)).toEqual({
      url: 'file:///tmp/notes.txt',
      title: 'notes.txt'
    })
  })
})

describe('dropEffectFor', () => {
  it('shows the copy badge when the source allows it, else link, else move', () => {
    expect(dropEffectFor('uninitialized')).toBe('copy')
    expect(dropEffectFor('all')).toBe('copy')
    expect(dropEffectFor('copyLink')).toBe('copy')
    expect(dropEffectFor('copyMove')).toBe('copy')
    expect(dropEffectFor('link')).toBe('link')
    expect(dropEffectFor('linkMove')).toBe('link')
    expect(dropEffectFor('move')).toBe('move')
  })
})

describe('slotInRows', () => {
  const rows = [
    { id: 'a', start: 0, end: 40 },
    { id: 'b', start: 44, end: 84 },
    { id: 'c', start: 88, end: 128 }
  ]
  it('is the row itself over its middle half, the slots beside it over its outer quarters', () => {
    expect(slotInRows(5, rows)).toEqual({ id: 'a', position: 'before' })
    expect(slotInRows(20, rows)).toEqual({ id: 'a', position: 'into' })
    expect(slotInRows(29, rows)).toEqual({ id: 'a', position: 'into' })
    expect(slotInRows(30, rows)).toEqual({ id: 'a', position: 'after' })
    expect(slotInRows(64, rows)).toEqual({ id: 'b', position: 'into' })
  })
  it('follows the pointer through a gap to the nearer edge', () => {
    expect(slotInRows(41, rows)).toEqual({ id: 'a', position: 'after' })
    expect(slotInRows(43, rows)).toEqual({ id: 'b', position: 'before' })
  })
  it('is before the first row ahead of the list and after the last past it', () => {
    expect(slotInRows(-10, rows)).toEqual({ id: 'a', position: 'before' })
    expect(slotInRows(300, rows)).toEqual({ id: 'c', position: 'after' })
  })
  it('is nothing for an empty list', () => {
    expect(slotInRows(10, [])).toBeNull()
  })
})

describe('dropKeyFor: what a drop of X on target Y does', () => {
  const tab = (position: 'before' | 'after' | 'into'): ChromeDropTarget => ({
    kind: 'tab',
    tabId: 't1',
    position
  })
  const address = (over: Partial<Extract<ChromeDropTarget, { kind: 'address' }>> = {}) =>
    ({
      kind: 'address',
      tabId: 't1',
      spaceId: 's1',
      readOnly: false,
      own: false,
      ...over
    }) as const satisfies ChromeDropTarget
  const chrome: ChromeDropTarget = { kind: 'chrome', spaceId: 's1' }

  it('navigates the tab a link is dropped on, and opens a new tab in the slot beside one', () => {
    expect(dropKeyFor('urls', tab('into'))).toBe('tab:t1:into')
    expect(dropKeyFor('text', tab('before'))).toBe('tab:t1:before')
    expect(dropKeyFor('files', tab('after'))).toBe('tab:t1:after')
  })
  it('opens new tabs at the end of a section, on the new-tab button, in a folder, in a space', () => {
    expect(dropKeyFor('urls', { kind: 'section', section: 'pinned', spaceId: 's1' })).toBe(
      'section:pinned:s1'
    )
    expect(dropKeyFor('urls', { kind: 'section', section: 'essential', spaceId: '' })).toBe(
      'section:essential:'
    )
    expect(dropKeyFor('text', { kind: 'newTab', spaceId: 's1' })).toBe('section:regular:s1')
    expect(dropKeyFor('urls', { kind: 'folder', folderId: 'f1' })).toBe('folder:f1')
    expect(dropKeyFor('files', { kind: 'space', spaceId: 's2' })).toBe('space:s2')
  })
  it('pastes and goes on the address pill: in its tab, or a new tab when it stands for none', () => {
    expect(dropKeyFor('urls', address())).toBe('tab:t1:into')
    expect(dropKeyFor('text', address({ tabId: null }))).toBe('section:regular:s1')
  })
  it("refuses a popup's read-only pill and the URL bar's own text dropped back on it", () => {
    expect(dropKeyFor('urls', address({ readOnly: true }))).toBeNull()
    expect(dropKeyFor('text', address({ own: true }))).toBeNull()
  })
  it('opens files dropped on the bare chrome in tabs; a link or text there has no target', () => {
    expect(dropKeyFor('files', chrome)).toBe('section:regular:s1')
    expect(dropKeyFor('urls', chrome)).toBeNull()
    expect(dropKeyFor('text', chrome)).toBeNull()
  })
  it('is nothing off every target', () => {
    expect(dropKeyFor('urls', null)).toBeNull()
  })
})

describe('feedbackKeyFor: what lights up', () => {
  it('marks the pill and the new-tab button as drop-into targets by their own keys', () => {
    expect(
      feedbackKeyFor('urls', {
        kind: 'address',
        tabId: 't1',
        spaceId: 's1',
        readOnly: false,
        own: false
      })
    ).toBe('address:')
    expect(feedbackKeyFor('urls', { kind: 'newTab', spaceId: 's1' })).toBe('newtab:s1')
  })
  it('marks a row, a folder, a space and a section by the key the drop acts on', () => {
    expect(feedbackKeyFor('urls', { kind: 'tab', tabId: 't1', position: 'into' })).toBe(
      'tab:t1:into'
    )
    expect(feedbackKeyFor('urls', { kind: 'tab', tabId: 't1', position: 'after' })).toBe(
      'tab:t1:after'
    )
    expect(feedbackKeyFor('text', { kind: 'folder', folderId: 'f1' })).toBe('folder:f1')
    expect(feedbackKeyFor('text', { kind: 'space', spaceId: 's2' })).toBe('space:s2')
    expect(feedbackKeyFor('text', { kind: 'section', section: 'essential', spaceId: '' })).toBe(
      'section:essential:'
    )
  })
  it('lights nothing for a refused drop or the bare chrome', () => {
    expect(
      feedbackKeyFor('urls', {
        kind: 'address',
        tabId: 't1',
        spaceId: 's1',
        readOnly: true,
        own: false
      })
    ).toBeNull()
    expect(feedbackKeyFor('files', { kind: 'chrome', spaceId: 's1' })).toBeNull()
    expect(feedbackKeyFor('urls', { kind: 'chrome', spaceId: 's1' })).toBeNull()
    expect(feedbackKeyFor('urls', null)).toBeNull()
  })
})

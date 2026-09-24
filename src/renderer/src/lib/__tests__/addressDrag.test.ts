// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Tab } from '@shared/types'
import { addressDragOf, anchorMarkup, writeAddressDrag, type TransferWriter } from '../addressDrag'
import { droppedBookmark, payloadKind, readInputs, type TransferLike } from '../dropIntent'

/*
 * The address dragged out of the URL pill (omnibox-43, dnd-11): which tabs the slot lifts, what
 * the drag carries, and that the chrome's own drop code reads it back as the link it is – a
 * bookmark named for the page, a navigation for a tab row.
 */

const tab = (url: string, patch: Partial<Tab> = {}): Tab =>
  ({ id: 't1', url, title: 'Example Domain', ...patch }) as Tab

/** A transfer written by the drag and read by a drop, as a `DataTransfer` would be. */
function transfer(): TransferWriter & TransferLike {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized',
    setData: (type, value) => void data.set(type, value),
    get types() {
      return [...data.keys()]
    },
    getData: (type) => data.get(type) ?? '',
    files: []
  }
}

describe('addressDragOf', () => {
  it('lifts a web page’s address with the page’s name, the address standing in for a blank name', () => {
    expect(addressDragOf(tab('https://example.com/a?b=1'), 'Example Domain')).toEqual({
      url: 'https://example.com/a?b=1',
      title: 'Example Domain'
    })
    expect(addressDragOf(tab('https://example.com/'), '   ')).toEqual({
      url: 'https://example.com/',
      title: 'https://example.com/'
    })
    // A file and an extension page are links too; the extension page in the spelling shown.
    expect(addressDragOf(tab('file:///home/me/notes.html'), 'Notes')?.url).toBe(
      'file:///home/me/notes.html'
    )
    expect(
      addressDragOf(tab('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html'), 'Ext')
        ?.url
    ).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')
  })

  it('offers nothing for an empty tab, a Zenium page or no tab', () => {
    expect(addressDragOf(tab('zen://newtab'), 'New tab')).toBeNull()
    expect(addressDragOf(tab('zen://blank/'), '')).toBeNull()
    expect(addressDragOf(tab('zen://settings'), 'Settings')).toBeNull()
    expect(addressDragOf(tab('about:blank'), '')).toBeNull()
    expect(addressDragOf(tab(''), '')).toBeNull()
    expect(addressDragOf(null, 'x')).toBeNull()
    expect(addressDragOf(undefined, 'x')).toBeNull()
  })
})

describe('writeAddressDrag', () => {
  it('writes the link, the text and an anchor with the page’s title, allowing a copy or a link and never a move', () => {
    const dt = transfer()
    writeAddressDrag(dt, { url: 'https://example.com/docs', title: 'The <docs> & "more"' })
    expect(dt.effectAllowed).toBe('copyLink')
    expect(dt.types).toEqual(['text/uri-list', 'text/plain', 'text/html'])
    expect(dt.getData('text/uri-list')).toBe('https://example.com/docs')
    expect(dt.getData('text/plain')).toBe('https://example.com/docs')
    expect(dt.getData('text/html')).toBe(
      '<a href="https://example.com/docs">The &lt;docs&gt; &amp; &quot;more&quot;</a>'
    )
  })

  it('escapes the address in the anchor as well as the title', () => {
    expect(anchorMarkup({ url: 'https://e.example/?a=1&b="x"', title: 'T' })).toBe(
      '<a href="https://e.example/?a=1&amp;b=&quot;x&quot;">T</a>'
    )
  })

  it('is read back by the chrome’s drops as a link: a bookmark named for the page, one input for a tab row', () => {
    const dt = transfer()
    writeAddressDrag(dt, { url: 'https://example.com/docs', title: 'Example docs' })
    expect(payloadKind(dt.types)).toBe('urls')
    expect(readInputs(dt, () => null)).toEqual(['https://example.com/docs'])
    expect(droppedBookmark(dt, () => null)).toEqual({
      url: 'https://example.com/docs',
      title: 'Example docs'
    })
  })
})

import { describe, expect, it } from 'vitest'
import { extensionPagesToReopen } from '../extensions'

const MDV = 'ckkdlimhmcjmikdlpkmbgfkaikojcbjk'
const OTHER = 'ipdjnhgkpapgippgcgkfcbpdpcgifncb'

const tab = (
  id: string,
  url: string,
  discarded = false
): { id: string; url: string; discarded: boolean } => ({ id, url, discarded })

describe('extensionPagesToReopen: what a host-grant reload brings back', () => {
  it('picks the extension’s own open pages at their URLs, in tab order', () => {
    const tabs = [
      tab('t1', 'http://127.0.0.1:38593/fixture.md'),
      tab('t2', `chrome-extension://${MDV}/options/index.html`),
      tab('t3', `chrome-extension://${OTHER}/popup.html`),
      tab('t4', `chrome-extension://${MDV}/content/index.html?file=a.md#top`),
      tab('t5', 'zen://settings')
    ]
    expect(extensionPagesToReopen(tabs, MDV)).toEqual([
      { tabId: 't2', url: `chrome-extension://${MDV}/options/index.html` },
      { tabId: 't4', url: `chrome-extension://${MDV}/content/index.html?file=a.md#top` }
    ])
  })

  it('leaves a discarded tab alone: it has no document to lose', () => {
    const tabs = [
      tab('t1', `chrome-extension://${MDV}/options/index.html`, true),
      tab('t2', `chrome-extension://${MDV}/options/index.html`)
    ]
    expect(extensionPagesToReopen(tabs, MDV)).toEqual([
      { tabId: 't2', url: `chrome-extension://${MDV}/options/index.html` }
    ])
  })

  it('never takes another extension’s page for this one (a shared id prefix is no match)', () => {
    const tabs = [tab('t1', `chrome-extension://${MDV}abc/page.html`)]
    expect(extensionPagesToReopen(tabs, MDV)).toEqual([])
    expect(extensionPagesToReopen([], MDV)).toEqual([])
  })
})

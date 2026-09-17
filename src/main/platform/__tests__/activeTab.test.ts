import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/types'
import { ActiveTabGrants, originPattern } from '../extensionApi/activeTab'
import type { ApiHost } from '../extensionApi/types'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const NO_ACTIVE_TAB = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function tab(id: string, url: string): Tab {
  return { id, url } as Tab
}

/** Chrome tab ids: a stable number per Zenium tab id, like the model's synthetic ids. */
function fakeHost(): ApiHost {
  const ids = new Map<string, number>()
  return {
    grants: (extensionId: string) => ({
      permissions: extensionId === EXT ? ['activeTab', 'storage'] : ['storage'],
      origins: []
    }),
    model: {
      chromeTabId: (t: Tab) => {
        let id = ids.get(t.id)
        if (id === undefined) {
          id = ids.size + 1
          ids.set(t.id, id)
        }
        return id
      }
    }
  } as unknown as ApiHost
}

describe('originPattern', () => {
  it('turns a URL into its origin match pattern for the schemes activeTab covers', () => {
    expect(originPattern('https://www.example.com:8443/a/b?c#d')).toBe(
      'https://www.example.com:8443/*'
    )
    expect(originPattern('http://example.com/')).toBe('http://example.com/*')
    expect(originPattern('ftp://files.example.com/x')).toBe('ftp://files.example.com/*')
    expect(originPattern('file:///home/me/page.html')).toBe('file:///*')
    expect(originPattern('chrome://settings/')).toBeNull()
    expect(originPattern('chrome-extension://abc/popup.html')).toBeNull()
    expect(originPattern('about:blank')).toBeNull()
    expect(originPattern('not a url')).toBeNull()
  })
})

describe('ActiveTabGrants', () => {
  it('grants the tab’s origin to extensions holding activeTab, per tab', () => {
    const grants = new ActiveTabGrants(fakeHost())
    const news = tab('t1', 'https://news.example.com/story')
    grants.grant(EXT, news)
    expect(grants.allowsUrl(EXT, 'https://news.example.com/other')).toBe(true)
    // A match pattern without a port covers every port, as in Chrome.
    expect(grants.allowsUrl(EXT, 'https://news.example.com:8443/other')).toBe(true)
    expect(grants.allowsUrl(EXT, 'http://news.example.com/')).toBe(false)
    expect(grants.allowsUrl(EXT, 'https://other.example.com/')).toBe(false)
    expect(grants.allowsUrl(EXT, '')).toBe(false)
    expect(grants.hasGrantForTab(EXT, 1)).toBe(true)
    expect(grants.hasGrantForTab(EXT, 2)).toBe(false)
  })

  it('does nothing for extensions without the permission or for non-web pages', () => {
    const grants = new ActiveTabGrants(fakeHost())
    grants.grant(NO_ACTIVE_TAB, tab('t1', 'https://news.example.com/'))
    expect(grants.allowsUrl(NO_ACTIVE_TAB, 'https://news.example.com/')).toBe(false)
    expect(grants.hasGrantForTab(NO_ACTIVE_TAB, 1)).toBe(false)
    grants.grant(EXT, tab('t2', 'chrome://settings/'))
    expect(grants.hasGrantForTab(EXT, 1)).toBe(false)
    expect(grants.hasGrantForTab(EXT, 2)).toBe(false)
  })

  it('keeps a grant across same-origin navigations and drops it on a cross-origin one', () => {
    const grants = new ActiveTabGrants(fakeHost())
    grants.grant(EXT, tab('t1', 'https://news.example.com/story'))
    grants.navigated(1, 'https://news.example.com/another#frag')
    expect(grants.hasGrantForTab(EXT, 1)).toBe(true)
    grants.navigated(1, 'https://shop.example.com/')
    expect(grants.hasGrantForTab(EXT, 1)).toBe(false)
    expect(grants.allowsUrl(EXT, 'https://news.example.com/')).toBe(false)
  })

  it('ends grants when the tab closes or the extension unloads', () => {
    const grants = new ActiveTabGrants(fakeHost())
    grants.grant(EXT, tab('t1', 'https://a.example.com/'))
    grants.grant(EXT, tab('t2', 'https://b.example.com/'))
    grants.tabRemoved(1)
    expect(grants.allowsUrl(EXT, 'https://a.example.com/')).toBe(false)
    expect(grants.allowsUrl(EXT, 'https://b.example.com/')).toBe(true)
    grants.forget(EXT)
    expect(grants.allowsUrl(EXT, 'https://b.example.com/')).toBe(false)
    expect(grants.hasGrantForTab(EXT, 2)).toBe(false)
  })

  it('re-granting on the same tab after a navigation follows the new origin', () => {
    const grants = new ActiveTabGrants(fakeHost())
    const t = tab('t1', 'https://a.example.com/')
    grants.grant(EXT, t)
    grants.navigated(1, 'https://b.example.com/')
    grants.grant(EXT, { ...t, url: 'https://b.example.com/page' })
    expect(grants.allowsUrl(EXT, 'https://b.example.com/x')).toBe(true)
    expect(grants.allowsUrl(EXT, 'https://a.example.com/')).toBe(false)
  })
})

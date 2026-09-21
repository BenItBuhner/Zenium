import { describe, expect, it } from 'vitest'
import { PRIVATE_CONTAINER_ID, type Tab } from '../../../shared/types'
import {
  DOCUMENT_EXT,
  historyPageName,
  inboxName,
  openTabsName,
  ownsName,
  parseDocument,
  parseHistoryPageName,
  parseInboxName,
  parseOpenTabsName,
  serializeDocument
} from '../documents'
import { FILE_EXT, isDeviceFileName } from '../transport'
import {
  OPEN_TABS_MAX,
  collectOpenTabs,
  isPublishedTab,
  openTabsHash,
  readOpenTabs,
  sortDeviceTabs
} from '../openTabs'
import { isSendableUrl, readSendTab, sendTabArrivedText } from '../sendTab'

describe('document names', () => {
  it('name each kind after its owner and parse back, ids reduced to safe characters', () => {
    expect(historyPageName('device_ab-1', 7)).toBe('device_ab-1.history.7.zenpage')
    expect(openTabsName('device_ab-1')).toBe('device_ab-1.tabs.zenpage')
    expect(inboxName('device_ab-1', 'send_9')).toBe('device_ab-1.inbox.send_9.zenpage')
    expect(historyPageName('we/ird id', 0)).toBe('we_ird_id.history.0.zenpage')
    expect(parseHistoryPageName('device_ab-1.history.7.zenpage')).toEqual({
      deviceId: 'device_ab-1',
      seq: 7
    })
    expect(parseOpenTabsName('device_ab-1.tabs.zenpage')).toBe('device_ab-1')
    expect(parseInboxName('device_ab-1.inbox.send_9.zenpage')).toEqual({
      targetId: 'device_ab-1',
      sendId: 'send_9'
    })
    expect(ownsName('we/ird id', 'we_ird_id')).toBe(true)
    expect(ownsName('device_ab-1', 'device_ab-2')).toBe(false)
  })

  it('never mistake one kind for another, nor for the device file', () => {
    for (const name of ['device_a.zensync', 'README.txt', 'device_a.tabs.zenpage', 'x.history.zenpage']) {
      expect(parseHistoryPageName(name)).toBeNull()
    }
    expect(parseOpenTabsName('device_a.history.1.zenpage')).toBeNull()
    expect(parseInboxName('device_a.tabs.zenpage')).toBeNull()
    expect(isDeviceFileName(historyPageName('device_a', 1))).toBe(false)
    expect(DOCUMENT_EXT).not.toBe(FILE_EXT)
  })

  it('serialises a document with its identity in the clear and parses back, refusing garbage', () => {
    const envelope = { v: 1 as const, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==' }
    const text = serializeDocument({
      kind: 'history',
      deviceId: 'device_a',
      deviceName: 'Desk',
      updatedAt: 5,
      envelope
    })
    expect(parseDocument(text)).toEqual({
      kind: 'history',
      deviceId: 'device_a',
      deviceName: 'Desk',
      updatedAt: 5,
      envelope
    })
    expect(parseDocument('{')).toBeNull()
    expect(parseDocument(JSON.stringify({ kind: 'mystery', deviceId: 'a', updatedAt: 1, envelope }))).toBeNull()
    expect(parseDocument(JSON.stringify({ kind: 'send-tab', deviceId: 'a', updatedAt: 1 }))).toBeNull()
    expect(
      parseDocument(JSON.stringify({ kind: 'open-tabs', deviceId: 'a', updatedAt: 1, envelope }))
    ).toMatchObject({ deviceName: 'a' })
  })
})

function tab(patch: Partial<Tab>): Tab {
  return {
    id: 'tab_1',
    spaceId: 'space_1',
    containerId: 'default',
    url: 'https://a.example/',
    title: 'A',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 1,
    lastActiveAt: 1,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    fromIntent: false,
    webApp: null,
    ...patch
  }
}

describe('the open-tabs record', () => {
  it('publishes web pages only, never a private tab, newest activity first, capped', () => {
    expect(isPublishedTab(tab({ containerId: PRIVATE_CONTAINER_ID }))).toBe(false)
    expect(isPublishedTab(tab({ url: 'zen://settings' }))).toBe(false)
    expect(isPublishedTab(tab({ url: 'about:blank' }))).toBe(false)
    expect(isPublishedTab(tab({ url: '' }))).toBe(false)
    expect(isPublishedTab(tab({ discarded: true }))).toBe(true)
    const doc = collectOpenTabs([
      tab({ id: 'old', url: 'https://old.example/', lastActiveAt: 10, title: '', customTitle: null }),
      tab({ id: 'new', url: 'https://new.example/', lastActiveAt: 20, customTitle: 'Mine', favicon: 'i', windowId: 'win_2' }),
      tab({ id: 'p', url: 'https://p.example/', containerId: PRIVATE_CONTAINER_ID, lastActiveAt: 30 })
    ])
    expect(doc).toEqual({
      v: 1,
      tabs: [
        { tabId: 'new', url: 'https://new.example/', title: 'Mine', favicon: 'i', lastActive: 20, windowId: 'win_2' },
        { tabId: 'old', url: 'https://old.example/', title: 'https://old.example/', favicon: null, lastActive: 10, windowId: null }
      ]
    })
    const many = Array.from({ length: OPEN_TABS_MAX + 5 }, (_, i) =>
      tab({ id: `t${i}`, url: `https://m.example/${i}`, lastActiveAt: i })
    )
    expect(collectOpenTabs(many).tabs).toHaveLength(OPEN_TABS_MAX)
    expect(collectOpenTabs(many).tabs[0].tabId).toBe(`t${OPEN_TABS_MAX + 4}`)
  })

  it('hashes the list so an unchanged one is not rewritten', () => {
    const a = collectOpenTabs([tab({})])
    const b = collectOpenTabs([tab({})])
    expect(openTabsHash(a)).toBe(openTabsHash(b))
    expect(openTabsHash(collectOpenTabs([tab({ lastActiveAt: 2 })]))).not.toBe(openTabsHash(a))
  })

  it('reads another device\'s list, dropping what cannot be opened', () => {
    expect(readOpenTabs(null)).toBeNull()
    expect(readOpenTabs({ v: 1 })).toBeNull()
    expect(
      readOpenTabs({
        v: 1,
        tabs: [
          { tabId: 't', url: 'https://a.example/', title: 'A', favicon: '', lastActive: 5, windowId: null },
          { url: 'https://b.example/' },
          { tabId: 'z', url: 'zen://settings', title: 'S', lastActive: 9 },
          'junk'
        ]
      })
    ).toEqual({
      v: 1,
      tabs: [
        { tabId: 't', url: 'https://a.example/', title: 'A', favicon: null, lastActive: 5, windowId: null },
        { tabId: 'https://b.example/', url: 'https://b.example/', title: 'https://b.example/', favicon: null, lastActive: 0, windowId: null }
      ]
    })
    const lists = sortDeviceTabs(
      [
        { deviceId: 'a', deviceName: 'A', updatedAt: 10, tabs: [] },
        { deviceId: 'b', deviceName: 'B', updatedAt: 20, tabs: [{ tabId: 't', url: 'https://x.example/', title: 'X', favicon: null, lastActive: 1, windowId: null }] },
        { deviceId: 'c', deviceName: 'C', updatedAt: 30, tabs: [{ tabId: 't', url: 'https://y.example/', title: 'Y', favicon: null, lastActive: 1, windowId: null }] },
        { deviceId: 'stale', deviceName: 'S', updatedAt: 1, tabs: [{ tabId: 't', url: 'https://z.example/', title: 'Z', favicon: null, lastActive: 1, windowId: null }] }
      ],
      40 * 86_400_000
    )
    expect(lists.map((d) => d.deviceId)).toEqual(['c', 'b'])
  })
})

describe('the send-tab record', () => {
  it('sends web pages only', () => {
    expect(isSendableUrl('https://a.example/path?q=1')).toBe(true)
    expect(isSendableUrl('http://a.example/')).toBe(true)
    expect(isSendableUrl('zen://settings')).toBe(false)
    expect(isSendableUrl('data:text/html,hi')).toBe(false)
    expect(isSendableUrl('https://a.example/with space')).toBe(false)
    expect(isSendableUrl('')).toBe(false)
  })

  it('reads a sent tab, refusing what cannot be opened and filling in an unknown sender', () => {
    expect(readSendTab(null)).toBeNull()
    expect(readSendTab({ v: 1, id: 's', url: 'zen://x' })).toBeNull()
    expect(readSendTab({ v: 1, url: 'https://a.example/' })).toBeNull()
    expect(readSendTab({ v: 1, id: 's', url: 'https://a.example/' })).toEqual({
      v: 1,
      id: 's',
      url: 'https://a.example/',
      title: '',
      at: 0,
      from: { id: '', name: 'another device' }
    })
    const doc = readSendTab({
      v: 1,
      id: 's',
      url: 'https://a.example/',
      title: 'T',
      at: 9,
      from: { id: 'device_a', name: 'Desk' }
    })!
    expect(doc.from).toEqual({ id: 'device_a', name: 'Desk' })
    expect(sendTabArrivedText(doc)).toBe('Tab from Desk')
  })
})

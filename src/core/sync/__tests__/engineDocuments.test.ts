import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import type { ImportedVisit } from '../../history'
import { SEND_TAB_NOT_A_PAGE_MESSAGE, SEND_TAB_UNKNOWN_DEVICE_MESSAGE } from '../engine'
import type { HistoryPage } from '../history'
import { HISTORY_PAGE_ENTRIES } from '../history'
import type { OpenTabsDocument } from '../openTabs'
import { historyPageName, inboxName, openTabsName } from '../documents'
import { device, documents, folderFiles, setup, teardown, type Device } from './harness'

/**
 * The documents beside the record set, two engines on one folder: the history stream (ID-13 /
 * HB-48), the open-tabs list (ID-28) and the inbox of sent tabs (ID-27).
 */

afterEach(teardown)

const T0 = Date.now() - 3 * 86_400_000

/** Every visit a device holds, oldest first, in the wire shape (the export, page by page). */
function visitsOf(d: Device): ImportedVisit[] {
  const out: ImportedVisit[] = []
  let cursor: string | null = null
  do {
    const page = d.browser.history.exportVisits({ since: 0, cursor })
    out.push(...page.visits)
    cursor = page.next
  } while (cursor !== null)
  return out
}
const urlsOf = (d: Device): string[] => visitsOf(d).map((v) => v.url)

/** The entries of every page a device wrote, in stream order. */
async function streamOf(d: Device): Promise<HistoryPage['entries']> {
  const pages = [...(await documents<HistoryPage>(d, 'history')).values()]
  pages.sort((a, b) => a.seq - b.seq)
  return pages.flatMap((p) => p.entries)
}

async function join(a: Device, b: Device, merge = true): Promise<void> {
  await setup(a)
  await setup(b)
  expect(b.engine.status().pendingMerge).toBe(true)
  await b.engine.confirmMerge(merge)
  expect(a.engine.status().lastError).toBeNull()
  expect(b.engine.status().lastError).toBeNull()
}

async function round(...ds: Device[]): Promise<void> {
  for (const d of ds) {
    await d.engine.syncNow()
    expect(d.engine.status().lastError).toBeNull()
  }
}

describe('the history stream', () => {
  it('a visit made on A appears on B with its title and transition, once, however often it is retried', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    a.browser.history.visit('https://a.example/one', 'One', 'https://a.example/icon.png', {
      at: T0
    })
    a.browser.history.visit('https://a.example/two', 'Two', null, {
      at: T0 + 1000,
      transition: 'typed'
    })
    await join(a, b)
    // B took A's backlog in at the merge; the export is the import unchanged.
    expect(visitsOf(b)).toEqual([
      {
        url: 'https://a.example/one',
        title: 'One',
        at: T0,
        transition: 'link',
        favicon: 'https://a.example/icon.png'
      },
      { url: 'https://a.example/two', title: 'Two', at: T0 + 1000, transition: 'typed' }
    ])
    expect(b.browser.history.recent(10).find((e) => e.url === 'https://a.example/two')).toMatchObject({
      typedCount: 1,
      visitCount: 1
    })
    // Retries change nothing: the `(url, at)` dedupe.
    await round(a, b, a, b)
    expect(visitsOf(b)).toHaveLength(2)
    // What B applied is not re-published as B's own: B's stream is empty.
    expect(await streamOf(b)).toEqual([])
    // Nothing in the folder is readable without the key.
    for (const text of folderFiles('/drive').values()) expect(text).not.toContain('a.example')

    // Live: a visit on A after the join reaches B on the next round; one on B reaches A.
    a.browser.history.visit('https://a.example/three', 'Three', null, { at: T0 + 2000 })
    b.browser.history.visit('https://b.example/', 'B', null, { at: T0 + 3000 })
    await round(a, b, a)
    expect(urlsOf(b)).toEqual([
      'https://a.example/one',
      'https://a.example/two',
      'https://a.example/three',
      'https://b.example/'
    ])
    expect(urlsOf(a)).toEqual(urlsOf(b))
  }, 30_000)

  it('a visit deleted on A disappears on B, by key, by range and by clear, without an echo', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    for (let i = 0; i < 6; i += 1)
      a.browser.history.visit(`https://a.example/${i}`, `Page ${i}`, null, { at: T0 + i * 60_000 })
    b.browser.history.visit('https://b.example/own', 'Own', null, { at: T0 + 10 * 60_000 })
    await join(a, b)
    await round(a)
    expect(urlsOf(b)).toHaveLength(7)
    expect(urlsOf(a)).toHaveLength(7)

    // By key: the history page's "remove" of one visit.
    a.browser.history.deleteUrls(['https://a.example/2'])
    await round(a, b)
    expect(urlsOf(b)).not.toContain('https://a.example/2')
    expect(urlsOf(b)).toHaveLength(6)
    // The tombstone is A's; B applied it and published nothing (the echo guard).
    const aStream = await streamOf(a)
    expect(aStream.filter((e) => e.type === 'removed')).toEqual([
      { type: 'removed', at: expect.any(Number), keys: [{ url: 'https://a.example/2', at: T0 + 120_000 }] }
    ])
    expect((await streamOf(b)).filter((e) => e.type !== 'visit')).toEqual([])

    // By range: Clear browsing data's "last hour" on A takes B's visit in the window too.
    a.browser.history.deleteRange(T0 + 3 * 60_000, T0 + 5 * 60_000)
    await round(a, b)
    expect(urlsOf(b)).toEqual([
      'https://a.example/0',
      'https://a.example/1',
      'https://a.example/5',
      'https://b.example/own'
    ])
    expect(urlsOf(a)).toEqual(urlsOf(b))

    // A visit deleted on B disappears on A too (the stream goes both ways).
    b.browser.history.deleteByKeys([{ url: 'https://a.example/5', at: T0 + 5 * 60_000 }])
    await round(b, a)
    expect(urlsOf(a)).not.toContain('https://a.example/5')
    expect(urlsOf(a)).toEqual(urlsOf(b))

    // Clear on A: everything up to that moment goes on B, including B's own visits.
    a.browser.history.clear()
    await round(a, b)
    expect(urlsOf(b)).toEqual([])
    expect(urlsOf(a)).toEqual([])
    // ...but a visit B makes afterwards stays, and A gets it.
    b.browser.history.visit('https://b.example/after', 'After', null)
    await round(b, a)
    expect(urlsOf(a)).toEqual(['https://b.example/after'])
  }, 30_000)

  it('a deleted visit never comes back from a third device that still carries it', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const c = device('Laptop')
    a.browser.history.visit('https://a.example/x', 'X', null, { at: T0 })
    a.browser.history.visit('https://a.example/y', 'Y', null, { at: T0 + 1000 })
    await join(a, b)
    expect(urlsOf(b)).toEqual(['https://a.example/x', 'https://a.example/y'])
    // B deletes X; A applies the tombstone.
    b.browser.history.deleteUrls(['https://a.example/x'])
    await round(b, a)
    expect(urlsOf(a)).toEqual(['https://a.example/y'])
    // C joins and reads both streams: A's page still holds X's visit, B's the tombstone.
    await setup(c)
    await c.engine.confirmMerge(true)
    await round(c)
    expect(urlsOf(c)).toEqual(['https://a.example/y'])
    // A's own stream, read again by a device that forgot its cursor, does not undo the delete.
    await round(a, b, c)
    expect(urlsOf(a)).toEqual(['https://a.example/y'])
    expect(urlsOf(b)).toEqual(['https://a.example/y'])
  }, 30_000)

  it('resumes from its cursor after a restart instead of reading the stream again', async () => {
    const a = device('Desk (Linux)')
    let b = device('Pixel 9')
    for (let i = 0; i < 3; i += 1)
      a.browser.history.visit(`https://a.example/${i}`, `Page ${i}`, null, { at: T0 + i * 1000 })
    await join(a, b)
    expect(urlsOf(b)).toHaveLength(3)
    const aId = a.engine.status().deviceId
    b.engine.flushSync()
    b.browser.history.flushSync()
    const persisted = JSON.parse(b.io.files['sync.json']) as {
      history: { cursors: Record<string, { seq: number; index: number }> }
    }
    expect(persisted.history.cursors[aId]).toMatchObject({ seq: 0, index: 3 })

    // B restarts on the same files: the engine reconnects, the cursor stands.
    let applied = 0
    const bIo = b.io
    b.engine.disconnect(false)
    // (the disconnect wrote its own state: put the connected one back, as a crash would leave it)
    bIo.files['sync.json'] = JSON.stringify(persisted)
    b = device('Pixel 9', { io: bIo })
    const importVisits = b.browser.history.importVisits.bind(b.browser.history)
    b.browser.history.importVisits = (visits, opts) => {
      applied += visits.length
      return importVisits(visits, opts)
    }
    expect(b.engine.status().enabled).toBe(true)
    a.browser.history.visit('https://a.example/3', 'Page 3', null, { at: T0 + 3000 })
    await round(a, b)
    // Only the new visit crossed; the three before were not imported again.
    expect(applied).toBe(1)
    expect(urlsOf(b)).toHaveLength(4)
  }, 30_000)

  it('a device with History off neither publishes nor takes visits in, and catches up when it is on again', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await join(a, b)
    b.engine.setScope({ history: false })
    a.browser.history.visit('https://a.example/while-off', 'Off', null, { at: T0 })
    b.browser.history.visit('https://b.example/while-off', 'Off', null, { at: T0 + 1000 })
    await round(a, b, a)
    expect(urlsOf(b)).toEqual(['https://b.example/while-off'])
    expect(urlsOf(a)).toEqual(['https://a.example/while-off'])
    expect(await streamOf(b)).toEqual([])

    // On again: B's backlog goes out, and A's stream is read from where B left it.
    b.engine.setScope({ history: true })
    await round(b, a)
    expect(urlsOf(b)).toEqual(['https://a.example/while-off', 'https://b.example/while-off'])
    expect(urlsOf(a)).toEqual(urlsOf(b))
  }, 30_000)

  it('"keep this device\'s data" skips what the others published so far and follows them from here', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    a.browser.history.visit('https://a.example/before', 'Before', null, { at: T0 })
    b.browser.history.visit('https://b.example/mine', 'Mine', null, { at: T0 + 1000 })
    await join(a, b, false)
    expect(urlsOf(b)).toEqual(['https://b.example/mine'])
    a.browser.history.visit('https://a.example/after', 'After', null, { at: T0 + 2000 })
    await round(a, b, a)
    expect(urlsOf(b)).toEqual(['https://b.example/mine', 'https://a.example/after'])
    // A's history is untouched by B's decision, and B's visit reached it.
    expect(urlsOf(a)).toEqual([
      'https://a.example/before',
      'https://b.example/mine',
      'https://a.example/after'
    ])
  }, 30_000)

  it('writes a backlog as pages of 500, sealed as they fill, and a reader takes every page', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const visits: ImportedVisit[] = []
    for (let i = 0; i < 1_150; i += 1)
      visits.push({ url: `https://a.example/p/${i}`, title: `P ${i}`, at: T0 + i * 1000 })
    expect(a.browser.history.importVisits(visits, { source: 'test' }).imported).toBe(1_150)
    await join(a, b)
    const pages = await documents<HistoryPage>(a, 'history')
    const aId = a.engine.status().deviceId
    expect([...pages.keys()].sort()).toEqual([
      historyPageName(aId, 0),
      historyPageName(aId, 1),
      historyPageName(aId, 2)
    ])
    expect(pages.get(historyPageName(aId, 0))).toMatchObject({ seq: 0, sealed: true })
    expect(pages.get(historyPageName(aId, 0))!.entries).toHaveLength(HISTORY_PAGE_ENTRIES)
    expect(pages.get(historyPageName(aId, 2))).toMatchObject({ seq: 2, sealed: false })
    expect(pages.get(historyPageName(aId, 2))!.entries).toHaveLength(150)
    expect(visitsOf(b)).toHaveLength(1_150)
    // The open page grows in place; a new visit lands on B without the sealed pages re-read.
    a.browser.history.visit('https://a.example/live', 'Live', null, { at: T0 + 2_000_000 })
    await round(a, b)
    expect((await documents<HistoryPage>(a, 'history')).get(historyPageName(aId, 2))!.entries).toHaveLength(151)
    expect(visitsOf(b)).toHaveLength(1_151)
  }, 60_000)
})

describe('tabs from other devices', () => {
  it('publishes the open tabs under the Open tabs toggle, the private ones never, and the others list them', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    a.engine.setScope({ openTabs: true })
    b.engine.setScope({ openTabs: true })
    const win = a.browser.ensureWindow()
    const one = a.browser.tabs.createTab({ url: 'https://a.example/one', active: true }, win)
    a.browser.tabs.createTab({ url: 'https://a.example/two' }, win)
    a.browser.tabs.createTab({ url: 'https://secret.example/', containerId: PRIVATE_CONTAINER_ID }, win)
    await join(a, b)
    const aId = a.engine.status().deviceId
    const doc = (await documents<OpenTabsDocument>(a, 'open-tabs')).get(openTabsName(aId))
    expect(doc).toBeDefined()
    expect(doc!.tabs.map((t) => t.url)).toEqual(
      expect.arrayContaining(['https://a.example/one', 'https://a.example/two'])
    )
    expect(doc!.tabs.some((t) => t.url.includes('secret'))).toBe(false)
    expect(doc!.tabs.every((t) => !t.url.startsWith('zen://'))).toBe(true)
    expect(doc!.tabs.find((t) => t.url === 'https://a.example/one')).toMatchObject({
      tabId: one.id,
      windowId: null
    })

    const lists = b.engine.tabsFromDevices()
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ deviceId: aId, deviceName: 'Desk (Linux)' })
    expect(lists[0].tabs.map((t) => t.url)).toEqual(
      expect.arrayContaining(['https://a.example/one', 'https://a.example/two'])
    )
    const version = b.engine.status().remoteTabsVersion
    expect(version).toBeGreaterThan(0)

    // A closes a tab: the list follows on the next rounds; the version moves once it did.
    a.browser.tabs.closeTab(one.id, false, win)
    await round(a, b)
    expect(b.engine.tabsFromDevices()[0].tabs.map((t) => t.url)).not.toContain('https://a.example/one')
    expect(b.engine.status().remoteTabsVersion).toBeGreaterThan(version)

    // With the toggle off on B, B shows none; off on A, A's document goes.
    b.engine.setScope({ openTabs: false })
    expect(b.engine.tabsFromDevices()).toEqual([])
    a.engine.setScope({ openTabs: false })
    await round(a)
    expect(folderFiles('/drive').has(openTabsName(aId))).toBe(false)
  }, 30_000)
})

describe('send to your devices', () => {
  it('a tab sent from A opens on B once, with a toast, and is consumed', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await join(a, b)
    await round(a)
    const bId = b.engine.status().deviceId
    expect(a.engine.status().devices.map((d) => d.id)).toEqual([bId])

    await a.engine.sendTab(
      { deviceId: bId, url: 'https://sent.example/article', title: 'An article' },
      a.win
    )
    expect(a.toasts.at(-1)).toBe('Sent to Pixel 9')
    const inbox = [...folderFiles('/drive').keys()].filter((n) => n.includes('.inbox.'))
    expect(inbox).toHaveLength(1)
    expect(inbox[0].startsWith(bId)).toBe(true)
    for (const text of folderFiles('/drive').values()) expect(text).not.toContain('sent.example')

    const before = Object.keys(b.browser.state.model.tabs).length
    const toast = vi.spyOn(b.browser, 'toast')
    const inboxText = folderFiles('/drive').get(inbox[0])!
    await round(b)
    const opened = Object.values(b.browser.state.model.tabs).filter(
      (t) => t.url === 'https://sent.example/article'
    )
    expect(opened).toHaveLength(1)
    expect(Object.keys(b.browser.state.model.tabs).length).toBe(before + 1)
    expect(toast).toHaveBeenCalledWith('Tab from Desk (Linux)', 'info', expect.anything())
    // Consumed: the file is gone, and a copy a cloud drive brings back is not opened again.
    expect([...folderFiles('/drive').keys()].some((n) => n.includes('.inbox.'))).toBe(false)
    const [sendId] = inbox[0].split('.inbox.')[1].split('.zenpage')
    folderFiles('/drive').set(inbox[0], inboxText)
    await round(b)
    expect(
      Object.values(b.browser.state.model.tabs).filter((t) => t.url === 'https://sent.example/article')
    ).toHaveLength(1)
    expect(folderFiles('/drive').has(inboxName(bId, sendId))).toBe(false)

    // A page that is not a web page, or a device not in the folder, is refused with a toast.
    await a.engine.sendTab({ deviceId: bId, url: 'zen://settings' }, a.win)
    expect(a.toasts.at(-1)).toBe(SEND_TAB_NOT_A_PAGE_MESSAGE)
    await a.engine.sendTab({ deviceId: 'device_nobody', url: 'https://x.example/' }, a.win)
    expect(a.toasts.at(-1)).toBe(SEND_TAB_UNKNOWN_DEVICE_MESSAGE)
  }, 30_000)

  it('on a host with its own shade (Android) the tab is posted as a notification and opens on the tap', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9', { notifications: true })
    await join(a, b)
    await round(a)
    const bId = b.engine.status().deviceId
    await a.engine.sendTab({ deviceId: bId, url: 'https://sent.example/', title: 'Sent' }, a.win)
    const before = Object.keys(b.browser.state.model.tabs).length
    await round(b)
    // Nothing opened yet: the notification is the arrival.
    expect(Object.keys(b.browser.state.model.tabs).length).toBe(before)
    expect(b.notifications).toHaveLength(1)
    expect(b.notifications[0]).toMatchObject({
      channel: 'sharing',
      title: 'Tab from Desk (Linux)',
      body: 'Sent',
      url: 'https://sent.example/',
      origin: 'https://sent.example'
    })
    // The tap comes back as the host's click with the URL: the page opens as a tab.
    b.browser.webNotifications.onHostEvent(
      b.notifications[0].id as string,
      'click',
      'https://sent.example/'
    )
    expect(
      Object.values(b.browser.state.model.tabs).filter((t) => t.url === 'https://sent.example/')
    ).toHaveLength(1)
  }, 30_000)
})

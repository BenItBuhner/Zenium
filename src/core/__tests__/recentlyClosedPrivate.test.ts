import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../../shared/types'
import type { ClosedTabEntry } from '../../shared/types'
import { createTabRecord } from '../model'
import { ANDROID, DESKTOP, allItems, deepItem, harness, labels, type Harness } from './menusFixture'

/**
 * INC-10: "Recently closed" never lists a private tab. There is ONE list – `BrowserState.
 * recentlyClosed`, fed by `SessionService.pushTab` / `pushWindow` from `TabService.
 * captureClosed` – and every surface that shows recently closed tabs reads it and nothing else:
 * the phone overview's Recently closed row and sheet, the phone History panel, the overview
 * search's reach and the History page through the `session.recentlyClosed` command
 * (`historyAdapter.recentlyClosed`); the new tab page's magic stack and the tablet's tab search
 * through `UIState.recentlyClosed`; the tab strip's "Reopen Closed Tab" and the app menu's
 * History block through `session.recentlyClosed()` / `summaries()`; Ctrl+Shift+T through
 * `reopenClosed`; the inactive-tabs archive through the same capture. So the fact is pinned
 * where it is decided, once per reader: a private tab closed – alone, by "Close private tabs",
 * as part of the archive pass, or as a private window – leaves no entry anywhere, while a
 * regular tab closed beside it does (so the assertions are not vacuous).
 */

const PRIVATE_URL = 'https://private.example/secret'
const REGULAR_URL = 'https://regular.example/page'

/** The Android shape: one window, private tabs beside the regular ones in the space's track. */
function phone(): Harness {
  return harness(ANDROID, 'phone')
}

/** A private tab on a page (the core refuses the request on a host without private tabs). */
function openPrivate(h: Harness, url = PRIVATE_URL): string {
  const id = h.browser.tabs.newPrivateTab(url, h.win)
  if (!id) throw new Error('no private tab')
  expect(h.browser.tabs.tab(id)?.containerId).toBe(PRIVATE_CONTAINER_ID)
  return id
}

/** The `session.recentlyClosed` command's answer – what every phone surface renders – as URLs. */
function commandUrls(h: Harness): Array<string | null> {
  const summaries = h.browser.handleCommand(h.win, 'session.recentlyClosed', undefined) as Array<{
    url: string | null
  }>
  return summaries.map((s) => s.url)
}

describe('Recently closed never lists private tabs (INC-10)', () => {
  it('a private tab closed leaves no entry in the list, the command, the UI state or Ctrl+Shift+T; a regular tab closed beside it does', () => {
    const h = phone()
    const regular = h.browser.tabs.createTab({ url: REGULAR_URL, active: true }, h.win).id
    const priv = openPrivate(h)

    h.browser.tabs.closeTab(priv, false, h.win)
    expect(h.browser.tabs.tab(priv)).toBeUndefined()
    // The model's list, the service's two reads, the command the phone surfaces call.
    expect(h.browser.state.recentlyClosed).toEqual([])
    expect(h.browser.session.recentlyClosed()).toEqual([])
    expect(h.browser.session.summaries()).toEqual([])
    expect(commandUrls(h)).toEqual([])
    // `UIState.recentlyClosed` (the new tab page's magic stack, the tablet's tab search) and its count.
    const ui = h.browser.state.snapshot(h.win)
    expect(ui.recentlyClosed).toEqual([])
    expect(ui.recentlyClosedCount).toBe(0)
    // Ctrl+Shift+T brings nothing back: no tab on the private page reappears.
    h.browser.tabs.reopenClosed(h.win)
    expect(Object.values(h.browser.state.model.tabs).map((t) => t.url)).not.toContain(PRIVATE_URL)

    // The same list, a regular tab closed: it is there, and the private one still is not.
    h.browser.tabs.closeTab(regular, false, h.win)
    expect(commandUrls(h)).toEqual([REGULAR_URL])
    const after = h.browser.state.snapshot(h.win)
    expect(after.recentlyClosed.map((e) => e.url)).toEqual([REGULAR_URL])
    expect(after.recentlyClosedCount).toBe(1)
    for (const entry of h.browser.state.recentlyClosed) {
      if (entry.kind === 'tab') expect(entry.tab.containerId).not.toBe(PRIVATE_CONTAINER_ID)
    }
  })

  it('the tab strip\u2019s "Reopen Closed Tab" stays greyed after a private close and lights after a regular one', () => {
    const h = phone()
    const regular = h.browser.tabs.createTab({ url: REGULAR_URL, active: true }, h.win).id
    const other = h.browser.tabs.createTab(
      { url: 'https://other.example/', active: true },
      h.win
    ).id
    const priv = openPrivate(h)

    h.browser.tabs.closeTab(priv, false, h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: regular })
    expect(deepItem(h.shown(), 'Reopen Closed Tab').enabled).toBe(false)

    h.browser.tabs.closeTab(other, false, h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: regular })
    expect(deepItem(h.shown(), 'Reopen Closed Tab').enabled).toBe(true)
  })

  it('the app menu\u2019s History block shows §9.17\u2019s sentence after a private close, and never a private page\u2019s title', () => {
    const h = harness(DESKTOP)
    const win = h.browser.createWindow({ kind: 'private', from: h.win })
    if (!win) throw new Error('no private window')
    const priv = h.browser.tabs.createTab({ url: PRIVATE_URL, active: true }, win).id
    const tab = h.browser.tabs.tab(priv)
    if (!tab) throw new Error('no tab')
    tab.title = 'The private page'
    expect(h.browser.tabs.isPrivate(tab)).toBe(true)

    h.browser.tabs.closeTab(priv, false, win)
    h.browser.handleCommand(h.win, 'app.menu', {})
    const items = labels(h.shown())
    expect(items).toContain('History > No recently closed tabs')
    expect(items.some((l) => l.includes('The private page'))).toBe(false)
    expect(allItems(h.shown()).some((i) => i.label === 'Recently Closed')).toBe(false)
  })

  it('"Close private tabs" (the private session\u2019s end) files none of them', () => {
    const h = phone()
    h.browser.tabs.createTab({ url: REGULAR_URL, active: true }, h.win)
    openPrivate(h, 'https://one.example/')
    openPrivate(h, 'https://two.example/')
    expect(h.browser.tabs.privateTabs()).toHaveLength(2)

    h.browser.tabs.closePrivateTabs(h.win)
    expect(h.browser.tabs.privateTabs()).toHaveLength(0)
    expect(commandUrls(h)).toEqual([])
    expect(h.browser.state.snapshot(h.win).recentlyClosedCount).toBe(0)
  })

  it('the inactive-tabs archive gets nothing from a private tab: the close produces no entry to divert', () => {
    const h = phone()
    h.browser.tabs.createTab({ url: REGULAR_URL, active: true }, h.win)
    const priv = openPrivate(h)

    expect(h.browser.tabs.archiveTab(priv, h.win)).toBeNull()
    expect(h.browser.tabs.tab(priv)).toBeUndefined()
    expect(h.browser.inactiveTabs.list()).toEqual([])
    expect(h.browser.state.archivedTabs).toEqual([])
    expect(commandUrls(h)).toEqual([])
  })

  it('a closed-tab entry of the private container handed to the session directly is refused too', () => {
    const h = phone()
    const entry: ClosedTabEntry = {
      kind: 'tab',
      id: 'closed_private',
      closedAt: 1,
      tab: createTabRecord({
        id: 'p',
        url: PRIVATE_URL,
        spaceId: h.win.activeSpaceId,
        containerId: PRIVATE_CONTAINER_ID
      }),
      spaceId: h.win.activeSpaceId,
      folderId: null,
      index: 0,
      windowId: h.win.id,
      navigation: null
    }
    h.browser.session.pushTab(entry)
    expect(h.browser.session.recentlyClosed()).toEqual([])
    // The regular twin goes in, so the refusal is the container's and not the shape's.
    h.browser.session.pushTab({
      ...entry,
      id: 'closed_regular',
      tab: createTabRecord({
        id: 'r',
        url: REGULAR_URL,
        spaceId: h.win.activeSpaceId,
        containerId: DEFAULT_CONTAINER_ID
      })
    })
    expect(h.browser.session.summaries().map((e) => e.url)).toEqual([REGULAR_URL])
  })

  it('a private window closed with its pages leaves no window entry (the desktop shape)', () => {
    const h = harness(DESKTOP)
    const win = h.browser.createWindow({ kind: 'private', from: h.win })
    if (!win) throw new Error('no private window')
    h.browser.tabs.createTab({ url: PRIVATE_URL, active: true }, win)
    h.browser.tabs.createTab({ url: 'https://more.example/', active: true }, win)

    h.browser.onWindowClosing(win)
    h.browser.onWindowClosed(win)
    expect(h.browser.session.recentlyClosed()).toEqual([])
    expect(commandUrls(h)).toEqual([])

    // A regular window closed the same way is one window entry: the refusal is the kind's.
    const second = h.browser.openWindow('unsynced', h.win)
    if (!second) throw new Error('no second window')
    h.browser.tabs.createTab({ url: REGULAR_URL, active: true }, second)
    h.browser.onWindowClosing(second)
    h.browser.onWindowClosed(second)
    expect(h.browser.session.summaries().map((e) => [e.kind, e.url])).toEqual([
      ['window', REGULAR_URL]
    ])
  })
})

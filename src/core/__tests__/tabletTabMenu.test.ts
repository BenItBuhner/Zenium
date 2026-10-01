import { describe, expect, it, vi } from 'vitest'
import { ANDROID, DESKTOP, deepItem, labels, pageHarness } from './menusFixture'

/**
 * TABLET-05's menu clause (Chrome Android 152's strip tab menu, `TabContextMenuCoordinator.java`
 * l.678-729 at `152.0.7977.89`; the row's five: Close, Close others, New tab to the right, Add
 * to group, Move to window – and Reopen closed tab, which Chrome seats in the strip's empty-space
 * menu, `TabStripContextMenuCoordinator.java` l.203-232). The tablet's row opens ONE menu from a right-click
 * and from a released long-press alike (`TabItem.tsx`'s `contextmenu`, `useTabTouch.ts` →
 * `tab.contextMenu`): `showTabContextMenu`. These pins hold that menu to Chrome's rows the
 * tablet can honour, worded for a strip that runs DOWN (Chrome's own "New tab below" / "Close
 * tabs below" in its vertical layout), and keep the window moves out where the host has no
 * windows (`capabilities.windows`), the reason the row's "Move to window" stays a desktop row.
 */
describe("TABLET-05: the tablet's tab menu carries Chrome's strip rows", () => {
  function tablet(): ReturnType<typeof pageHarness> {
    const h = pageHarness(ANDROID, { formFactor: 'tablet' })
    // A second tab below the first, so the scoped closes have something to close.
    h.browser.tabs.createTab({ url: 'https://example.org/second', active: false }, h.win)
    return h
  }

  it("offers Close, Close other tabs and the two directed closes under Chrome's own words for a strip that runs down", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const menu = labels(h.shown())
    expect(menu).toContain('Close Tab')
    expect(menu).toEqual(
      expect.arrayContaining([
        'Close Multiple Tabs > Close Tabs Above',
        'Close Multiple Tabs > Close Tabs Below',
        'Close Multiple Tabs > Close Other Tabs'
      ])
    )
    // The sidebar runs down: no "to the Right" on the tablet, Chrome's vertical wording.
    expect(menu.some((l) => l.includes('to the Right') || l.includes('to the Left'))).toBe(false)
    // The row is the first of two: below it a tab to close, above it none (greyed, not gone).
    expect(deepItem(h.shown(), 'Close Tabs Below').enabled).toBe(true)
    expect(deepItem(h.shown(), 'Close Other Tabs').enabled).toBe(true)
    expect(deepItem(h.shown(), 'Close Tabs Above').enabled).toBe(false)
  })

  it("Close Other Tabs closes nothing itself on the tablet: it emits tab.closeOthersUndoable with the tabs the core's rule closes, for the chrome's close-with-undo (§9.23, OS-40 part B)", () => {
    const h = tablet()
    const other = h.win.activeSpace().tabIds.find((id) => id !== h.tabId)!
    const emit = vi.spyOn(h.browser, 'emit')
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    deepItem(h.shown(), 'Close Other Tabs').click?.()
    expect(emit.mock.calls.map(([name, payload]) => [name, payload])).toEqual([
      ['tab.closeOthersUndoable', { tabId: h.tabId, tabIds: [other] }]
    ])
    expect(h.browser.tabs.tab(other)).toBeDefined()
    // The chrome answers with the core's own close, once its undo is armed.
    h.browser.handleCommand(h.win, 'tab.closeOthers', { tabId: h.tabId })
    expect(h.browser.tabs.tab(other)).toBeUndefined()
    expect(h.browser.tabs.tab(h.tabId)).toBeDefined()
  })

  it("the desktop's Close Other Tabs closes them in the core itself and emits nothing (its path is as it was)", () => {
    const h = pageHarness(DESKTOP)
    h.browser.tabs.createTab({ url: 'https://example.org/second', active: false }, h.win)
    const other = h.win.activeSpace().tabIds.find((id) => id !== h.tabId)!
    const emit = vi.spyOn(h.browser, 'emit')
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    deepItem(h.shown(), 'Close Other Tabs').click?.()
    expect(h.browser.tabs.tab(other)).toBeUndefined()
    expect(emit.mock.calls.map(([name]) => name)).not.toContain('tab.closeOthersUndoable')
  })

  it('opens a new tab below the row (Chrome\'s "New tab below" for a vertical strip)', () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const row = deepItem(h.shown(), 'New Tab Below')
    expect(row.enabled).toBe(true)
    const order = (): string[] => [...h.win.activeSpace().tabIds]
    const before = order()
    row.click?.()
    const after = order()
    expect(after).toHaveLength(before.length + 1)
    // Straight under the row it was asked from: the new id is the one right after it.
    const at = after.indexOf(h.tabId)
    expect(at).toBe(before.indexOf(h.tabId))
    expect(before).not.toContain(after[at + 1])
  })

  it("adds the tab to a group – Zenium's folder – from Move Tab: a new folder while the space has none, the space's folders once it has", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(labels(h.shown())).toContain('Move Tab > Add Tab to New Folder')
    deepItem(h.shown(), 'Add Tab to New Folder').click?.()
    const folder = Object.values(h.browser.state.model.folders)[0]
    expect(folder).toBeDefined()
    expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(folder!.id)
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const menu = labels(h.shown())
    expect(menu).toContain('Move Tab > Move to Folder')
    expect(menu).toContain('Move Tab > Remove from Folder')
    expect(menu).not.toContain('Move Tab > Add Tab to New Folder')
  })

  it("keeps Chrome's window moves out where the host has no windows (capabilities.windows), and in on a host that has", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const menu = labels(h.shown())
    expect(menu.some((l) => l.includes('Window'))).toBe(false)
    const desktop = pageHarness(DESKTOP)
    desktop.browser.menus.showTabContextMenu(desktop.tabId, desktop.win)
    expect(labels(desktop.shown())).toEqual(
      expect.arrayContaining([
        'Move Tab > Move Tab to New Window',
        'Move Tab > Move Tab to Another Window'
      ])
    )
  })

  it("carries Reopen Closed Tab from a row's menu, last in it – greyed with nothing closed, live once a tab has gone", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const before = h.shown()
    expect(labels(before)[labels(before).length - 1]).toBe('Reopen Closed Tab')
    expect(deepItem(before, 'Reopen Closed Tab').enabled).toBe(false)
    const other = h.win.activeSpace().tabIds.find((id) => id !== h.tabId)!
    h.browser.tabs.closeTab(other, false, h.win)
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(deepItem(h.shown(), 'Reopen Closed Tab').enabled).toBe(true)
  })

  it("has Chrome's other strip rows too: Share, Duplicate, Pin, Mute site", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const menu = labels(h.shown())
    expect(menu).toEqual(
      expect.arrayContaining(['Share', 'Share > Share…', 'Duplicate Tab', 'Pin Tab', 'Mute Site'])
    )
  })

  it("opens the same menu through the row's command (`useTabTouch.ts` → `tab.contextMenu` → `showTabContextMenu`)", () => {
    const h = tablet()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const direct = labels(h.shown())
    const popups = h.popups()
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
    // The command must pop a menu of its own before its rows are compared (a silent reroute
    // would leave the direct call's popup as the last one shown).
    expect(h.popups()).toBe(popups + 1)
    expect(labels(h.shown())).toEqual(direct)
    expect(direct[direct.length - 1]).toBe('Reopen Closed Tab')
  })
})

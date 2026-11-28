import { describe, expect, it } from 'vitest'
import type { FormFactor } from '../../shared/types'
import { NEW_FOLDER_NAME } from '../../shared/formFactor'
import { ANDROID, DESKTOP, deepItem, labels, pageHarness, pageParams } from './menusFixture'

/**
 * One word on every host: a folder made with no name of its own is "New Folder", and the rows
 * that make one say Folder – the link menu's "Open Link in New Tab in Folder" (a touch row), the
 * tab menu's "Add Tab to New Folder" and "Move to Folder ▸ New Folder…", the tab strip's
 * empty-space menu's "New Folder", and the selection menu's "New Folder…".
 */
describe('one folder word on every host: "New Folder", never "Group"', () => {
  const LINK = 'https://linked.test/'
  type H = ReturnType<typeof pageHarness>

  function on(formFactor: FormFactor): H {
    return pageHarness(formFactor === 'desktop' ? DESKTOP : ANDROID, { formFactor })
  }
  function folders(h: H): Array<{ id: string; name: string }> {
    return Object.values(h.browser.state.model.folders)
  }
  function newest(h: H, before: string[]): { id: string; name: string } {
    const made = folders(h).filter((f) => !before.includes(f.id))
    expect(made).toHaveLength(1)
    return made[0]!
  }

  it('the link menu’s Open Link in New Tab in Folder names the folder "New Folder" on the phone and on the tablet – the row is a touch host’s alone', () => {
    for (const layout of ['phone', 'tablet'] as const) {
      const h = on(layout)
      const before = folders(h).map((f) => f.id)
      h.menu(pageParams({ linkURL: LINK, linkText: 'Linked' }))
      h.click('Open Link in New Tab in Folder')
      expect(newest(h, before).name).toBe(NEW_FOLDER_NAME)
    }
    const d = on('desktop')
    expect(d.menu(pageParams({ linkURL: LINK, linkText: 'Linked' }))).not.toContain(
      'Open Link in New Tab in Folder'
    )
  })

  it('the tab menu’s Add Tab to New Folder says Folder and names it "New Folder" on every host', () => {
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const h = on(layout)
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      expect(labels(h.shown())).toContain('Move Tab > Add Tab to New Folder')
      deepItem(h.shown(), 'Add Tab to New Folder').click?.()
      const made = newest(h, before)
      expect(made.name).toBe(NEW_FOLDER_NAME)
      expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(made.id)
    }
  })

  it('Move to Folder ▸ New Folder… (the space already holding a folder) on every host', () => {
    for (const layout of ['tablet', 'desktop'] as const) {
      const h = on(layout)
      h.browser.createFolder(h.win.activeSpaceId, 'Research', '📁', h.win, { rename: false })
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      expect(labels(h.shown())).toContain('Move Tab > Move to Folder')
      deepItem(h.shown(), 'New Folder…').click?.()
      expect(newest(h, before).name).toBe(NEW_FOLDER_NAME)
    }
  })

  it('the tab strip’s empty-space menu and the selection menu say Folder on every host', () => {
    for (const layout of ['tablet', 'phone', 'desktop'] as const) {
      const h = on(layout)
      let before = folders(h).map((f) => f.id)
      h.browser.menus.showNewTabContextMenu(h.win, {})
      const strip = labels(h.shown())
      expect(strip.filter((l) => /Folder|Group/.test(l))).toEqual([
        'New Folder',
        'New Live Folder…'
      ])
      deepItem(h.shown(), 'New Folder').click?.()
      expect(newest(h, before).name).toBe(NEW_FOLDER_NAME)

      const second = h.browser.tabs.createTab({ url: 'https://second.test/', active: false }, h.win)
      before = folders(h).map((f) => f.id)
      h.browser.menus.showSelectionContextMenu([h.tabId, second.id], h.win)
      const selection = labels(h.shown())
      expect(selection).toContain('Add 2 Tabs to Folder > New Folder…')
      expect(selection.filter((l) => /Group/.test(l))).toEqual([])
      deepItem(h.shown(), 'New Folder…').click?.()
      const made = newest(h, before)
      expect(made.name).toBe(NEW_FOLDER_NAME)
      expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(made.id)
      expect(h.browser.tabs.tab(second.id)?.folderId).toBe(made.id)
    }
  })

  it('a caller with no window names it "New Folder" too', () => {
    const h = on('phone')
    const before = folders(h).map((f) => f.id)
    h.browser.newFolderWithTab(h.win.activeSpaceId, h.tabId)
    expect(newest(h, before).name).toBe(NEW_FOLDER_NAME)
  })
})

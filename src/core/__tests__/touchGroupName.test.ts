import { describe, expect, it } from 'vitest'
import type { FormFactor } from '../../shared/types'
import { NEW_FOLDER_NAME, NEW_GROUP_NAME } from '../../shared/formFactor'
import { ANDROID, DESKTOP, deepItem, labels, pageHarness, pageParams } from './menusFixture'

/**
 * The name a group made with no name of its own gets, by host (§6: the desktop says Folder, the
 * touch hosts say Group – a group a touch host makes is named "Group", never "New Folder"). Every
 * path of the core that names a new group by default takes the host's noun from the window's
 * form factor (`newFolderName`): the link menu's "Open Link in New Tab in Group" (a touch row),
 * the tab menu's "Add Tab to New Folder" and "Move to Folder ▸ New Folder…", the tab strip's
 * empty-space menu's "New Folder", and the selection menu's "New Folder…". The desktop's window
 * names as it always did – the desktop's paths are byte-equivalent by `formFactor === 'desktop'`
 * – and so does a caller with no window.
 */
describe('the touch hosts’ default group name (§6): "Group" on the phone and the tablet, the desktop’s "New Folder" kept', () => {
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

  it('the link menu’s group (Open Link in New Tab in Group) is named "Group" on the phone and on the tablet – the row is a touch host’s alone', () => {
    for (const layout of ['phone', 'tablet'] as const) {
      const h = on(layout)
      const before = folders(h).map((f) => f.id)
      h.menu(pageParams({ linkURL: LINK, linkText: 'Linked' }))
      h.click('Open Link in New Tab in Group')
      expect(newest(h, before).name).toBe(NEW_GROUP_NAME)
      expect(newest(h, before).name).toBe('Group')
    }
    // The desktop's link menu has no such row: nothing of the desktop's is named by this path.
    const d = on('desktop')
    expect(d.menu(pageParams({ linkURL: LINK, linkText: 'Linked' }))).not.toContain(
      'Open Link in New Tab in Group'
    )
  })

  it('the tab menu’s Add Tab to New Folder names the group by the host: "Group" on the phone and the tablet, "New Folder" on the desktop', () => {
    const expected: Record<FormFactor, string> = {
      phone: 'Group',
      tablet: 'Group',
      desktop: 'New Folder'
    }
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const h = on(layout)
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      // The row's LABEL keeps the desktop's word on every host – the string under review here
      // is the group's name, not the menu's.
      expect(labels(h.shown())).toContain('Move Tab > Add Tab to New Folder')
      deepItem(h.shown(), 'Add Tab to New Folder').click?.()
      const made = newest(h, before)
      expect(made.name).toBe(expected[layout])
      expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(made.id)
    }
  })

  it('Move to Folder ▸ New Folder… (the space already holding a group) names the second group by the host too', () => {
    for (const [layout, name] of [
      ['tablet', 'Group'],
      ['desktop', 'New Folder']
    ] as const) {
      const h = on(layout)
      h.browser.createFolder(h.win.activeSpaceId, 'Research', '📁', h.win, { rename: false })
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      expect(labels(h.shown())).toContain('Move Tab > Move to Folder')
      deepItem(h.shown(), 'New Folder…').click?.()
      expect(newest(h, before).name).toBe(name)
    }
  })

  it('the tab strip’s empty-space menu (New Folder) and the selection menu’s New Folder… name by the host: the tablet’s sidebar makes a "Group", the desktop’s a "New Folder"', () => {
    for (const [layout, name] of [
      ['tablet', 'Group'],
      ['desktop', 'New Folder']
    ] as const) {
      const h = on(layout)
      let before = folders(h).map((f) => f.id)
      h.browser.menus.showNewTabContextMenu(h.win, {})
      deepItem(h.shown(), 'New Folder').click?.()
      expect(newest(h, before).name).toBe(name)

      const second = h.browser.tabs.createTab({ url: 'https://second.test/', active: false }, h.win)
      before = folders(h).map((f) => f.id)
      h.browser.menus.showSelectionContextMenu([h.tabId, second.id], h.win)
      deepItem(h.shown(), 'New Folder…').click?.()
      const made = newest(h, before)
      expect(made.name).toBe(name)
      expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(made.id)
      expect(h.browser.tabs.tab(second.id)?.folderId).toBe(made.id)
    }
  })

  it('a caller with no window names as the desktop does', () => {
    const h = on('phone')
    const before = folders(h).map((f) => f.id)
    h.browser.newFolderWithTab(h.win.activeSpaceId, h.tabId)
    expect(newest(h, before).name).toBe(NEW_FOLDER_NAME)
  })
})

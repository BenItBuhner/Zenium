import { describe, expect, it } from 'vitest'
import type { FormFactor } from '../../shared/types'
import { NEW_FOLDER_NAME } from '../../shared/formFactor'
import { TOUCH_GROUP_DEFAULT_NAME } from '../../shared/groupNames'
import { ANDROID, DESKTOP, deepItem, labels, pageHarness, pageParams } from './menusFixture'

/**
 * The name a group made with no name of its own gets, by host (§6: the desktop says Folder, the
 * touch hosts say Group – a group a touch host makes is named "Group", never "New Folder"). Every
 * path of the core that names a new group by default takes the host's noun from the window's
 * form factor (`newFolderName`): the link menu's "Open Link in New Tab in Group" (a touch row),
 * the tab menu's "Add Tab to New Folder" and "Move to Folder ▸ New Folder…", the tab strip's
 * empty-space menu's "New Folder", and the selection menu's "New Folder…". The desktop's window
 * names as it always did – the desktop's paths are byte-equivalent by `formFactor === 'desktop'`
 * – and so does a caller with no window. The word itself is pinned once, in
 * `shared/__tests__/groupNames.test.ts`; these compare against the shared constant. The rows'
 * LABELS follow the same rule (§7; the Lead's fold on #731): the touch hosts' strip and selection
 * menus say New Group, New Live Group…, Add N Tabs to Group ▸ New Group…; the desktop's Folder.
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
      expect(newest(h, before).name).toBe(TOUCH_GROUP_DEFAULT_NAME)
    }
    // The desktop's link menu has no such row: nothing of the desktop's is named by this path.
    const d = on('desktop')
    expect(d.menu(pageParams({ linkURL: LINK, linkText: 'Linked' }))).not.toContain(
      'Open Link in New Tab in Group'
    )
  })

  it('the tab menu’s Add Tab to New Folder names the group by the host: "Group" on the phone and the tablet, "New Folder" on the desktop', () => {
    const expected: Record<FormFactor, string> = {
      phone: TOUCH_GROUP_DEFAULT_NAME,
      tablet: TOUCH_GROUP_DEFAULT_NAME,
      desktop: NEW_FOLDER_NAME
    }
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const h = on(layout)
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      // The row's LABEL takes the host's noun too (TABLET-22: the touch hosts' tab menu says
      // Group, the desktop's Folder); the string under review here is the group's name.
      const row = layout === 'desktop' ? 'Add Tab to New Folder' : 'Add Tab to New Group'
      expect(labels(h.shown())).toContain(`Move Tab > ${row}`)
      deepItem(h.shown(), row).click?.()
      const made = newest(h, before)
      expect(made.name).toBe(expected[layout])
      expect(h.browser.tabs.tab(h.tabId)?.folderId).toBe(made.id)
    }
  })

  it('Move to Folder ▸ New Folder… (the space already holding a group) names the second group by the host too', () => {
    for (const [layout, name, moveTo, newOne] of [
      ['tablet', TOUCH_GROUP_DEFAULT_NAME, 'Move to Group', 'New Group…'],
      ['desktop', NEW_FOLDER_NAME, 'Move to Folder', 'New Folder…']
    ] as const) {
      const h = on(layout)
      h.browser.createFolder(h.win.activeSpaceId, 'Research', '📁', h.win, { rename: false })
      const before = folders(h).map((f) => f.id)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
      expect(labels(h.shown())).toContain(`Move Tab > ${moveTo}`)
      deepItem(h.shown(), newOne).click?.()
      expect(newest(h, before).name).toBe(name)
    }
  })

  it('the tab strip’s empty-space menu (New Folder) and the selection menu’s New Folder… name by the host: the tablet’s sidebar makes a "Group", the desktop’s a "New Folder" – and the rows themselves say Group on the touch host (§7; the Lead’s fold on #731)', () => {
    for (const [layout, name, newOne, live, addTo, newOneDots] of [
      [
        'tablet',
        TOUCH_GROUP_DEFAULT_NAME,
        'New Group',
        'New Live Group…',
        'Add 2 Tabs to Group',
        'New Group…'
      ],
      [
        'phone',
        TOUCH_GROUP_DEFAULT_NAME,
        'New Group',
        'New Live Group…',
        'Add 2 Tabs to Group',
        'New Group…'
      ],
      [
        'desktop',
        NEW_FOLDER_NAME,
        'New Folder',
        'New Live Folder…',
        'Add 2 Tabs to Folder',
        'New Folder…'
      ]
    ] as const) {
      const h = on(layout)
      let before = folders(h).map((f) => f.id)
      h.browser.menus.showNewTabContextMenu(h.win, {})
      const strip = labels(h.shown())
      expect(strip).toContain(newOne)
      expect(strip).toContain(live)
      expect(strip.filter((l) => /Folder|Group/.test(l))).toEqual([newOne, live])
      deepItem(h.shown(), newOne).click?.()
      expect(newest(h, before).name).toBe(name)

      const second = h.browser.tabs.createTab({ url: 'https://second.test/', active: false }, h.win)
      before = folders(h).map((f) => f.id)
      h.browser.menus.showSelectionContextMenu([h.tabId, second.id], h.win)
      const selection = labels(h.shown())
      expect(selection).toContain(`${addTo} > ${newOneDots}`)
      // Not one row of the other host's noun (the strip-made group's own name is listed too).
      const foreign = layout === 'desktop' ? /Group/ : /Folder/
      expect(selection.filter((l) => foreign.test(l))).toEqual([])
      deepItem(h.shown(), newOneDots).click?.()
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

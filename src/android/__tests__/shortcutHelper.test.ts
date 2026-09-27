import { describe, expect, it } from 'vitest'
import { defaultShortcuts } from '../../shared/shortcuts'
import { helperShortcuts } from '../shortcutHelper'

/** The table as the Android core builds it (`Browser.syncShortcuts`: Android's platform, Chrome's preset). */
const TABLE = defaultShortcuts('android')

describe('helperShortcuts (TABLET-20)', () => {
  it('sends every row of the table with its group, label, binding, hidden flag and layouts', () => {
    const rows = helperShortcuts(TABLE)
    expect(rows).toHaveLength(TABLE.length)
    for (const [i, shortcut] of TABLE.entries()) {
      expect(rows[i]).toEqual({
        action: shortcut.action,
        group: shortcut.group,
        label: shortcut.label,
        binding: shortcut.binding,
        hidden: shortcut.hidden === true,
        layouts: shortcut.layouts ?? null
      })
    }
  })

  it("carries a desktop-only row's layouts on the wire, so the helper keeps it out of the tablet's and the phone's listing", () => {
    // `layouts: ['desktop']` rows (Name Window…, Screenshot…, Task Manager; #588's Report an
    // issue… once it lands): the row travels, the layouts with it, and `ShortcutHelper.groups`
    // lists it on no layout but the desktop's – the JUnit pin `aDesktopOnlyRowIsListedOnNoTouchLayout`.
    const desktopOnly = TABLE.filter((s) => s.layouts && !s.layouts.includes('tablet'))
    expect(desktopOnly.length).toBeGreaterThanOrEqual(3)
    expect(desktopOnly.map((s) => s.action)).toEqual(
      expect.arrayContaining(['window.name', 'capture.start', 'tasks.open'])
    )
    const rows = helperShortcuts(TABLE)
    for (const shortcut of desktopOnly) {
      const row = rows.find((r) => r.action === shortcut.action)
      expect(row?.layouts).toEqual(shortcut.layouts)
      expect(row?.layouts).not.toContain('tablet')
      expect(row?.layouts).not.toContain('phone')
    }
    // A row without layouts is every layout's: null on the wire, never an empty list.
    expect(rows.find((r) => r.action === 'tab.new')?.layouts).toBeNull()
  })
})

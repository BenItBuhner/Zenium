import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultShortcuts } from '../../shared/shortcuts'
import type { Platform, Shortcut } from '../../shared/types'
import { helperShortcuts } from '../shortcutHelper'

/** The table as the Android core builds it (`Browser.syncShortcuts`: Android's platform, Chrome's preset). */
const TABLE = defaultShortcuts('android')
const DESKTOPS: Platform[] = ['linux', 'win32', 'darwin']
const ROOT = resolve(__dirname, '../../..')

/**
 * The rows Chrome's helper has too, read off the Kotlin table that holds Chrome's words for them
 * (`ShortcutHelper.CHROME_ROWS`), with the Select Tab rows Chrome folds into its one row.
 */
function chromesRows(): Set<string> {
  const kotlin = readFileSync(
    resolve(ROOT, 'android/app/src/main/kotlin/app/zen/chromium/ShortcutHelper.kt'),
    'utf8'
  )
  const actions = [...kotlin.matchAll(/ChromeRow\("([a-zA-Z0-9.]+)"/g)].map((m) => m[1])
  expect(actions.length).toBeGreaterThanOrEqual(30)
  for (let n = 2; n <= 8; n++) actions.push(`tab.select${n}`)
  return new Set(actions)
}

/**
 * Chrome's register (§9.1): the first word capitalised, the rest lowercase but for a product's
 * name or an acronym, which keeps its capitals (Compact Mode, Reader View, Glance, URL, Markdown,
 * Chrome's "Bookmarks bar"); 'Space' keeps its capital in any position; 'split view' is a common
 * noun written lower-case; no row ends in an ellipsis (Chrome's helper rows carry none – the
 * Settings label keeps its own).
 */
const KEEPS_CAPITALS = new Set([
  'Compact',
  'Mode',
  'Reader',
  'Glance',
  'URL',
  'Markdown',
  'Bookmarks',
  'Space'
])
function isSentenceForm(words: string): boolean {
  if (/…|\.\.\./.test(words)) return false
  if (/\bspace\b/.test(words)) return false
  if (/split view/i.test(words) && !/split view/.test(words)) return false
  const parts = words.split(' ')
  const first = parts[0]
  if (!first || first[0] !== first[0]?.toUpperCase()) return false
  return parts.every(
    (word, i) =>
      i === 0 ||
      word[0] === word[0]?.toLowerCase() ||
      KEEPS_CAPITALS.has(word) ||
      (word === 'View' && parts[i - 1] === 'Reader')
  )
}

describe('helperShortcuts (TABLET-20)', () => {
  it('sends every row of the table with its group, both labels, binding, unsupported and hidden flags and layouts', () => {
    const rows = helperShortcuts(TABLE)
    expect(rows).toHaveLength(TABLE.length)
    for (const [i, shortcut] of TABLE.entries()) {
      expect(rows[i]).toEqual({
        action: shortcut.action,
        group: shortcut.group,
        label: shortcut.label,
        helperLabel: shortcut.helperLabel ?? null,
        binding: shortcut.binding,
        unsupported: shortcut.unsupported === true,
        hidden: shortcut.hidden === true,
        layouts: shortcut.layouts ?? null
      })
    }
  })

  it("carries a desktop-only row's layouts on the wire, so the helper keeps it out of the tablet's and the phone's listing", () => {
    // `layouts: ['desktop']` rows (Name Window…, Screenshot…, Task Manager, Show / Hide Bookmarks
    // Bar and the two Compact Mode rows – §9.36's chrome; #588's Report an issue… once it lands):
    // the row travels, the layouts with it, and `ShortcutHelper.groups` lists it on no layout but
    // the desktop's – the JUnit pin `aDesktopOnlyRowIsListedOnNoTouchLayout`.
    const desktopOnly = TABLE.filter((s) => s.layouts && !s.layouts.includes('tablet'))
    expect(desktopOnly.map((s) => s.action).sort()).toEqual(
      [
        'window.name',
        'capture.start',
        'tasks.open',
        'bookmark.toggleBar',
        'compact.toggle',
        'compact.toggleSidebar'
      ].sort()
    )
    for (const action of ['bookmark.toggleBar', 'compact.toggle', 'compact.toggleSidebar']) {
      expect(TABLE.find((s) => s.action === action)?.layouts, action).toEqual(['desktop'])
    }
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

  it('flags the DevTools rows and View Page Source unsupported on Android alone, and carries the flag – the helper leaves them out, the chord routes and says so', () => {
    // The tablet has no DevTools surface (`capabilities.devtools` false; `toggleDevtools` toasts
    // and returns) and no source view (`capabilities.viewSource` false; the WebView renders no
    // `view-source:` document), so the rows are the table's `unsupported` there – on both
    // presets – and on no desktop platform.
    const UNSUPPORTED_ON_ANDROID = [
      'page.viewSource',
      'devtools.toggle',
      'devtools.inspector',
      'devtools.console',
      'devtools.browserConsole'
    ].sort()
    for (const preset of ['chrome', 'zen'] as const) {
      const android = defaultShortcuts('android', preset)
      expect(
        android
          .filter((s) => s.unsupported)
          .map((s) => s.action)
          .sort()
      ).toEqual(UNSUPPORTED_ON_ANDROID)
      for (const platform of DESKTOPS) {
        expect(defaultShortcuts(platform, preset).filter((s) => s.unsupported)).toEqual([])
      }
    }
    const rows = helperShortcuts(TABLE)
    for (const action of UNSUPPORTED_ON_ANDROID) {
      const row = rows.find((r) => r.action === action)
      expect(row?.unsupported, action).toBe(true)
      // The Chrome preset binds four of the five; the row travels bound, for the router.
      if (action !== 'devtools.browserConsole') expect(row?.binding, action).not.toBeNull()
    }
    expect(rows.find((r) => r.action === 'tab.new')?.unsupported).toBe(false)
  })

  it("carries the table's helper words: one register on the sheet, Chrome's sentence form, never a case transform of the Settings label", () => {
    const chromes = chromesRows()
    const rows = helperShortcuts(TABLE)
    let withWords = 0
    for (const shortcut of TABLE) {
      const row = rows.find((r) => r.action === shortcut.action)
      expect(row?.helperLabel).toBe(shortcut.helperLabel ?? null)
      if (chromes.has(shortcut.action)) {
        // Chrome's rows print Chrome's words (Kotlin's table); the core sends none for them.
        expect(shortcut.helperLabel, shortcut.action).toBeUndefined()
        continue
      }
      // Zenium's own: the words the sheet prints are in Chrome's sentence form – the table's
      // `helperLabel` where the Settings label is not already so – and a helperLabel is a second
      // register, never the label repeated.
      const words = shortcut.helperLabel ?? shortcut.label
      expect(isSentenceForm(words), `${shortcut.action}: "${words}"`).toBe(true)
      if (shortcut.helperLabel !== undefined) {
        withWords++
        expect(shortcut.helperLabel).not.toBe(shortcut.label)
      }
    }
    expect(withWords).toBeGreaterThanOrEqual(45)
    // The lead's samples, verbatim.
    const words = (action: string): string | undefined =>
      TABLE.find((s) => s.action === action)?.helperLabel
    const label = (action: string): string | undefined =>
      TABLE.find((s) => s.action === action)?.label
    expect(words('tab.duplicate')).toBe('Duplicate tab')
    expect(words('tab.moveToStart')).toBe('Move tab to start')
    expect(words('bookmark.allTabs')).toBe('Bookmark all tabs')
    expect(words('tab.copyUrlMarkdown')).toBe('Copy current URL as Markdown')
    expect(words('tab.togglePin')).toBe('Pin or unpin tab')
    // The lead's two §9.1 nouns: 'Space' with its capital in any position, 'split view' lower-case.
    expect(words('split.grid')).toBe('Toggle split view grid')
    expect(words('split.vertical')).toBe('Toggle split view vertical')
    expect(words('split.horizontal')).toBe('Toggle split view horizontal')
    expect(words('space.new')).toBe('Create new Space')
    expect(words('space.next')).toBe('Jump to the next Space')
    expect(words('space.prev')).toBe('Jump to the previous Space')
    // Chrome's verb-first parallels (the coordinator's ruling on the six noun-phrase rows).
    expect(words('split.nextPane')).toBe('Jump to the next split pane')
    expect(words('split.prevPane')).toBe('Jump to the previous split pane')
    expect(words('window.newUnsynced')).toBe('Open a new blank window')
    expect(words('split.newEmpty')).toBe('Open a new empty split view')
    // The ellipsis is the Settings label's and the menus', never the sheet's.
    expect(words('window.name')).toBe('Name window')
    expect(words('page.openFile')).toBe('Open file')
    expect(words('page.print')).toBe('Print using system dialog')
    expect(words('page.emailLink')).toBe('Email page link')
    expect(words('capture.start')).toBe('Open the screenshot overlay')
    for (const action of [
      'window.name',
      'page.openFile',
      'page.print',
      'page.emailLink',
      'capture.start'
    ]) {
      expect(label(action), action).toMatch(/…$/)
    }
    // A label already in the register carries none: a product's name with its capitals, and the
    // ten Switch to Space rows, whose label reads as the sheet would print it.
    for (const action of ['page.readerMode', 'glance.expand', 'compact.toggle', 'space.switch3']) {
      expect(words(action), action).toBeUndefined()
    }
    expect(label('space.switch3')).toBe('Switch to Space 3')
    expect(isSentenceForm('Toggle Reader View')).toBe(true)
    expect(isSentenceForm('Duplicate Tab')).toBe(false)
    expect(isSentenceForm('Switch to space 3')).toBe(false)
    expect(isSentenceForm('Toggle Split View grid')).toBe(false)
    expect(isSentenceForm('Open file…')).toBe(false)
    expect(isSentenceForm('Jump to the next Space')).toBe(true)
  })

  it("leaves the desktop's table and rendering as they were: the same labels on every platform, and no desktop listing reads the helper words", () => {
    // The Settings page's Title Case labels are untouched, platform for platform.
    const labels = (rows: Shortcut[]): string[] => rows.map((s) => s.label)
    for (const platform of DESKTOPS) {
      expect(labels(defaultShortcuts(platform))).toEqual(labels(TABLE))
      expect(labels(defaultShortcuts(platform, 'zen'))).toEqual(
        labels(defaultShortcuts('android', 'zen'))
      )
    }
    expect(TABLE.find((s) => s.action === 'tab.duplicate')?.label).toBe('Duplicate Tab')
    // The desktop's listings (the Settings page's rows, its search, the command palette) print
    // `label`; `helperLabel` is read by Android's bridge alone.
    for (const file of [
      'src/renderer/src/components/pages/settings/ShortcutRow.tsx',
      'src/renderer/src/components/pages/settings/sections.tsx',
      'src/core/keys.ts'
    ]) {
      expect(readFileSync(resolve(ROOT, file), 'utf8'), file).not.toContain('helperLabel')
    }
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHROMES_HELPER_ROWS, defaultShortcuts } from '../../shared/shortcuts'
import { S } from '../../shared/strings'
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
 * Chrome's register (§9.1 v2): the first word capitalised, the rest lowercase but for a coined
 * sense, a proper noun or an acronym, which keeps its capitals (Glance, Space, URL, Markdown,
 * JavaScript, the hyphenated Picture-in-Picture); a common noun goes lower-case – compact mode,
 * reader view, split view, bookmarks bar (P-45); no row ends in an ellipsis (Chrome's helper
 * rows carry none – the Settings label keeps its own). Checked independently of the string
 * table's `sentence()`, so the two agree on the register rather than one repeating the other.
 */
const KEEPS_CAPITALS = new Set(['Glance', 'Space', 'URL', 'Markdown', 'JavaScript'])
function isSentenceForm(words: string): boolean {
  if (/…|\.\.\./.test(words)) return false
  if (/\bspace\b/.test(words)) return false
  const parts = words.split(' ')
  const first = parts[0]
  if (!first || first[0] !== first[0]?.toUpperCase()) return false
  // 'split view' after the first word is lower-case ("Split view grid" leads with it; "Toggle
  // Split View grid" does not pass).
  const rest = parts.slice(1).join(' ')
  if (/split view/i.test(rest) && !/split view/.test(rest)) return false
  return parts.every(
    (word, i) => i === 0 || word[0] === word[0]?.toLowerCase() || KEEPS_CAPITALS.has(word)
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
    // `layouts: ['desktop']` rows (Name Window…, Screenshot…, Task Manager and the two Compact
    // Mode rows – §9.36's chrome; #588's Report an issue… once it lands): the row travels, the
    // layouts with it, and `ShortcutHelper.groups` lists it on no layout but the desktop's – the
    // JUnit pin `aDesktopOnlyRowIsListedOnNoTouchLayout`. Show / Hide Bookmarks Bar is the
    // sidebar layouts' since the tablet's bar (NTP-34): `['desktop', 'tablet']`, the phone out.
    const desktopOnly = TABLE.filter((s) => s.layouts && !s.layouts.includes('tablet'))
    expect(desktopOnly.map((s) => s.action).sort()).toEqual(
      [
        'window.name',
        'capture.start',
        'tasks.open',
        'compact.toggle',
        'compact.toggleSidebar',
        // #588's Report an Issue… (W8-4): the desktop app menu's row, `layouts: ['desktop']`.
        'help.reportIssue'
      ].sort()
    )
    for (const action of ['compact.toggle', 'compact.toggleSidebar']) {
      expect(TABLE.find((s) => s.action === action)?.layouts, action).toEqual(['desktop'])
    }
    expect(TABLE.find((s) => s.action === 'bookmark.toggleBar')?.layouts).toEqual([
      'desktop',
      'tablet'
    ])
    const rows = helperShortcuts(TABLE)
    expect(rows.find((r) => r.action === 'bookmark.toggleBar')?.layouts).toEqual([
      'desktop',
      'tablet'
    ])
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

  it("carries the table's helper words: one register on the sheet, Chrome's sentence form – the string table's sentence face, never a second typed label", () => {
    const chromes = chromesRows()
    // The core's mirror of Chrome's rows is the Kotlin table, row for row.
    expect([...CHROMES_HELPER_ROWS].sort()).toEqual([...chromes].sort())
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
      // Zenium's own: the words the sheet prints are in Chrome's sentence form – the string
      // table's sentence face (`S.title`), carried as `helperLabel` where the Settings label is
      // not already so – and a helperLabel is a second register, never the label repeated.
      const words = shortcut.helperLabel ?? shortcut.label
      expect(isSentenceForm(words), `${shortcut.action}: "${words}"`).toBe(true)
      expect(words).toBe(S.title(shortcut.action))
      if (shortcut.helperLabel !== undefined) {
        withWords++
        expect(shortcut.helperLabel).not.toBe(shortcut.label)
      }
    }
    expect(withWords).toBeGreaterThanOrEqual(45)
    // The lead's samples, verbatim (the string table's words where the D7 pairs renamed an act:
    // P-2/P-3's Copy Link, P-23's nouns without "Toggle").
    const words = (action: string): string | undefined =>
      TABLE.find((s) => s.action === action)?.helperLabel
    const label = (action: string): string | undefined =>
      TABLE.find((s) => s.action === action)?.label
    expect(words('tab.duplicate')).toBe('Duplicate tab')
    expect(words('tab.moveToStart')).toBe('Move tab to start')
    expect(words('bookmark.allTabs')).toBe('Bookmark all tabs')
    expect(words('tab.copyUrlMarkdown')).toBe('Copy link as Markdown')
    expect(words('tab.togglePin')).toBe('Pin or unpin tab')
    // The lead's two §9.1 nouns: 'Space' with its capital in any position, 'split view' lower-case.
    expect(words('split.grid')).toBe('Split view grid')
    expect(words('split.vertical')).toBe('Split view vertical')
    expect(words('split.horizontal')).toBe('Split view horizontal')
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
    // A label already in the register carries none: a coined sense or a hyphenated name with its
    // capitals, and the ten Switch to Space rows, whose label reads as the sheet would print it.
    for (const action of ['glance.expand', 'page.pip', 'sidebar.toggle', 'space.switch3']) {
      expect(words(action), action).toBeUndefined()
    }
    expect(label('space.switch3')).toBe('Switch to Space 3')
    // P-23's nouns are common nouns: the sheet lower-cases them (§9.1 v2), the label keeps its case.
    expect(words('page.readerMode')).toBe('Reader view')
    expect(words('compact.toggle')).toBe('Compact mode')
    expect(label('compact.toggle')).toBe('Compact Mode')
    expect(isSentenceForm('Reader view')).toBe(true)
    expect(isSentenceForm('Toggle Reader View')).toBe(false)
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

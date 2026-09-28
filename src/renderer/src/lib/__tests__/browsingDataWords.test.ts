import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

/**
 * The words of the Delete browsing data family, swept (W8-7). Chrome renamed the family in M124
 * – `IDS_CLEAR_BROWSING_DATA_TITLE` "Delete browsing data", `IDS_SETTINGS_CLEAR_BROWSING_DATA`
 * "Delete browsing data", `IDS_SETTINGS_CLEAR_DATA` "Delete data", `IDS_SETTINGS_CLEARED_DATA`
 * "Data deleted." – and kept the identifiers' `CLEAR_` names; Zenium does the same: the words
 * change on every surface (the PS-13 dialog, the phone's sheet, Settings › Privacy's row and
 * its hub card, History's opener, the shortcut reference, the toast), the identifiers
 * (`clearBrowsingData`, `CLEAR_BROWSING_DATA_FORM`, `clear-data-*`, `key_clearBrowsingData`) do
 * not. What Chrome kept, Zenium keeps: "Clear on exit" (`IDS_SETTINGS_SITE_SETTINGS_SESSION_ONLY`)
 * and its state words are not this family's and are not swept here.
 *
 * The sweep reads the user's literals – string literals, template literal text and JSX text,
 * through TypeScript's own parser so a comment can never trip it – over the desktop, shared and
 * Android sources, and the Kotlin and resource strings, and asserts that no user-facing "Clear
 * browsing data" is left in any casing. The family's own files are held to the verb itself: no
 * prose literal there says "clear" at all.
 *
 * The verb's remainder (W8-11, the design lead's ruling after W8-7 landed): the site-data viewer
 * takes Chrome's `IDS_SETTINGS_SITE_SETTINGS_DELETE` "Delete data" and
 * `IDS_SETTINGS_SITE_SETTINGS_DELETE_ALL_STORAGE_LABEL` "Delete all data" (its question
 * `IDS_SETTINGS_SITE_SETTINGS_DELETE_ALL_STORAGE_DIALOG_TITLE` "Delete all data?") with the
 * per-site question "Delete data for <site>?"; the site-information surfaces' row and question
 * "Delete site data" / "Delete site data?" (`IDS_SETTINGS_SITE_SETTINGS_SITE_DELETE_STORAGE_DIALOG_TITLE`),
 * their toast naming the data, not the site; History's house pair "Delete history" / "Delete
 * all"; the never list's line "What a site stored is deleted when it is added". The lead's
 * second round (on the LEAD CHECK): the site-information cookies level joins the family –
 * "Delete cookies" / "Delete cookies?" / "N cookies deleted" / "No cookies to delete" (cookies
 * are site data, one level above "Delete site data"); the containers section's lines say a
 * container's removal deletes site data; the per-site question is one form on both hosts,
 * "Delete data for <site>?" over Cancel | "Delete data". The sweep below holds that no
 * user-facing "Clear data" / "Clear site data" / "Clear history" / "Clear cookies", no "Cleared
 * <site>" or "Removed N cookies" toast and no "stored is cleared" / "site data is cleared"
 * remains, and that what Chrome kept stays: the clear-on-exit list's state words, the downloads
 * list's "Clear all" (`IDS_DOWNLOAD_LINK_CLEAR_ALL`), History's "Clear the recently closed list"
 * (session state, not browsing data – "Clear" is right for emptying a list), the Reset settings
 * explanation.
 */

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The roots swept (directories walked, tests left out). */
const SWEPT = [
  'src/renderer/src',
  'src/shared',
  'src/core',
  'src/main',
  'src/preload',
  'src/android',
  'android/app/src/main/res/values/strings.xml',
  'android/app/src/main/kotlin',
  'android/app/src/androidTest/kotlin'
]

/** The family's own files: every prose literal in them speaks Chrome's verb, none says "clear". */
const FAMILY = [
  'src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx',
  'src/renderer/src/components/siteControls/ClearBrowsingDataForm.tsx',
  'src/renderer/src/components/siteControls/useClearForm.ts',
  'src/renderer/src/lib/browsingData.ts'
]

interface Literal {
  file: string
  line: number
  text: string
}

function walk(path: string): string[] {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return []
  }
  if (stat.isFile()) return [path]
  const out: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(path, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|kt|xml)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(full)
  }
  return out
}

// Read once per file: the look-ups below ask for a literal's repo path tens of thousands of
// times, and `relative()` on every ask was most of the sweep's time on a loaded CI runner.
const relOf = new Map<string, string>()
const rel = (file: string): string => {
  let r = relOf.get(file)
  if (r === undefined) {
    r = relative(repo, file).split('\\').join('/')
    relOf.set(file, r)
  }
  return r
}

/** The user's literals of a TypeScript file: strings, template text and JSX text, never a comment. */
export function literalsOfTs(file: string, source: string): Literal[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const out: Literal[] = []
  const push = (node: ts.Node, text: string): void => {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (!trimmed) return
    out.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: trimmed
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) push(node, node.text)
    else if (ts.isJsxText(node)) push(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * A Kotlin line that is a comment, a log, a thrown message or the demo harness's transcript
 * note: the words there are not the user's.
 */
const NOT_THE_USERS =
  /^\s*(\/\/|\/\*|\*)|\bLog\.\w\(|println\(|Exception\(|\berror\(|\brequire\(|\bcheck\(|\bnote\(/
const KOTLIN_QUOTED = /"((?:[^"\\\n]|\\.)*)"/g

/** The quoted literals of a Kotlin file, and the `<string>` bodies of a resource file. */
export function literalsOfOther(file: string, source: string): Literal[] {
  const out: Literal[] = []
  const lines = source
    .replace(/(?<=^|[\s{(,])\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
  lines.forEach((line, i) => {
    if (file.endsWith('.xml')) {
      const m = /<string\b[^>]*>([^<]*)<\/string>/.exec(line)
      if (m) out.push({ file, line: i + 1, text: m[1] })
      return
    }
    if (NOT_THE_USERS.test(line)) return
    for (const m of line.matchAll(KOTLIN_QUOTED))
      if (m[1]) out.push({ file, line: i + 1, text: m[1] })
  })
  return out
}

function literalsOf(file: string): Literal[] {
  const source = readFileSync(file, 'utf8')
  return /\.tsx?$/.test(file) ? literalsOfTs(file, source) : literalsOfOther(file, source)
}

/**
 * The sweep, read once for the whole file: the roots walked, every file parsed, the texts indexed
 * by repo path. The two describe blocks share it – parsing the tree is the file's one real cost,
 * and doing it twice at collection, then scanning every literal per look-up, put the W8-11 tests
 * past vitest's 5 s on a loaded CI runner (main `53ce51386`, #655's first run).
 */
interface Swept {
  files: string[]
  literals: Literal[]
  texts: Map<string, Set<string>>
}
let swept: Swept | null = null
function sweep(): Swept {
  if (swept) return swept
  const files = SWEPT.flatMap((p) => walk(join(repo, p)))
  const literals = files.flatMap(literalsOf)
  const texts = new Map<string, Set<string>>()
  for (const l of literals) {
    const file = rel(l.file)
    let set = texts.get(file)
    if (!set) texts.set(file, (set = new Set()))
    set.add(l.text)
  }
  swept = { files, literals, texts }
  return swept
}

/** Whether the file at the repo path carries `text` as one whole user-facing literal. */
const has = (file: string, text: string): boolean => sweep().texts.get(file)?.has(text) ?? false

// Room for a loaded runner: the parse is measured in seconds there, not vitest's default 5.
vi.setConfig({ testTimeout: 60_000 })

/** The family's name in Chrome's pre-M124 words, in any casing ("Clear browsing data", "Clear Browsing Data…"). */
const OLD_NAME = /clear browsing data/i

/** The old verb standing in prose: "Clear data", "Cleared history", "Nothing to clear", "clearing". */
const OLD_VERB = /\bclear(ed|ing|s)?\b/i

/**
 * The remainder's old words (W8-11): the viewer's buttons and questions ("Clear data", "Clear all
 * data", "Clear site data", "Clear all site data", "Clear data for <site>?"), History's pair
 * ("Clear history", "Clear all history?"), the viewer's line ("Clearing a site signs you out")
 * and the never list's ("What a site stored is cleared when it is added"), in any casing.
 */
const OLD_REMAINDER =
  /\bclear (all )?(site )?data\b|\bclear (all )?history\b|\bclearing a site\b|\bstored is cleared\b/i

/**
 * The cookies level's old words (the lead's second round): the footer verb and row "Clear
 * cookies", the question "Clear cookies?", the confirm's label "Confirm clear cookies", the
 * toasts "Removed N cookies" / "No cookies to remove". Held to the whole literal: the clear-on-exit
 * list's heading, Chrome's kept "Always clear cookies when Zenium closes"
 * (`IDS_SETTINGS_SITE_SETTINGS_SESSION_ONLY`'s family), says "clear cookies" mid-sentence and stays.
 */
const OLD_COOKIES = /^(confirm )?clear cookies\??$|^no cookies to remove$|^removed \d+ cookies?$/i

/** The containers section's old lines: "…its site data is cleared", "…cookies and site data are cleared". */
const OLD_CONTAINERS = /\bsite data (is|are) cleared\b/i

/**
 * The old toasts' shape: a message that begins "Cleared …" ("Cleared <site>", "Cleared everything
 * <site> stored"). A word on its own (`type: 'cleared'`, an event's tag) is an identifier, not a toast.
 */
const OLD_TOAST = /^cleared\s\S/i

/**
 * What Chrome kept, kept: the clear-on-exit list's state words (`IDS_SETTINGS_SITE_SETTINGS_SESSION_ONLY`'s
 * family – the option's name is "Clear on exit", so its states say "Cleared").
 */
const KEPT_TOAST_SHAPES = new Set([
  'Cleared on exit',
  'Cleared when Zenium closes',
  'Cleared the next time Zenium starts'
])

const at = (l: Literal): string => `${rel(l.file)}:${l.line}: "${l.text}"`

describe('the Delete browsing data words (W8-7): Chrome M124+’s "Delete" on every surface', () => {
  const { files, literals } = sweep()

  it('reads the swept files – the renderer, the shared and core sources, the Android chrome, the Kotlin – and finds the new words', () => {
    const paths = files.map(rel)
    expect(paths).toContain('src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx')
    expect(paths).toContain('src/renderer/src/components/siteControls/settingsRows.tsx')
    expect(paths).toContain('src/renderer/src/components/pages/history/HistoryPage.tsx')
    expect(paths).toContain('src/shared/shortcutReference.ts')
    expect(paths).toContain('src/core/menus.ts')
    expect(paths).toContain(
      'android/app/src/androidTest/kotlin/app/zen/chromium/SiteControlsDemo.kt'
    )
    expect(paths.some((p) => p.includes('__tests__') || /\.test\.tsx?$/.test(p))).toBe(false)
    // The extractor finds the words on each surface: a broken read would pass an empty sweep.
    const find = has
    expect(
      find(
        'src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx',
        'Delete browsing data'
      )
    ).toBe(true)
    expect(
      find('src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx', 'Delete data')
    ).toBe(true)
    expect(
      find('src/renderer/src/components/siteControls/ClearBrowsingDataForm.tsx', 'Delete data')
    ).toBe(true)
    expect(
      find('src/renderer/src/components/siteControls/settingsRows.tsx', 'Delete browsing data')
    ).toBe(true)
    expect(find('src/renderer/src/components/siteControls/settingsRows.tsx', 'Delete…')).toBe(true)
    expect(
      find('src/renderer/src/components/pages/settings/privacyHub.ts', 'Delete browsing data…')
    ).toBe(true)
    expect(
      find('src/renderer/src/components/pages/history/HistoryPage.tsx', 'Delete browsing data…')
    ).toBe(true)
    expect(find('src/shared/shortcutReference.ts', 'Delete browsing data')).toBe(true)
    // The toast's three shapes: the period's tail ("<period> deleted"), all time's "Deleted",
    // and the empty selection's "Nothing deleted".
    expect(find('src/renderer/src/lib/browsingData.ts', 'deleted')).toBe(true)
    expect(find('src/renderer/src/lib/browsingData.ts', 'Deleted')).toBe(true)
    expect(find('src/renderer/src/lib/browsingData.ts', 'Nothing deleted')).toBe(true)
    // The menu rows and the shortcut's label were Chrome's Title Case already (#396).
    expect(find('src/core/menus.ts', 'Delete Browsing Data…')).toBe(true)
    expect(find('src/core/menuBar.ts', 'Delete Browsing Data…')).toBe(true)
    expect(find('src/shared/shortcuts.ts', 'Delete Browsing Data…')).toBe(true)
    // The phone's demo driver looks the sheet up by the new words.
    expect(
      find(
        'android/app/src/androidTest/kotlin/app/zen/chromium/SiteControlsDemo.kt',
        'Delete browsing data'
      )
    ).toBe(true)
  })

  it('leaves no user-facing "Clear browsing data" in any casing, on any surface', () => {
    expect(literals.filter((l) => OLD_NAME.test(l.text)).map(at)).toEqual([])
  })

  it('speaks Chrome’s verb throughout the family’s own files: no prose literal there says "clear"', () => {
    const family = new Set(FAMILY)
    const prose = literals.filter((l) => family.has(rel(l.file)) && /\s/.test(l.text.trim()))
    expect(prose.length).toBeGreaterThan(5)
    expect(prose.filter((l) => OLD_VERB.test(l.text)).map(at)).toEqual([])
  })

  it('keeps what Chrome kept: "Clear on exit" and its state words stay', () => {
    const siteDataUi = literals.filter((l) => rel(l.file) === 'src/renderer/src/lib/siteDataUi.ts')
    expect(siteDataUi.some((l) => l.text === 'Clear on exit')).toBe(true)
    expect(siteDataUi.some((l) => l.text === 'Cleared on exit')).toBe(true)
    // The clear-on-exit group's own lines take the family's verb (Chrome: "Delete browsing data
    // on exit"), the option's name does not.
    expect(siteDataUi.some((l) => l.text === 'Delete browsing data on exit')).toBe(true)
    expect(siteDataUi.some((l) => /never deleted this way/.test(l.text))).toBe(true)
    expect(siteDataUi.some((l) => /never cleared this way/.test(l.text))).toBe(false)
  })

  it('would catch the words it swept away, and reads comments as no one’s', () => {
    const file = join(repo, 'src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx')
    const flag = (snippet: string): string[] =>
      literalsOfTs(file, snippet)
        .filter((l) => OLD_NAME.test(l.text))
        .map((l) => l.text)
    expect(flag('const t = "Clear browsing data"')).toEqual(['Clear browsing data'])
    expect(flag("label: 'Clear Browsing Data…'")).toEqual(['Clear Browsing Data…'])
    expect(flag('const t = `Clear browsing data for ${n} sites`')).toEqual([
      'Clear browsing data for'
    ])
    expect(flag('const x = <button>Clear browsing data…</button>')).toEqual([
      'Clear browsing data…'
    ])
    expect(flag('const x = <b title="Clear browsing data" />')).toEqual(['Clear browsing data'])
    expect(flag('// Clear browsing data\nconst t = 1')).toEqual([])
    expect(flag('/** Clear browsing data */\nconst t = 1')).toEqual([])
    expect(flag('const x = <div>{/* Clear browsing data */}</div>')).toEqual([])
    expect(flag("const t = 'Delete browsing data'")).toEqual([])
    const kt = (snippet: string): string[] =>
      literalsOfOther('Demo.kt', snippet)
        .filter((l) => OLD_NAME.test(l.text))
        .map((l) => l.text)
    expect(kt('awaitRow("Clear browsing data", 8_000)')).toEqual(['Clear browsing data'])
    expect(kt('// awaitRow("Clear browsing data", 8_000)')).toEqual([])
    expect(kt('/* Clear browsing data */ awaitRow("Delete browsing data", 8_000)')).toEqual([])
  })
})

describe('the verb’s remainder (W8-11): the site-data viewer, History’s pair, the never list’s line, the cookies level, the containers’ lines', () => {
  const { literals } = sweep()
  const find = has
  const SITE_DATA_UI = 'src/renderer/src/lib/siteDataUi.ts'
  const POPOVER = 'src/renderer/src/components/siteControls/SiteInfoPopover.tsx'
  const SHEET = 'src/renderer/src/components/siteinfo/SiteInfoSheet.tsx'
  const HISTORY = 'src/renderer/src/components/phone/PhoneHistoryPanel.tsx'
  const HISTORY_PAGE = 'src/renderer/src/components/pages/history/HistoryPage.tsx'
  const SECTIONS = 'src/renderer/src/components/pages/settings/sections.tsx'
  const KT = 'android/app/src/androidTest/kotlin/app/zen/chromium/'

  it('finds the viewer’s new words: Chrome’s "Delete data" / "Delete all data" / "Delete all data?", the per-site question, the item sheet’s row', () => {
    // The row's button (`IDS_SETTINGS_SITE_SETTINGS_DELETE`), the footer's
    // (`..._DELETE_ALL_STORAGE_LABEL`) and its question (`..._DELETE_ALL_STORAGE_DIALOG_TITLE`).
    expect(find(SITE_DATA_UI, 'Delete data')).toBe(true)
    expect(find(SITE_DATA_UI, 'Delete all data')).toBe(true)
    expect(find(SITE_DATA_UI, 'Delete all data?')).toBe(true)
    // The phone page's action row and the item sheet's danger row, the verb swapped.
    expect(find(SITE_DATA_UI, 'Delete all site data')).toBe(true)
    expect(find(SITE_DATA_UI, 'Delete site data')).toBe(true)
    // The per-site question names the site (the lead's words): the template's head.
    expect(find(SITE_DATA_UI, 'Delete data for')).toBe(true)
    // The viewer's line takes the verb along.
    expect(
      literals.some(
        (l) => rel(l.file) === SITE_DATA_UI && /Deleting a site’s data signs you out/.test(l.text)
      )
    ).toBe(true)
    // The viewer raised no toast; the two it once declared ("Cleared <site>", "Cleared every
    // site’s cookies and data") are gone rather than reworded. The clear-on-exit states stay.
    expect(
      literals
        .filter((l) => rel(l.file) === SITE_DATA_UI && OLD_TOAST.test(l.text))
        .filter((l) => !KEPT_TOAST_SHAPES.has(l.text))
        .map(at)
    ).toEqual([])
  })

  it('finds the site-information surfaces’ row, question and toast, on the popover and the sheet alike', () => {
    for (const file of [POPOVER, SHEET]) {
      expect(find(file, 'Delete site data')).toBe(true)
      expect(find(file, 'Delete site data?')).toBe(true)
      // The toast names the data, not the site (Chrome's compound from
      // `IDS_SETTINGS_SITE_SETTINGS_COOKIE_REMOVE_SITE`, said as done).
      expect(find(file, 'Site data and permissions deleted')).toBe(true)
      // The house line's verb goes along ("Deletes …, then reloads the page").
      expect(
        literals.some(
          (l) =>
            rel(l.file) === file &&
            /^Deletes (the )?cookies, stored data and permissions of/.test(l.text)
        )
      ).toBe(true)
    }
    expect(find(SHEET, 'Confirm delete site data')).toBe(true)
  })

  it('finds History’s house pair: "Delete history" over the question "Delete all history?" and its "Delete all"', () => {
    expect(find(HISTORY, 'Delete history')).toBe(true)
    expect(find(HISTORY, 'Delete all history?')).toBe(true)
    expect(find(HISTORY, 'Delete all')).toBe(true)
    expect(
      literals.some(
        (l) => rel(l.file) === HISTORY && /will be deleted from Zenium's history/.test(l.text)
      )
    ).toBe(true)
  })

  it('finds the never list’s line: "What a site stored is deleted when it is added"', () => {
    expect(
      find(
        SITE_DATA_UI,
        'These sites can never use cookies. What a site stored is deleted when it is added.'
      )
    ).toBe(true)
    expect(find(SITE_DATA_UI, 'No cookies; what it stored is deleted now.')).toBe(true)
  })

  it('the phone’s demo drivers look the surfaces up by the new words', () => {
    expect(find(`${KT}SiteDataUiDemo.kt`, 'Delete data for')).toBe(true)
    // The per-site question's one form on both hosts: the item sheet's prompt confirms with
    // "Delete data" (the viewer's row's word), and the driver presses it by that name; the
    // sheet's "Delete site data" row it reaches by the row's `clear` handle, not its words.
    expect(find(`${KT}SiteDataUiDemo.kt`, 'Delete data')).toBe(true)
    expect(find(`${KT}SiteDataUiDemo.kt`, 'Delete all data?')).toBe(true)
    expect(find(`${KT}HistoryBookmarksDemo.kt`, 'Delete history')).toBe(true)
    expect(find(`${KT}HistoryBookmarksDemo.kt`, 'Delete all')).toBe(true)
    // The question is read inside a `finding(...)` line whose quotes nest; the words are there.
    expect(
      literals.some(
        (l) =>
          rel(l.file) === `${KT}HistoryBookmarksDemo.kt` && l.text.includes('Delete all history?')
      )
    ).toBe(true)
    expect(find(`${KT}PrimitivesPass4Demo.kt`, 'Delete history')).toBe(true)
    expect(find(`${KT}BackDemo.kt`, 'Delete history')).toBe(true)
    expect(find(`${KT}ChromeA11yDemo.kt`, 'Delete history')).toBe(true)
    // The site-information driver reads the cookies level and its confirm by the new words.
    expect(find(`${KT}SiteInfoDemo.kt`, 'Delete cookies')).toBe(true)
    expect(find(`${KT}SiteInfoDemo.kt`, 'Confirm delete cookies')).toBe(true)
  })

  it('finds the cookies level’s words on the popover and the sheet alike: "Delete cookies" / "Delete cookies?" / "N cookies deleted" / "No cookies to delete"', () => {
    for (const file of [POPOVER, SHEET]) {
      // The level's footer verb (the sheet's row), its question and the question's danger verb.
      expect(find(file, 'Delete cookies')).toBe(true)
      expect(find(file, 'Delete cookies?')).toBe(true)
      // The question's line: "Deletes N cookies and signs you out of <site>." – the template's parts.
      expect(find(file, 'Deletes')).toBe(true)
      expect(find(file, 'and signs you out of')).toBe(true)
      // The toast's three shapes: none, one, many – said as done, like the family's.
      expect(find(file, 'No cookies to delete')).toBe(true)
      expect(find(file, '1 cookie deleted')).toBe(true)
      expect(find(file, 'cookies deleted')).toBe(true)
      // The old toasts' head ("Removed N cookies") is gone from both files.
      expect(
        literals.filter((l) => rel(l.file) === file && /^removed\b/i.test(l.text)).map(at)
      ).toEqual([])
    }
    expect(find(SHEET, 'Confirm delete cookies')).toBe(true)
  })

  it('finds the containers’ lines: a container’s removal deletes site data', () => {
    expect(find(SECTIONS, 'Its cookies and site data are deleted.')).toBe(true)
    expect(
      find(SECTIONS, 'Tabs in this container lose their sign-ins; its site data is deleted.')
    ).toBe(true)
  })

  it('leaves no user-facing "Clear data" / "Clear site data" / "Clear history" / "Clearing a site" / "stored is cleared", in any casing, on any surface', () => {
    expect(literals.filter((l) => OLD_REMAINDER.test(l.text)).map(at)).toEqual([])
  })

  it('leaves no user-facing "Clear cookies" / "Clear cookies?" / "Confirm clear cookies" / "No cookies to remove" / "Removed N cookies", nor a "site data is cleared" line, in any casing, on any surface', () => {
    expect(literals.filter((l) => OLD_COOKIES.test(l.text)).map(at)).toEqual([])
    expect(literals.filter((l) => OLD_CONTAINERS.test(l.text)).map(at)).toEqual([])
  })

  it('raises no toast that begins "Cleared", the clear-on-exit list’s state words apart', () => {
    const toasts = literals.filter(
      (l) => /\.tsx?$/.test(l.file) && OLD_TOAST.test(l.text) && !KEPT_TOAST_SHAPES.has(l.text)
    )
    expect(toasts.map(at)).toEqual([])
  })

  it('keeps what Chrome kept: the clear-on-exit words, the downloads list’s "Clear all", History’s "Clear the recently closed list", the Reset explanation', () => {
    for (const kept of KEPT_TOAST_SHAPES) expect(find(SITE_DATA_UI, kept)).toBe(true)
    expect(find(SITE_DATA_UI, 'Clear on exit')).toBe(true)
    // The clear-on-exit list's heading says "clear cookies" mid-sentence
    // (`IDS_SETTINGS_SITE_SETTINGS_SESSION_ONLY`'s family) and is not the cookies level's verb.
    expect(find('src/shared/siteData.ts', 'Always clear cookies when Zenium closes')).toBe(true)
    expect(find('src/shared/siteData.ts', 'Always clear cookies when windows are closed')).toBe(
      true
    )
    // `IDS_DOWNLOAD_LINK_CLEAR_ALL` "Clear all": Chrome's downloads page kept its verb.
    expect(find('src/renderer/src/components/pages/downloads/DownloadsPage.tsx', 'Clear all')).toBe(
      true
    )
    expect(
      find('src/renderer/src/components/downloads/ClearAllConfirm.tsx', 'Clear all downloads?')
    ).toBe(true)
    // History's recently closed list is session state, not browsing data (the lead's ruling):
    // "Clear" is right for emptying a list, and the button's name stays.
    expect(find(HISTORY_PAGE, 'Clear the recently closed list')).toBe(true)
    // `IDS_SETTINGS_RESET_PROFILE_SETTINGS_EXPLANATION` still says "clear temporary data like cookies".
    expect(
      literals.some(
        (l) => rel(l.file) === SECTIONS && /clear temporary data like cookies/.test(l.text)
      )
    ).toBe(true)
  })

  it('would catch the words it swept away', () => {
    // A `.tsx` path, so the JSX snippets parse as JSX.
    const file = join(repo, POPOVER)
    const swept = (text: string): boolean =>
      OLD_REMAINDER.test(text) ||
      OLD_TOAST.test(text) ||
      OLD_COOKIES.test(text) ||
      OLD_CONTAINERS.test(text)
    const flag = (snippet: string): string[] =>
      literalsOfTs(file, snippet)
        .filter((l) => swept(l.text))
        .map((l) => l.text)
    expect(flag("clear: 'Clear'")).toEqual([])
    expect(flag("clear: 'Clear data'")).toEqual(['Clear data'])
    expect(flag("clearAll: 'Clear all'")).toEqual([])
    expect(flag("clearAll: 'Clear all site data'")).toEqual(['Clear all site data'])
    expect(flag("title: 'Clear all site data?'")).toEqual(['Clear all site data?'])
    expect(flag('const t = `Clear data for ${site}?`')).toEqual(['Clear data for'])
    expect(flag('const x = <button>Clear site data</button>')).toEqual(['Clear site data'])
    expect(flag('const x = <Row title="Clear history" />')).toEqual(['Clear history'])
    expect(flag("text: 'Clear all history?'")).toEqual(['Clear all history?'])
    expect(flag('pushToast(`Cleared everything ${site} stored`)')).toEqual(['Cleared everything'])
    expect(flag("const t = 'What a site stored is cleared when it is added.'")).toEqual([
      'What a site stored is cleared when it is added.'
    ])
    expect(flag("const t = 'Clearing a site signs you out of it'")).toEqual([
      'Clearing a site signs you out of it'
    ])
    // The cookies level's old words (the lead's second round): the verb, the question, the
    // confirm's label, the toasts.
    expect(flag("const t = 'Clear cookies'")).toEqual(['Clear cookies'])
    expect(flag('const x = <ConfirmLevel title="Clear cookies?" />')).toEqual(['Clear cookies?'])
    expect(flag("confirmLabel: 'Confirm clear cookies'")).toEqual(['Confirm clear cookies'])
    expect(flag("pushToast('No cookies to remove')")).toEqual(['No cookies to remove'])
    expect(flag("pushToast('Removed 3 cookies')")).toEqual(['Removed 3 cookies'])
    expect(flag("pushToast('Removed 1 cookie')")).toEqual(['Removed 1 cookie'])
    // The containers' old lines.
    expect(flag("const t = 'Its cookies and site data are cleared.'")).toEqual([
      'Its cookies and site data are cleared.'
    ])
    expect(
      flag("const t = 'Tabs in this container lose their sign-ins; its site data is cleared.'")
    ).toEqual(['Tabs in this container lose their sign-ins; its site data is cleared.'])
    // Kept shapes and unrelated verbs pass.
    expect(flag("const t = 'Clear on exit'")).toEqual([])
    expect(flag("const t = 'Clear browsing data'")).toEqual([])
    expect(flag("const t = 'Delete data for'")).toEqual([])
    expect(flag("const t = 'Delete cookies'")).toEqual([])
    expect(flag("const t = 'Always clear cookies when Zenium closes'")).toEqual([])
    expect(flag("const t = 'Clear the recently closed list'")).toEqual([])
    expect(flag("const t = 'Its cookies and site data are deleted.'")).toEqual([])
    expect(flag('// Clear site data\nconst t = 1')).toEqual([])
    expect(flag('// Clear cookies\nconst t = 1')).toEqual([])
    const kt = (snippet: string): string[] =>
      literalsOfOther('Demo.kt', snippet)
        .filter((l) => swept(l.text))
        .map((l) => l.text)
    expect(kt('click("Clear history")')).toEqual(['Clear history'])
    expect(kt('topSheetTitled("Clear data for")')).toEqual(['Clear data for'])
    expect(kt('tapUntil(f, "Clear cookies", "Confirm clear cookies")')).toEqual([
      'Clear cookies',
      'Confirm clear cookies'
    ])
    expect(kt('// click("Clear history")')).toEqual([])
    expect(kt('// tapUntil(f, "Clear cookies", "Confirm clear cookies")')).toEqual([])
    expect(kt('note("  the Clear all site data row did not open its prompt")')).toEqual([])
  })
})

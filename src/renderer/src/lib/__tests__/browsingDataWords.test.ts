import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

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

const rel = (file: string): string => relative(repo, file).split('\\').join('/')

/** The user's literals of a TypeScript file: strings, template text and JSX text, never a comment. */
export function literalsOfTs(file: string, source: string): Literal[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const out: Literal[] = []
  const push = (node: ts.Node, text: string): void => {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (!trimmed) return
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: trimmed })
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
    for (const m of line.matchAll(KOTLIN_QUOTED)) if (m[1]) out.push({ file, line: i + 1, text: m[1] })
  })
  return out
}

function literalsOf(file: string): Literal[] {
  const source = readFileSync(file, 'utf8')
  return /\.tsx?$/.test(file) ? literalsOfTs(file, source) : literalsOfOther(file, source)
}

/** The family's name in Chrome's pre-M124 words, in any casing ("Clear browsing data", "Clear Browsing Data…"). */
const OLD_NAME = /clear browsing data/i

/** The old verb standing in prose: "Clear data", "Cleared history", "Nothing to clear", "clearing". */
const OLD_VERB = /\bclear(ed|ing|s)?\b/i

const at = (l: Literal): string => `${rel(l.file)}:${l.line}: "${l.text}"`

describe('the Delete browsing data words (W8-7): Chrome M124+’s "Delete" on every surface', () => {
  const files = SWEPT.flatMap((p) => walk(join(repo, p)))
  const literals = files.flatMap(literalsOf)

  it('reads the swept files – the renderer, the shared and core sources, the Android chrome, the Kotlin – and finds the new words', () => {
    const paths = files.map(rel)
    expect(paths).toContain('src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx')
    expect(paths).toContain('src/renderer/src/components/siteControls/settingsRows.tsx')
    expect(paths).toContain('src/renderer/src/components/pages/history/HistoryPage.tsx')
    expect(paths).toContain('src/shared/shortcutReference.ts')
    expect(paths).toContain('src/core/menus.ts')
    expect(paths).toContain('android/app/src/androidTest/kotlin/app/zen/chromium/SiteControlsDemo.kt')
    expect(paths.some((p) => p.includes('__tests__') || /\.test\.tsx?$/.test(p))).toBe(false)
    // The extractor finds the words on each surface: a broken read would pass an empty sweep.
    const find = (file: string, text: string): boolean =>
      literals.some((l) => rel(l.file) === file && l.text === text)
    expect(find('src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx', 'Delete browsing data')).toBe(true)
    expect(find('src/renderer/src/components/siteControls/ClearBrowsingDataDialog.tsx', 'Delete data')).toBe(true)
    expect(find('src/renderer/src/components/siteControls/ClearBrowsingDataForm.tsx', 'Delete data')).toBe(true)
    expect(find('src/renderer/src/components/siteControls/settingsRows.tsx', 'Delete browsing data')).toBe(true)
    expect(find('src/renderer/src/components/siteControls/settingsRows.tsx', 'Delete…')).toBe(true)
    expect(find('src/renderer/src/components/pages/settings/privacyHub.ts', 'Delete browsing data…')).toBe(true)
    expect(find('src/renderer/src/components/pages/history/HistoryPage.tsx', 'Delete browsing data…')).toBe(true)
    expect(find('src/shared/shortcutReference.ts', 'Delete browsing data')).toBe(true)
    expect(find('src/renderer/src/lib/browsingData.ts', 'Nothing to delete')).toBe(true)
    expect(find('src/renderer/src/lib/browsingData.ts', 'Deleted')).toBe(true)
    // The menu rows and the shortcut's label were Chrome's Title Case already (#396).
    expect(find('src/core/menus.ts', 'Delete Browsing Data…')).toBe(true)
    expect(find('src/core/menuBar.ts', 'Delete Browsing Data…')).toBe(true)
    expect(find('src/shared/shortcuts.ts', 'Delete Browsing Data…')).toBe(true)
    // The phone's demo driver looks the sheet up by the new words.
    expect(find('android/app/src/androidTest/kotlin/app/zen/chromium/SiteControlsDemo.kt', 'Delete browsing data')).toBe(true)
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
    expect(flag('const t = `Clear browsing data for ${n} sites`')).toEqual(['Clear browsing data for'])
    expect(flag('const x = <button>Clear browsing data…</button>')).toEqual(['Clear browsing data…'])
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

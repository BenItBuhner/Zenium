// The sweep reads source files, as `nonUniqueHost.test.ts` reads its tables: a test's Node, not
// the shared code's.
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync, statSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path'
// eslint-disable-next-line no-restricted-imports
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROTECTED, sentence, tableEntries, tableValues } from '../strings'

/**
 * The string table's sweep (spec §9 item 10; the D7 proposal §C, built on the casing sweep's
 * `literalsOf` / `strays` – `src/android/__tests__/casingSweep.test.ts`,
 * `src/renderer/src/lib/__tests__/casingSweep.test.ts`). A family lands with its module, its call
 * sites and its root here (§D) – a file, a directory, or one method of a file whose other
 * methods are later families' (the app menu in `menus.ts`); within a swept root:
 *
 * 1. a quoted literal or JSX text equal to a table value – any face of any entry, with or
 *    without the ellipsis, every side of an axis – fails: the surface reads `S.menu(id)`. A value
 *    of one word ("Settings", "Reload") counts in a label position alone, where a literal of one
 *    word is otherwise an identifier;
 * 2. a label literal containing "…" fails: the `ask` flag supplies the ellipsis, the character
 *    is never typed;
 * 3. a label or JSX text with a typographic quote (’ ‘ “ ”) fails: straight apostrophes and
 *    quotes (Q7);
 * 4. a US spelling in a label or JSX text fails: the `-ize` / `-ization` / `-yze` forms, color,
 *    favorite, center, gray, "license" as a noun (the page is "Licences"; the verb's "licensed"
 *    passes) and the words listed with them.
 *
 * The table's own values are checked too: no ellipsis, no typographic quote, no US spelling
 * (an `os` face excepted: the platform's own words, Q4), an explicit `sentence` that differs
 * from the derived one. A literal a later family will take is named in `PENDING` with the PR
 * that takes it, one entry per literal, so a new stray cannot hide behind an old exemption; a
 * literal that is to stay one – a parent that shares an act's word, a count's truncation – is
 * named in `KEPT` with its reason. Both are asserted still there.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * A root: a file or a directory (repo-relative; tests left out), or one method of a file whose
 * other methods are later families' – the lines from the first `from` to the first `to` after
 * it, the rest of the file blanked so a stray's line number stays the file's.
 */
type Root = string | { file: string; region: string; from: RegExp; to: RegExp }

/**
 * The roots walked: a family's call sites once it has landed – the action tables first (PR-2:
 * the key table, the palette, the mac menu bar), then the app menu (PR-2b: `Menus.showAppMenu`,
 * one method of `menus.ts`, whose row menus are PR-3's, PR-4's and PR-8's).
 */
const SWEPT: readonly Root[] = [
  'src/shared/shortcuts.ts',
  'src/shared/commands.ts',
  'src/core/menuBar.ts',
  { file: 'src/core/menus.ts', region: 'showAppMenu', from: /^ {2}showAppMenu\(/, to: /^ {2}}$/ }
]

/** A root's name in the assertions: the path, with the region after `#` for a method. */
const rootName = (root: Root): string =>
  typeof root === 'string' ? root : `${root.file}#${root.region}`

/** The table's own modules: the one place its values are typed, never swept. */
const TABLE_DIR = 'src/shared/strings'

/**
 * Literals in a swept root that equal a table value or carry an ellipsis and are left for the
 * PR named: the file (repo-relative), the literal's text, the PR.
 */
const PENDING: ReadonlyArray<readonly [file: string, text: string, until: string]> = [
  // The Bookmarks menu's import and export rows: the bookmark menus' family (PR-8).
  ['src/core/menuBar.ts', 'Import Bookmarks and Settings…', 'PR-8'],
  ['src/core/menuBar.ts', 'Export Bookmarks…', 'PR-8'],
  // The Tab menu's folder row: the noun axis (P-11, PR-4).
  ['src/core/menuBar.ts', 'New Folder…', 'PR-4'],
  // The app menu's Share… row: `share.open`'s entry is the copy and share family's (PR-3).
  ['src/core/menus.ts', 'Share…', 'PR-3'],
  // The app menu's Bookmarks ▸ import and export rows (PR-8, with the menu bar's).
  ['src/core/menus.ts', 'Import Bookmarks…', 'PR-8'],
  ['src/core/menus.ts', 'Import Bookmarks and Settings…', 'PR-8'],
  ['src/core/menus.ts', 'Export Bookmarks…', 'PR-8'],
  // The app menu's two library rows say Chrome's app-menu words – the mac bar's faces of
  // `history.sidebar` and `downloads.open` – where the key table and the palette say "Show
  // History" and "Show Downloads"; no D7 pair names them, so they wait on the history and
  // downloads family (PR-8) and the root's ruling.
  ['src/core/menus.ts', 'Show Full History', 'PR-8'],
  ['src/core/menus.ts', 'Downloads', 'PR-8']
]

/**
 * Literals in a swept root that equal a table value or carry an ellipsis and stay as they are:
 * the file, the text, why. Not a label of the act the value names.
 */
const KEPT: ReadonlyArray<readonly [file: string, text: string, reason: string]> = [
  ['src/core/menuBar.ts', 'Find', "Chrome's Find ▸ parent of the Edit menu, not the act (§B)"],
  [
    'src/core/menuBar.ts',
    '${children.length - BOOKMARK_MENU_MAX} more…',
    'the count of bookmarks the menu leaves out, not an ask'
  ],
  // The Settings page's group headings over the key table, named for their feature.
  ['src/shared/shortcuts.ts', 'Compact Mode', "a shortcut group's heading, not the act's row"],
  ['src/shared/shortcuts.ts', 'Developer Tools', "a shortcut group's heading, not the act's row"]
]

/** Words a US-spelling rule would flag that are another sense or a name: the file, the text. */
const US_ALLOWED: ReadonlyArray<readonly [file: string, text: string]> = []

export interface Literal {
  file: string
  line: number
  text: string
  /** The line names a label: `label:`, `label=`, `title`, `helperLabel`, `aria-label`, … */
  label: boolean
  /** JSX text – prose between tags – rather than a quoted literal. */
  prose: boolean
}

const rel = (file: string): string => relative(repo, file).split('\\').join('/')

function walk(path: string): string[] {
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  const out: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'preview-assets') continue
    if (entry.name === 'node_modules') continue
    const full = join(path, entry.name)
    if (rel(full) === TABLE_DIR) continue
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

interface Source {
  file: string
  text: string
}

/** The sources a root yields: each file of a path with its text; a region's file with the rest blanked. */
function sourcesOf(root: Root): Source[] {
  if (typeof root === 'string')
    return walk(join(repo, root)).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
  const file = join(repo, root.file)
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => root.from.test(line))
  const end = lines.findIndex((line, i) => i > start && root.to.test(line))
  if (start < 0 || end < 0)
    throw new Error(`${root.file}: the region ${root.region} is not where the root says`)
  return [{ file, text: lines.map((line, i) => (i >= start && i <= end ? line : '')).join('\n') }]
}

/** A line that is a comment, a log or a thrown message: the words there are not the user's. */
const NOT_THE_USERS =
  /^\s*(\/\/|\/\*|\*|\{\/\*)|console\.\w+\(|\bLog\.\w\(|Exception\(|\berror\(|\brequire\(/

/** The quoted literals on one line (single-line template literals too). */
const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g

/** A line that names a label: the keys the extractor of the D7 inventory read. */
const LABEL_LINE =
  /(?:^|[\s,{(.])(?:label|title|helperLabel|subtitle|heading|confirmation|aria-label|data-tooltip)\s*[:=]/

/**
 * A `.tsx` line that is JSX text alone: prose between tags, on its own line – an HTML entity's
 * `&…;` allowed, a statement's keyword not (a `return out` in a component is code).
 */
const JSX_TEXT = /^\s*[A-Za-z][^<>{}'"`=()]*[a-z.!?…]\s*$/
const STATEMENT =
  /^\s*(return|const|let|var|if|else|for|while|do|import|export|throw|case|default|break|continue|yield|await|typeof|void|delete|new|function|class|switch|try|catch|finally)\b/

/** JSX text inside a one-line element: `<div className="…">This Space is empty</div>`. */
const INLINE_JSX_TEXT = />\s*([^<>{}]*?[A-Za-z][^<>{}]*?)\s*</g

export function literalsOf(file: string, source: string): Literal[] {
  const out: Literal[] = []
  // Block comments (`/* … */`, JSX's `{/* … */}`) blanked with their newlines kept: a continuation
  // line of plain prose is not the user's (read as JSX text otherwise). A `/*` inside a string
  // (`'http://*/*'`, `"image/*"`) follows a non-space character and is left alone.
  const lines = source
    .replace(/(?<=^|[\s{(,])\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
  lines.forEach((line, i) => {
    if (NOT_THE_USERS.test(line)) return
    const label = LABEL_LINE.test(line)
    for (const m of line.matchAll(QUOTED)) {
      const text = m[1] ?? m[2] ?? m[3] ?? ''
      if (text) out.push({ file, line: i + 1, text, label, prose: false })
    }
    if (!file.endsWith('.tsx')) return
    if (JSX_TEXT.test(line) && !STATEMENT.test(line))
      out.push({ file, line: i + 1, text: line.trim(), label, prose: true })
    for (const m of line.matchAll(INLINE_JSX_TEXT))
      out.push({ file, line: i + 1, text: m[1], label, prose: true })
  })
  return out
}

const TYPOGRAPHIC = /[\u2018\u2019\u201C\u201D]/

/** A dotted identifier on a label line – an act id (`'window.minimize'`), code rather than words. */
const DOTTED_ID = /^[a-z]\w*(?:\.\w+)+$/

/**
 * The US spellings a label must not carry: the `-ize` family (three letters before it, so
 * "size" and "prize" are not words of it; the `-size` compounds named apart), the `-yze` verbs,
 * and the listed words. "license" and "licenses" are the noun; "licensed" and "licensing" are the
 * verb, spelled so on both sides.
 */
const US_SPELLING =
  /\b([a-z]{3,}iz(?:e|es|ed|ing|er|ers|ation|ations)|[a-z]{2,}yz(?:e|es|ed|ing|er|ers)|colors?|colored|colorful|coloring|colorless|favorites?|favorited|centers?|centered|centering|grays?|grayed|grayish|licenses?|behaviors?|behavioral|canceled|canceling|catalogs?|cataloged|fulfills?|fulfilled|fulfilling|labeled|labeling|enrollment|honors?|honored|humor|neighbors?|neighborhood|flavors?)\b/i
const NOT_US =
  /^(?:re|cap|down|over|out|super|under|up|full|king|life|mid|bite|pint|half|pocket|plus)-?siz(?:e|es|ed|ing)$/i

/** The US spelling in a text, if any – `undefined` for a text with none. */
export function usSpelling(text: string): string | undefined {
  for (const m of text.matchAll(new RegExp(US_SPELLING.source, 'gi'))) {
    const word = m[1]
    if (!NOT_US.test(word)) return word
  }
  return undefined
}

export interface SweepRules {
  /** The table's values by their act, `tableValues()`. */
  values: ReadonlyMap<string, string>
  pending?: ReadonlyArray<readonly [file: string, text: string, until: string]>
  kept?: ReadonlyArray<readonly [file: string, text: string, reason: string]>
  usAllowed?: ReadonlyArray<readonly [file: string, text: string]>
}

export function strays(literals: Literal[], rules: SweepRules): string[] {
  const out: string[] = []
  const pending = rules.pending ?? []
  const kept = rules.kept ?? []
  const usAllowed = rules.usAllowed ?? []
  for (const { file, line, text, label, prose } of literals) {
    const at = rel(file)
    const where = `${at}:${line}: "${text}"`
    const left =
      pending.some(([f, t]) => f === at && t === text) ||
      kept.some(([f, t]) => f === at && t === text)
    const id = rules.values.get(text)
    if (id !== undefined && !left && (label || /\s/.test(text.trim())))
      out.push(
        `${where} – is the table's '${id}': read S.menu('${id}') (one label per act, §9 item 10)`
      )
    if (label && !prose && text.includes('…') && !left)
      out.push(`${where} – carries "…": the ask flag supplies the ellipsis, never a value (§C)`)
    if ((label || prose) && TYPOGRAPHIC.test(text))
      out.push(`${where} – a typographic quote: straight apostrophes and quotes (Q7)`)
    if ((label || prose) && !DOTTED_ID.test(text)) {
      const us = usSpelling(text)
      if (us !== undefined && !usAllowed.some(([f, t]) => f === at && t === text))
        out.push(`${where} – US spelling "${us}": British spelling (§9 item 10)`)
    }
  }
  return out
}

describe('the string table sweep (§9 item 10)', () => {
  const sources = SWEPT.flatMap(sourcesOf)
  const files = sources.map((s) => s.file)
  const literals = sources.flatMap((s) => literalsOf(s.file, s.text))
  const values = tableValues()

  it('sweeps the roots of the families that have landed: the action tables, the app menu', () => {
    expect(SWEPT.map(rootName)).toEqual([
      'src/shared/shortcuts.ts',
      'src/shared/commands.ts',
      'src/core/menuBar.ts',
      'src/core/menus.ts#showAppMenu'
    ])
    expect(files.map(rel)).toEqual([
      'src/shared/shortcuts.ts',
      'src/shared/commands.ts',
      'src/core/menuBar.ts',
      'src/core/menus.ts'
    ])
    expect(literals.length).toBeGreaterThan(100)
    expect(files.some((f) => rel(f).startsWith(`${TABLE_DIR}/`))).toBe(false)
    expect(files.some((f) => f.includes('__tests__') || /\.test\.tsx?$/.test(f))).toBe(false)
  })

  it('reads the app menu alone of menus.ts: the method, whole, and none of the row menus around it', () => {
    const region = sources.find((s) => rel(s.file) === 'src/core/menus.ts')!
    const lines = region.text.split('\n')
    const kept = lines.filter((line) => line !== '')
    // The method's head and its last line, the popup's close; the lines before and after blank.
    expect(kept[0]).toMatch(/^ {2}showAppMenu\(/)
    expect(kept[kept.length - 1]).toBe('  }')
    expect(kept.length).toBeGreaterThan(500)
    expect(lines.length).toBeGreaterThan(kept.length + 1000)
    expect(region.text).toContain("'app',")
    expect(region.text).not.toContain('showExtensionActionMenu(')
    expect(region.text).not.toContain('private managedRow(')
    // Line numbers are the file's: the region's first kept line is the method's line in the file.
    const file = readFileSync(region.file, 'utf8').split('\n')
    const at = lines.findIndex((line) => line !== '')
    expect(file[at]).toBe(kept[0])
    expect(literals.filter((l) => rel(l.file) === 'src/core/menus.ts').length).toBeGreaterThan(60)
  })

  it('carries no stray: no table value typed as a literal, no "…", no typographic quote, no US spelling', () => {
    expect(
      strays(literals, { values, pending: PENDING, kept: KEPT, usAllowed: US_ALLOWED })
    ).toEqual([])
  })

  it('names the literals it leaves to a later PR or keeps, each still in its file and one a rule would flag', () => {
    const exempt: ReadonlyArray<readonly [file: string, text: string, why: string]> = [
      ...PENDING.map(([file, text, until]) => [file, text, `left for ${until}`] as const),
      ...KEPT.map(([file, text, reason]) => [file, text, `kept: ${reason}`] as const)
    ]
    for (const [file, text, why] of exempt) {
      const found = literals.filter((l) => rel(l.file) === file && l.text === text)
      expect(
        found.length,
        `${file}: "${text}" (${why}) is no longer there – drop the exemption`
      ).toBeGreaterThan(0)
      // An exempt literal is one rule 1 or 2 would flag; one neither reads needs no entry.
      expect(
        strays(found, { values }),
        `${file}: "${text}" is flagged by no rule – drop the exemption`
      ).not.toEqual([])
    }
    for (const [file, text] of US_ALLOWED) {
      expect(
        literals.some((l) => rel(l.file) === file && l.text === text),
        `${file}: "${text}" is no longer there – drop the exemption`
      ).toBe(true)
    }
  })

  it("the table's own values: no ellipsis, no typographic quote, no US spelling, a sentence that differs", () => {
    for (const [id, entry] of tableEntries()) {
      const texts: Array<[string, string]> = [['menu', entry.menu]]
      if (entry.sentence !== undefined) texts.push(['sentence', entry.sentence])
      if (entry.state) texts.push(['state.on', entry.state.on], ['state.off', entry.state.off])
      if (entry.count)
        texts.push(['count.one', entry.count.one], ['count.other', entry.count.other])
      if (entry.noun)
        texts.push(['noun.folder', entry.noun.folder], ['noun.group', entry.noun.group])
      if (entry.orientation)
        texts.push(
          ['orientation.horizontal', entry.orientation.horizontal],
          ['orientation.vertical', entry.orientation.vertical]
        )
      if (entry.os)
        for (const [os, words] of Object.entries(entry.os))
          if (words !== undefined)
            texts.push([`os.${os}`, typeof words === 'string' ? words : words.menu])
      for (const [field, text] of texts) {
        const where = `${id}.${field} = "${text}"`
        expect(text.includes('…'), `${where} carries "…": set ask instead`).toBe(false)
        expect(TYPOGRAPHIC.test(text), `${where} carries a typographic quote (Q7)`).toBe(false)
        // A platform's face is its own spelling (Q4: the mac's Window ▸ "Minimize").
        if (!field.startsWith('os.'))
          expect(usSpelling(text), `${where} is spelled the US way`).toBeUndefined()
        expect(text, `${where} has a space at an end or two in a row`).toBe(text.trim())
        expect(/ {2}/.test(text), `${where} has two spaces in a row`).toBe(false)
        expect(text.length, `${where} is empty`).toBeGreaterThan(0)
      }
      if (entry.sentence !== undefined)
        expect(entry.sentence, `${id}.sentence is what sentence() derives – drop it`).not.toBe(
          sentence(entry.menu)
        )
      if (entry.state)
        expect(entry.state.on, `${id}.state: on and off are the same words`).not.toBe(
          entry.state.off
        )
      if (entry.count) expect(entry.count.other, `${id}.count.other has no {n}`).toContain('{n}')
      if (/\{noun\}/.test(entry.menu))
        expect(entry.noun, `${id} has a {noun} hole and no noun`).toBeDefined()
      expect(entry.menu, `${id}.menu starts in lower case`).toMatch(/^(?:[A-Z{]|\d)/)
    }
  })

  it('would catch the strays the rules name, and lets the rest through', () => {
    const file = join(repo, 'src/core/menuBar.ts')
    const tsx = join(repo, 'src/renderer/src/components/content/ContentArea.tsx')
    const fixture = new Map<string, string>([
      ['Copy Link', 'tab.copyUrl'],
      ['Copy link', 'tab.copyUrl'],
      ['Settings', 'settings.open'],
      ['Find', 'find.open'],
      ['Find in Page', 'find.open'],
      ['Find in Page…', 'find.open'],
      ['Find in page…', 'find.open'],
      ['Enter Full Screen', 'page.fullscreen']
    ])
    const flag = (snippet: string, at = file): string[] =>
      strays(literalsOf(at, snippet), { values: fixture })
    // Rule 1: a table value typed as a literal, in any position when it is more than one word.
    expect(flag("label: 'Copy Link',")).toHaveLength(1)
    expect(flag("const words = 'Copy Link'")).toHaveLength(1)
    expect(flag("label: 'Copy link',")).toHaveLength(1)
    expect(flag("{ label: 'Enter Full Screen', action: 'page.fullscreen' }")).toHaveLength(1)
    expect(flag('<button>Copy link</button>', tsx)).toHaveLength(1)
    expect(flag('      Copy link', tsx)).toHaveLength(1)
    expect(flag("label: 'Copy Link',")[0]).toContain("read S.menu('tab.copyUrl')")
    // A one-word value counts in a label position alone.
    expect(flag("label: 'Settings',")).toHaveLength(1)
    expect(flag("title: 'Settings',")).toHaveLength(1)
    expect(flag('aria-label="Settings"', tsx)).toHaveLength(1)
    expect(flag("case 'Settings':")).toEqual([])
    expect(flag("openPage('Settings')")).toEqual([])
    // Rule 2: an ellipsis typed in a label.
    expect(flag("label: 'Find in Page…',")).toHaveLength(2)
    expect(flag("label: 'Import Bookmarks…',")).toHaveLength(1)
    expect(flag("label: 'Import Bookmarks…',")[0]).toContain('the ask flag supplies the ellipsis')
    expect(flag("label: bookmarked ? 'Edit Bookmark…' : 'Bookmark This Tab…',")).toHaveLength(2)
    expect(flag("helperLabel: 'Name window…',")).toHaveLength(1)
    expect(flag('title="Share…"', tsx)).toHaveLength(1)
    expect(flag("placeholder: 'Search the web…',")).toEqual([])
    expect(flag("const ELLIPSIS = '…'")).toEqual([])
    // Rule 3: a typographic quote in a label or JSX text.
    expect(flag("label: 'What’s New',")).toHaveLength(1)
    expect(flag("label: 'Zenium’s shortcuts',")[0]).toContain('straight apostrophes')
    expect(flag('label: "“Smart” quotes",')).toHaveLength(1)
    expect(flag('      Zenium can’t open this page', tsx)).toHaveLength(1)
    expect(flag('label: "What\'s New",')).toEqual([])
    expect(flag("const note = 'the user’s own words'")).toEqual([])
    // Rule 4: a US spelling in a label or JSX text.
    expect(flag("label: 'Customize Toolbar',")).toHaveLength(1)
    expect(flag("label: 'Minimize Window',")[0]).toContain('US spelling "Minimize"')
    expect(flag("label: 'Synchronization',")).toHaveLength(1)
    expect(flag("label: 'Analyze Page',")).toHaveLength(1)
    expect(flag("label: 'Change Color',")).toHaveLength(1)
    expect(flag("label: 'Add to Favorites',")).toHaveLength(1)
    expect(flag("label: 'Center on Screen',")).toHaveLength(1)
    expect(flag("label: 'Gray Out',")).toHaveLength(1)
    expect(flag("label: 'Open Source Licenses',")).toHaveLength(1)
    expect(flag("label: 'View License',")).toHaveLength(1)
    expect(flag("title: 'Behavior',")).toHaveLength(1)
    expect(flag('      Choose a color for this Space', tsx)).toHaveLength(1)
    expect(flag("label: 'Customise Toolbar',")).toEqual([])
    expect(flag("label: 'Minimise Window',")).toEqual([])
    expect(flag("label: 'Synchronisation',")).toEqual([])
    expect(flag("label: 'Change Colour',")).toEqual([])
    expect(flag("label: 'Open Source Licences',")).toEqual([])
    expect(flag("label: 'Licensed under MIT',")).toEqual([])
    expect(flag("label: 'Resize Window',")).toEqual([])
    expect(flag("label: 'Actual Size',")).toEqual([])
    expect(flag("label: 'Prize Draw',")).toEqual([])
    expect(flag("label: 'Seize the Day',")).toEqual([])
    expect(flag("label: 'Horizon',")).toEqual([])
    expect(flag("label: 'Wizard',")).toEqual([])
    expect(flag("label: 'Centre',")).toEqual([])
    // A US spelling outside a label is code, not the user's words; so is an act id on one.
    expect(flag("className: 'text-center'")).toEqual([])
    expect(flag("const color = 'gray'")).toEqual([])
    expect(flag("style={{ color: 'gray' }}", tsx)).toEqual([])
    expect(flag("{ label: S.menu('window.minimize', { os }), action: 'window.minimize' }")).toEqual(
      []
    )
    expect(flag("label: 'window.minimize',")).toEqual([])
    // Code and comments, not prose.
    expect(flag("// label: 'Copy Link' used to be here")).toEqual([])
    expect(flag("console.log('Copy Link')")).toEqual([])
    expect(flag("action: 'tab.copyUrl'")).toEqual([])
    expect(flag("keywords: ['copy link', 'url']")).toEqual([])
    expect(flag('  return label')).toEqual([])
    // A pending or kept literal is let through for rules 1 and 2 alone, in its file alone.
    const pending = [['src/core/menuBar.ts', 'Find in Page…', 'PR-2b'] as const]
    expect(
      strays(literalsOf(file, "label: 'Find in Page…',"), { values: fixture, pending })
    ).toEqual([])
    expect(
      strays(literalsOf(file, "label: 'Find in Page…', title: 'Behavior'"), {
        values: fixture,
        pending
      })
    ).toHaveLength(1)
    const kept = [['src/core/menuBar.ts', 'Find', "Chrome's Find ▸ parent"] as const]
    expect(strays(literalsOf(file, "label: 'Find',"), { values: fixture, kept })).toEqual([])
    expect(strays(literalsOf(tsx, "label: 'Find',"), { values: fixture, kept })).toHaveLength(1)
    expect(
      strays(literalsOf(file, "label: 'Find', title: 'What’s New'"), { values: fixture, kept })
    ).toHaveLength(1)
    // An allowed US spelling is let through, in its file alone.
    const usAllowed = [['src/core/menuBar.ts', 'Help Center'] as const]
    expect(
      strays(literalsOf(file, "label: 'Help Center',"), { values: fixture, usAllowed })
    ).toEqual([])
    expect(
      strays(literalsOf(tsx, "label: 'Help Center',"), { values: fixture, usAllowed })
    ).toHaveLength(1)
  })

  it('the derived face of a protected word is read as a value too', () => {
    // The fixture above holds "Copy link" by hand; the table lists the derived face of every
    // entry, so `sentence()`'s protected words are what the sweep compares against.
    expect(sentence('Jump to the Next Space')).toBe('Jump to the next Space')
    expect(PROTECTED.has('Space')).toBe(true)
  })
})

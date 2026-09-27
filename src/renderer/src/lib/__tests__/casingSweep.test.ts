import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The §9.1 casing sweep of the desktop-owned and desktop-shared strings (W8-10; the lead's
 * ruling of 2026-09-27 04:42 under W6-S14, which Android's `casingSweep.test.ts` applies to its
 * own files): 'Space' – the coined Zenium sense – keeps its capital in any position ("Create
 * Space", "This Space is empty", "Move these tabs to a Space…"). The word in its other senses
 * – storage space, the space character – stays lower-case and is named below, one entry per
 * literal, so a new stray cannot hide behind an old exemption.
 *
 * The desktop's files speak two registers (§9.1): Title Case for menu items ("Open Link in
 * Split View", `src/core/menus.ts`) and sentence case elsewhere ("Open a new empty split view"),
 * so 'split view' is not swept here – Android's rule for it is its own files'. Swept: the
 * renderer minus the Android-owned components and sheets Android's sweep reads, the core minus
 * the agents' MCP tool text (`src/core/agent`: descriptions and results an agent client reads,
 * not the chrome's words), the shared modules and the main process.
 */

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The roots walked (tests left out). */
const SWEPT = ['src/renderer/src', 'src/core', 'src/shared', 'src/main']

/**
 * Android's files under the roots above, swept by `src/android/__tests__/casingSweep.test.ts`
 * with its own rules (the phone and tablet components, the sheets mounted for every host but
 * drawn only where the desktop's capabilities say no), and the agents' tool text.
 */
const NOT_SWEPT = [
  'src/renderer/src/components/phone',
  'src/renderer/src/components/tablet',
  'src/renderer/src/components/overlays/PhoneOnboarding.tsx',
  'src/renderer/src/components/overlays/PhoneSearchChoice.tsx',
  'src/renderer/src/components/voice/VoiceSearchSheet.tsx',
  'src/renderer/src/components/share/SharePanelSheet.tsx',
  'src/renderer/src/components/protocol/ExternalProtocolSheet.tsx',
  'src/renderer/src/components/pdf/PdfSheets.tsx',
  'src/renderer/src/components/newtab/CustomizeSheet.tsx',
  'src/core/agent'
]

/**
 * Words that are "space" in another sense than Zenium's: storage and free space, the character.
 * Each entry is the file (repo-relative) and the literal's text.
 */
const OTHER_SENSES: ReadonlyArray<readonly [file: string, text: string]> = [
  ['src/renderer/src/components/pages/settings/blocks.tsx', 'then a space, to search'],
  ['src/renderer/src/lib/downloadsView.ts', 'Out of storage space'],
  ['src/shared/downloads.ts', 'Out of storage space'],
  ['src/renderer/src/lib/spellcheckWords.ts', 'Enter one word without spaces'],
  ['src/shared/search.ts', 'A shortcut is one word, with no spaces']
]

interface Literal {
  file: string
  line: number
  text: string
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
    if (NOT_SWEPT.includes(rel(full))) continue
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** A line that is a comment, a log or a thrown message: the words there are not the user's. */
const NOT_THE_USERS =
  /^\s*(\/\/|\/\*|\*|\{\/\*)|console\.\w+\(|\bLog\.\w\(|Exception\(|\berror\(|\brequire\(/

/** The quoted literals on one line (single-line template literals too). */
const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g

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
    for (const m of line.matchAll(QUOTED)) {
      const text = m[1] ?? m[2] ?? m[3] ?? ''
      if (text) out.push({ file, line: i + 1, text })
    }
    if (!file.endsWith('.tsx')) return
    if (JSX_TEXT.test(line) && !STATEMENT.test(line))
      out.push({ file, line: i + 1, text: line.trim() })
    for (const m of line.matchAll(INLINE_JSX_TEXT)) out.push({ file, line: i + 1, text: m[1] })
  })
  return out
}

/**
 * The word 'space' or 'spaces' as prose: not `space.id`, `space-editor`, `data-space-target`,
 * `spaceId`, `${space}` or the CSS `space-between` – a word standing in text.
 */
const SPACE_AS_PROSE = /(?<![\w.$\-{`'"/])spaces?(?![\w\-.[(?=:`'"/])/

export function strays(literals: Literal[]): string[] {
  const out: string[] = []
  for (const { file, line, text } of literals) {
    // A literal of one word is an identifier (`'space'`, `'spaces'`, a type's key), not prose.
    if (!/\s/.test(text.trim())) continue
    // A template's holes are code (`${spaceLabel(space)} Space`): the words around them are read.
    const prose = text.replace(/\$\{[^}]*\}/g, ' ')
    const at = rel(file)
    const other = OTHER_SENSES.some(([f, t]) => f === at && text.includes(t))
    if (!other && SPACE_AS_PROSE.test(prose))
      out.push(`${at}:${line}: "${text}" – 'Space' keeps its capital in any position (§9.1)`)
  }
  return out
}

describe('the §9.1 casing sweep of the desktop-owned and desktop-shared strings (W8-10)', () => {
  const files = SWEPT.flatMap((p) => walk(join(repo, p)))
  const literals = files.flatMap((f) => literalsOf(f, readFileSync(f, 'utf8')))

  it('reads the swept files – the renderer, the core, the shared modules, the main process – and leaves Android’s and the agents’ to theirs', () => {
    const names = files.map(rel)
    expect(names).toContain('src/renderer/src/components/pages/settings/sections.tsx')
    expect(names).toContain('src/renderer/src/components/overlays/SpaceEditor.tsx')
    expect(names).toContain('src/renderer/src/components/content/ContentArea.tsx')
    expect(names).toContain('src/renderer/src/lib/newTabSettings.ts')
    expect(names).toContain('src/core/browser.ts')
    expect(names).toContain('src/core/suggestions.ts')
    expect(names).toContain('src/shared/toolbarPins.ts')
    expect(names).toContain('src/main/platform/menuMnemonics.ts')
    expect(names).not.toContain('src/renderer/src/components/phone/SpacesDrawer.tsx')
    expect(names).not.toContain('src/renderer/src/components/overlays/PhoneOnboarding.tsx')
    expect(names.some((f) => f.startsWith('src/renderer/src/components/tablet/'))).toBe(false)
    expect(names.some((f) => f.startsWith('src/core/agent/'))).toBe(false)
    expect(names.some((f) => f.includes('__tests__') || /\.test\.tsx?$/.test(f))).toBe(false)
    // The extractor finds the words: a broken read would pass an empty sweep.
    expect(literals.length).toBeGreaterThan(5000)
    expect(
      literals.some((l) => l.file.endsWith('ContentArea.tsx') && l.text === 'This Space is empty')
    ).toBe(true)
    expect(
      literals.some((l) => l.file.endsWith('suggestions.ts') && l.text === 'Switch to Space')
    ).toBe(true)
  })

  it("carries no stray: 'Space' capitalised in any position", () => {
    expect(strays(literals)).toEqual([])
  })

  it('names the other senses of the word it lets through, each still in its file', () => {
    for (const [file, text] of OTHER_SENSES) {
      expect(
        literals.some((l) => rel(l.file) === file && l.text.includes(text)),
        `${file}: "${text}" is no longer there – drop the exemption`
      ).toBe(true)
    }
  })

  it('would catch the strays the sweep fixed, and lets the register through', () => {
    const file = join(repo, 'src/renderer/src/components/overlays/SpaceEditor.tsx')
    const flag = (snippet: string): string[] => strays(literalsOf(file, snippet))
    // The strays swept in W8-10, in the forms they stood in (the omnibox line carried two).
    expect(
      flag("subtitle: s.id === win.activeSpaceId ? 'Current space' : 'Switch to space',")
    ).toHaveLength(2)
    expect(
      flag('const s = `${count} tabs in this space will be closed. Essentials are kept.`')
    ).toHaveLength(1)
    expect(
      flag('      <div className="text-lg font-medium">This space is empty</div>')
    ).toHaveLength(1)
    expect(
      flag(
        '            New tabs in this space open in the container&apos;s isolated cookie session.'
      )
    ).toHaveLength(1)
    expect(flag('              Delete space')).toHaveLength(1)
    expect(
      flag("<Button type=\"submit\">{existing ? 'Save' : 'Create space'}</Button>")
    ).toHaveLength(1)
    expect(flag('          aria-label="Move these tabs to a space…"')).toHaveLength(1)
    expect(flag('    return <div className="px-2">No spaces</div>')).toHaveLength(1)
    expect(
      flag("    text: 'Keep spaces, folders and pinned tabs identical on every computer.'")
    ).toHaveLength(1)
    expect(flag("  focused: 'The search field and the tiles on the space gradient',")).toHaveLength(
      1
    )
    expect(flag('      description={`${spaceLabel(space)} space`}')).toHaveLength(1)
    // The register (a template's hole is code – its `(space)` argument is not the word).
    expect(flag('      description={`${spaceLabel(space)} Space`}')).toEqual([])
    expect(flag("subtitle: 'Switch to Space'")).toEqual([])
    expect(flag('              Delete Space')).toEqual([])
    expect(flag('<div>This Space is empty</div>')).toEqual([])
    expect(flag("label: 'Jump to the next Space'")).toEqual([])
    // Code, not prose: identifiers, class names, data hooks, the CSS keyword, a log line, a
    // statement that happens to read like a sentence.
    expect(flag("run('space.activate', { spaceId: space.id })")).toEqual([])
    expect(flag("openOverlay('space-editor', null)")).toEqual([])
    expect(flag('className="zen-overview-space relative"')).toEqual([])
    expect(flag("'data-space-target'")).toEqual([])
    expect(flag('`.row{justify-content:space-between}`')).toEqual([])
    expect(flag("console.debug('[zen] the space is empty again')")).toEqual([])
    expect(flag('  return space')).toEqual([])
    expect(flag('  const empty = space')).toEqual([])
    // A JSX comment's continuation line of plain prose is not the user's; the same line alone is
    // JSX text (the control: the blanking is what lets the comment through). A `/*` inside a
    // string opens no comment, so the literal after it is still read.
    const comment = [
      '      {/* The loose rows are the list (lib/drag.ts): the rows are its children,',
      '          and the empty space under the panel is its tail. With no rows',
      '          there is no list (an empty one would take the gap). */}',
      '      <Row label="Move to the next Space" />'
    ]
    expect(flag(comment.join('\n'))).toEqual([])
    expect(flag(comment[1])).toHaveLength(1)
    expect(
      flag("const all = ['http://*/*', 'https://*/*']\nconst t = 'Open in a new space'")
    ).toHaveLength(1)
    // The other senses stand only in their files.
    const search = join(repo, 'src/shared/search.ts')
    expect(strays(literalsOf(search, "'A shortcut is one word, with no spaces'"))).toEqual([])
    expect(flag("'A shortcut is one word, with no spaces'")).toHaveLength(1)
  })
})

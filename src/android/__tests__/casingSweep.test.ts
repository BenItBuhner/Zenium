import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The §9.1 casing sweep of the Android-owned strings (the lead's ruling of 2026-09-27 04:42,
 * W6-S14): 'Space' – the coined Zenium sense – keeps its capital in any position ("New Space",
 * "Create new Space", "Jump to the next Space"); 'split view' is a common noun written
 * lower-case in the sentence-case register these files speak ("Toggle split view grid", "Open a
 * new empty split view"). The Title Case register (app-menu and context-menu items: "Open Link
 * in Split View") lives in `src/core/menus.ts` as descriptor data, a desktop-shared file outside
 * this sweep, so in the files swept here a "Split View" anywhere but at a sentence's start is a
 * stray. Desktop-shared files are the desktop program's and are not swept: the audit reads the
 * phone and tablet components, the Android chrome under `src/android`, the app's string
 * resources and the Kotlin literals.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * The Android-owned roots and files the sweep reads (directories walked, tests left out). The
 * sheets outside `components/phone` are here by their gates: each is mounted for every host by
 * `Root.tsx` or `ContentArea.tsx` but drawn only where the desktop's `HostCapabilities`
 * (`src/main/platform/index.ts`) say no – `voiceSearch: false`, `sharePanel: false`,
 * `pdfViewer: false` – or where the desktop has no host at all (no `ExternalProtocolHost` under
 * `src/main`; the phone's new tab page alone carries the customise gear). `menus/MenuSheet.tsx`
 * is NOT here: the desktop's "⋯" app menu is drawn by the renderer through the same
 * `RendererMenuHost` (`src/main/platform/menus.ts`), so its words are desktop-shared.
 */
const SWEPT = [
  'src/android',
  'src/renderer/src/components/phone',
  'src/renderer/src/components/tablet',
  'src/renderer/src/components/overlays/PhoneOnboarding.tsx',
  'src/renderer/src/components/overlays/PhoneSearchChoice.tsx',
  'src/renderer/src/components/voice/VoiceSearchSheet.tsx',
  'src/renderer/src/components/share/SharePanelSheet.tsx',
  'src/renderer/src/components/protocol/ExternalProtocolSheet.tsx',
  'src/renderer/src/components/pdf/PdfSheets.tsx',
  'src/renderer/src/components/newtab/CustomizeSheet.tsx',
  'android/app/src/main/res/values/strings.xml',
  'android/app/src/main/kotlin'
]

/**
 * Words that are "space" in another sense than Zenium's: storage and free space, the character.
 * Each entry is the file (repo-relative) and the literal's text, so a new stray cannot hide
 * behind an old exemption.
 */
const OTHER_SENSES: ReadonlyArray<readonly [file: string, text: string]> = [
  ['android/app/src/main/kotlin/app/zen/chromium/DownloadLogic.kt', 'Out of storage space'],
  ['android/app/src/main/kotlin/app/zen/chromium/DownloadLogic.kt', 'No space']
]

interface Literal {
  file: string
  line: number
  text: string
}

function walk(path: string): string[] {
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  const out: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'preview-assets') continue
    if (entry.name === 'node_modules') continue
    const full = join(path, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|kt|xml)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(full)
  }
  return out
}

/** A line that is a comment, a log or a thrown message: the words there are not the user's. */
const NOT_THE_USERS =
  /^\s*(\/\/|\/\*|\*|\{\/\*)|console\.\w+\(|\bLog\.\w\(|println\(|Exception\(|\berror\(|\brequire\(|\bcheck\(/

/** The quoted literals on one line of TypeScript or Kotlin (single-line template literals too). */
const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g

/** A `.tsx` line that is JSX text alone: prose between tags, on its own line. */
const JSX_TEXT = /^\s*[A-Za-z][^<>{}'"`=;()]*[a-z.!?…]\s*$/

export function literalsOf(file: string, source: string): Literal[] {
  const out: Literal[] = []
  // Block comments (`/* … */`, JSX's `{/* … */}`) blanked with their newlines kept: a continuation
  // line of plain prose is not the user's (read as JSX text otherwise). A `/*` inside a string
  // (`'http://*/*'`, `"image/*"`) follows a non-space character and is left alone.
  const lines = source
    .replace(/(?<=^|[\s{(,])\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
  if (file.endsWith('.xml')) {
    lines.forEach((line, i) => {
      const m = /<string\b[^>]*>([^<]*)<\/string>/.exec(line)
      if (m) out.push({ file, line: i + 1, text: m[1] })
    })
    return out
  }
  lines.forEach((line, i) => {
    if (NOT_THE_USERS.test(line)) return
    for (const m of line.matchAll(QUOTED)) {
      const text = m[1] ?? m[2] ?? m[3] ?? ''
      if (text) out.push({ file, line: i + 1, text })
    }
    if (file.endsWith('.tsx') && JSX_TEXT.test(line))
      out.push({ file, line: i + 1, text: line.trim() })
  })
  return out
}

/**
 * The word 'space' or 'spaces' as prose: not `space.id`, `space-editor`, `data-space-target`,
 * `spaceId`, `${space}` or the CSS `space-between` – a word standing in text.
 */
const SPACE_AS_PROSE = /(?<![\w.$\-{`'"/])spaces?(?![\w\-.[(?=:`'"/])/

/** 'Split View' or 'Split view' anywhere but as the literal's first words; 'split View' anywhere. */
const SPLIT_VIEW_CAPITALISED = /(?<!^)(?<=\S.*)\bSplit [Vv]iew\b|\bsplit View\b/

export function strays(literals: Literal[]): string[] {
  const out: string[] = []
  for (const { file, line, text } of literals) {
    // A literal of one word is an identifier (`'space'`, `'spaces'`, a type's key), not prose.
    if (!/\s/.test(text.trim())) continue
    const rel = relative(repo, file).split('\\').join('/')
    const other = OTHER_SENSES.some(([f, t]) => f === rel && text.includes(t))
    if (!other && SPACE_AS_PROSE.test(text))
      out.push(`${rel}:${line}: "${text}" – 'Space' keeps its capital in any position (§9.1)`)
    if (SPLIT_VIEW_CAPITALISED.test(text))
      out.push(`${rel}:${line}: "${text}" – 'split view' is a common noun, lower-case (§9.1)`)
  }
  return out
}

describe('the §9.1 casing sweep of the Android-owned strings (W6-S14)', () => {
  const files = SWEPT.flatMap((p) => walk(join(repo, p)))
  const literals = files.flatMap((f) => literalsOf(f, readFileSync(f, 'utf8')))

  it('reads the swept files: the phone components, the tablet components, the Android chrome, the resources and the Kotlin', () => {
    const rel = files.map((f) => relative(repo, f).split('\\').join('/'))
    expect(rel).toContain('src/renderer/src/components/phone/SpacesDrawer.tsx')
    expect(rel).toContain('src/renderer/src/components/voice/VoiceSearchSheet.tsx')
    expect(rel).toContain('src/renderer/src/components/pdf/PdfSheets.tsx')
    expect(rel).not.toContain('src/renderer/src/components/menus/MenuSheet.tsx')
    expect(rel).toContain('src/android/nativeTheme.ts')
    expect(rel).toContain('android/app/src/main/res/values/strings.xml')
    expect(rel.some((f) => f.startsWith('android/app/src/main/kotlin/') && f.endsWith('.kt'))).toBe(
      true
    )
    expect(rel.some((f) => f.includes('__tests__') || /\.test\.tsx?$/.test(f))).toBe(false)
    // The extractor finds the words: a broken read would pass an empty sweep.
    expect(literals.length).toBeGreaterThan(1000)
    expect(
      literals.some((l) => l.file.endsWith('SpacesDrawer.tsx') && l.text === 'New Space')
    ).toBe(true)
  })

  it("carries no stray: 'Space' capitalised in any position, 'split view' lower-case", () => {
    expect(strays(literals)).toEqual([])
  })

  it('names the other senses of the word it lets through, each still in its file', () => {
    for (const [file, text] of OTHER_SENSES) {
      const rel = file
      expect(
        literals.some(
          (l) => relative(repo, l.file).split('\\').join('/') === rel && l.text.includes(text)
        ),
        `${rel}: "${text}" is no longer there – drop the exemption`
      ).toBe(true)
    }
  })

  it('would catch the strays the sweep fixed, and lets the register through', () => {
    const file = join(repo, 'src/renderer/src/components/phone/SpacesDrawer.tsx')
    const flag = (snippet: string): string[] => strays(literalsOf(file, snippet))
    expect(flag('aria-label="New space"')).toHaveLength(1)
    expect(flag("label: 'Switch to space'")).toHaveLength(1)
    expect(flag('const s = `${count} tabs in this space will be closed.`')).toHaveLength(1)
    expect(flag("toast('Toggle Split View grid')")).toHaveLength(1)
    expect(flag('data-tooltip="Open as Split view"')).toHaveLength(1)
    expect(flag("tooltip('Open in split View')")).toHaveLength(1)
    expect(flag('aria-label="New Space"')).toEqual([])
    expect(flag("label: 'Jump to the next Space'")).toEqual([])
    expect(flag("title: 'Split view, pane 1 of 2'")).toEqual([])
    expect(flag("toast('Open a new empty split view')")).toEqual([])
    // Code, not prose: identifiers, class names, data hooks, the CSS keyword, a log line.
    expect(flag("run('space.activate', { spaceId: space.id })")).toEqual([])
    expect(flag("openOverlay('space-editor', null)")).toEqual([])
    expect(flag('className="zen-overview-space relative"')).toEqual([])
    expect(flag("'data-space-target'")).toEqual([])
    expect(flag('`.row{justify-content:space-between}`')).toEqual([])
    expect(flag("console.debug('[zen] the space is empty again')")).toEqual([])
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
    // Kotlin and the resources.
    const kt = join(repo, 'android/app/src/main/kotlin/app/zen/chromium/Host.kt')
    expect(strays(literalsOf(kt, 'toast("Moved to the new space")'))).toHaveLength(1)
    expect(strays(literalsOf(kt, 'Log.d(TAG, "the space changed")'))).toEqual([])
    const xml = join(repo, 'android/app/src/main/res/values/strings.xml')
    expect(strays(literalsOf(xml, '<string name="x">Open in a split view</string>'))).toEqual([])
    expect(strays(literalsOf(xml, '<string name="x">Add a Split View</string>'))).toHaveLength(1)
  })
})

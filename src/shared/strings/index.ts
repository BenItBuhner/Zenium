import { touchLayout } from '../formFactor'
import type { FormFactor, Platform } from '../types'
import { ACTIONS } from './actions'
import type { ActId } from './acts'
import { APP_MENU } from './appMenu'
import { COPY_SHARE } from './copyShare'
import type { Noun, NounWords } from './nouns'

export type { ActId, MenuAct, PaletteAct } from './acts'
export type { Noun, NounWords } from './nouns'

/**
 * The string table (spec §9 item 10; the D7 proposal §C): every user-facing label lives once,
 * keyed by act id, one label per act on every host, British spelling, an ellipsis only where
 * an ask follows. The four action tables (`shortcuts.ts`, `commands.ts`, `menuBar.ts`, the app
 * menu) and the renderer's rows, buttons and titles read the same entry through `S`, so a
 * surface cannot invent a word; §9.1's two registers are two FACES of one entry – the menu's
 * Title Case and the derived sentence case – never two typed strings.
 *
 * The table is one key space split into per-family modules (`actions.ts`, `appMenu.ts`,
 * `tabsFolders.ts`, `copyShare.ts`, …) merged here; a family lands with its call sites and its
 * sweep root (`src/shared/__tests__/stringTableSweep.test.ts`), one PR each (§D). `TableId` is
 * the acts the table names so far and becomes `Record<ActId, Entry>` when the last family lands.
 */

/** The strip's orientation axis (P-34): a horizontal strip says Right and Left, a vertical one Below and Above. */
export type Orientation = 'horizontal' | 'vertical'

/**
 * A platform's own face for one entry (Q4): the words, and whether an ask follows them there.
 * The mac menu bar's standard items take Apple's words – "Settings…" where the house label is
 * "Settings", Window ▸ "Minimize", Edit ▸ Find ▸ "Find…".
 */
export interface OsFace {
  menu: string
  ask?: true
}

export interface Entry {
  /** Title Case: menu rows, the palette, the shortcut reference, the mac menu bar. */
  menu: string
  /**
   * The sentence face, only where `sentence()` cannot derive it from `menu` ("Open the screenshot
   * overlay" for "Screenshot…", "Pin or unpin tab" for "Pin / Unpin Tab"). Read for the plain
   * `menu` face alone: an axis's words are always derived.
   */
  sentence?: string
  /**
   * A §5 ask follows – a dialog, sheet, popover or chooser that needs more input before the act
   * completes. `S.menu` and `S.row` append "…"; `S.button` and `S.title` do not (P-5, P-39). The
   * character is never typed in a value: a value carrying one fails the sweep.
   */
  ask?: true
  /**
   * The one per-host axis (TABLET-22): the desktop says Folder, the touch hosts Group. The side's
   * word fills `{noun}` in the face – "Add Tab to New {noun}" – or is the whole face where the
   * sides share no words ("Unpack Folder" / "Ungroup": `menu: '{noun}'`). `nounFor(formFactor)`
   * picks the side; a caller with none reads the desktop's, as `newFolderName` does.
   */
  noun?: NounWords
  /**
   * The words while the state the act toggles is ON – the row turns it off: "Exit Full Screen",
   * "Unpin Tab", "Unmute Site" – and while it is OFF: "Enter Full Screen", "Pin Tab", "Mute
   * Site". Read when the context says which (`state: boolean`); `menu` is the row that does not
   * know ("Full Screen", "Pin / Unpin Tab").
   */
  state?: { on: string; off: string }
  /**
   * A counted row. Usually "{n}" inside: "Put 1 Tab to Sleep" / "Put {n} Tabs to Sleep". A
   * word-only plural has no `{n}` when the surface says the plural, not a number ("Copy Link
   * Address" / "Copy Link Addresses"). `plural()` picks.
   */
  count?: { one: string; other: string }
  /**
   * The platform's own words where its convention differs from the house label (Q4). A string
   * keeps the entry's `ask` ("Find" under the mac's Find ▸ parent, still an ask); an `OsFace`
   * states its own ("Settings…" where the house "Settings" takes none).
   */
  os?: Partial<Record<Platform, string | OsFace>>
  /** The strip's orientation words (P-34): "New Tab to the Right" / "New Tab Below". */
  orientation?: { horizontal: string; vertical: string }
}

/** What a face is read for: the host's noun, the state's side, the count, the platform, the strip's orientation. */
export interface Ctx {
  noun?: Noun
  /** Whether the state the act toggles is on now (`state.on` is read: the row turns it off). */
  state?: boolean
  n?: number
  os?: Platform
  orientation?: Orientation
}

/** The four faces: the menu's Title Case; a row's, a button's and a title's sentence case. */
export type Face = 'menu' | 'row' | 'button' | 'title'

const ELLIPSIS = '…'

/**
 * The words `sentence()` keeps capitalised after the first (§9.1): the coined senses, proper
 * nouns, acronyms and key names. A hyphenated name is one word ("Picture-in-Picture"). The
 * phrases below keep part of their capitals ("New Tab page", "Home screen", "Live Folder").
 * Common nouns are not here and go lower-case: compact mode, split view, container, workspace,
 * tab group, reader view, bookmarks bar (§9.1 v2; P-45).
 */
export const PROTECTED: ReadonlySet<string> = new Set([
  // Coined senses.
  'Space',
  'Spaces',
  'Essentials',
  'Glance',
  'Boost',
  'Boosts',
  'Mod',
  'Mods',
  'Zenium',
  // Proper nouns.
  'Chrome',
  'Google',
  'Android',
  'Windows',
  'Markdown',
  'JavaScript',
  // Acronyms.
  'URL',
  'URLs',
  'PDF',
  'HTML',
  'CPU',
  'QR',
  'PIN',
  'MCP',
  // Key names.
  'Ctrl',
  'Alt',
  'Esc',
  'Enter',
  'Shift',
  // Hyphenated names.
  'Picture-in-Picture'
])

/**
 * Phrases whose sentence form keeps some capitals: the menu's words, then the sentence's. Matched
 * anywhere in the label, the first word included ("New Tab Page" → "New Tab page").
 */
const PHRASES: ReadonlyArray<readonly [menu: string, sentence: string]> = [
  ['New Tab Page', 'New Tab page'],
  ['Home Screen', 'Home screen'],
  ['Live Folder', 'Live Folder'],
  ['Live Group', 'Live Group']
]

/** The letters of a word, without the punctuation around it and a possessive's `'s`. */
const CORE = /^[^A-Za-z{]*([A-Za-z][A-Za-z-]*?)(?:'s)?[^A-Za-z]*$/

/**
 * The sentence face of a Title Case label (§9.1): every word after the first lower-cased except
 * the `PROTECTED` ones and the `PHRASES`. "Copy Current URL as Markdown" → "Copy current URL as
 * Markdown"; "Jump to the Next Space" → "Jump to the next Space"; "Toggle Split View Grid" →
 * "Toggle split view grid". A `{placeholder}` is left as it is.
 */
export function sentence(label: string): string {
  const words = label.split(' ')
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const phrase = PHRASES.find(([menu]) => {
      const parts = menu.split(' ')
      return parts.every((part, k) => words[i + k] === part)
    })
    if (phrase) {
      out.push(phrase[1])
      i += phrase[0].split(' ').length - 1
      continue
    }
    const word = words[i]
    if (i === 0 || word.startsWith('{')) {
      out.push(word)
      continue
    }
    const core = CORE.exec(word)?.[1]
    out.push(core !== undefined && PROTECTED.has(core) ? word : word.toLowerCase())
  }
  return out.join(' ')
}

/** The `{name}` holes of a template, as a union of their names. */
type Holes<T extends string> = T extends `${string}{${infer K}}${infer Rest}`
  ? K | Holes<Rest>
  : never

/**
 * The values a template takes: one per hole when the template is known at compile time, any
 * when it is a `string` read from the table.
 */
type Values<T extends string> = [Holes<T>] extends [never]
  ? Readonly<Record<string, string | number>>
  : { readonly [K in Holes<T>]: string | number }

/**
 * A template's `{name}` holes filled: `fill('Add {n} Tabs to {noun}', { n: 3, noun: 'Folder' })`.
 * Values are plain strings with holes, never template literals, so a `{name}` maps one-to-one
 * onto Android's `%1$s` by position and a Kotlin twin can compare the two tables. A hole with no
 * value is left as typed – visible in review, never thrown over.
 */
export function fill<T extends string>(template: T, values: Values<T>): string {
  const given = values as Readonly<Record<string, string | number | undefined>>
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => {
    const value = given[name]
    return value === undefined ? hole : String(value)
  })
}

/** The counted face: `one` for a count of 1, `other` else, `{n}` filled. */
export function plural(count: { one: string; other: string }, n: number): string {
  return fill(n === 1 ? count.one : count.other, { n })
}

/** The side of the noun axis the host `formFactor` draws: the touch hosts' Group, else Folder. */
export function nounFor(formFactor: FormFactor | undefined): Noun {
  return formFactor !== undefined && touchLayout(formFactor) ? 'group' : 'folder'
}

/** The words of an entry for a context, before the face's case and ellipsis are applied. */
function wordsOf(entry: Entry, ctx: Ctx): { text: string; ask: boolean; derived: boolean } {
  const os = ctx.os !== undefined ? entry.os?.[ctx.os] : undefined
  if (os !== undefined) {
    return typeof os === 'string'
      ? { text: os, ask: entry.ask === true, derived: true }
      : { text: os.menu, ask: os.ask === true, derived: true }
  }
  let text = entry.menu
  let derived = false
  if (entry.state && ctx.state !== undefined) {
    text = ctx.state ? entry.state.on : entry.state.off
    derived = true
  } else if (entry.count && ctx.n !== undefined) {
    text = ctx.n === 1 ? entry.count.one : entry.count.other
    derived = true
  } else if (entry.orientation && ctx.orientation !== undefined) {
    text = entry.orientation[ctx.orientation]
    derived = true
  }
  const values: Record<string, string | number> = {}
  if (ctx.n !== undefined) values.n = ctx.n
  if (entry.noun) values.noun = entry.noun[ctx.noun ?? 'folder']
  return { text: fill(text, values), ask: entry.ask === true, derived }
}

/**
 * One face of an entry: the menu's Title Case with the ask's ellipsis; a row's sentence case
 * with it; a button's and a title's sentence case without (P-5: the "Share…" row, the "Share"
 * button; P-39: the "Delete browsing data…" row, the "Delete browsing data" title). The explicit
 * `sentence` is read for the plain `menu` words alone.
 */
export function face(entry: Entry, kind: Face, ctx: Ctx = {}): string {
  const { text, ask, derived } = wordsOf(entry, ctx)
  const words =
    kind === 'menu'
      ? text
      : !derived && entry.sentence !== undefined
        ? entry.sentence
        : sentence(text)
  return ask && (kind === 'menu' || kind === 'row') ? words + ELLIPSIS : words
}

/**
 * The families merged (§C): each adds its module here as it lands (§D) – `actions.ts`, the
 * action tables, first; `appMenu.ts`, the ⋯ menu's own acts, second; `copyShare.ts`, the
 * copy-and-share family's first slice, third (PR-3a). `satisfies` over each family proves
 * every key is an act and every value an entry; the keys are disjoint by construction
 * (one family per act).
 */
const TABLE = { ...ACTIONS, ...APP_MENU, ...COPY_SHARE } satisfies Partial<Record<ActId, Entry>>

/** The acts the table names so far: `Record<ActId, Entry>` when the last family lands. */
export type TableId = keyof typeof TABLE

/** The entry of an act. Every id is a key of the merged table, so the lookup cannot miss. */
export function entryOf(id: TableId): Entry {
  return TABLE[id]
}

/**
 * The lookup every surface reads: `S.menu('tab.copyUrl')` → "Copy Link"; `S.row('share.open')`
 * → "Share…"; `S.button('share.open')` → "Share"; `S.title('bookmark.allTabs')` → "Bookmark all
 * tabs"; `S.menu('page.fullscreen', { state: true })` → "Exit Full Screen";
 * `S.menu('folder.edit', { noun: nounFor(win.formFactor) })` → "Edit Folder…" / "Edit Group…".
 */
export const S = {
  menu: (id: TableId, ctx?: Ctx): string => face(entryOf(id), 'menu', ctx),
  row: (id: TableId, ctx?: Ctx): string => face(entryOf(id), 'row', ctx),
  button: (id: TableId, ctx?: Ctx): string => face(entryOf(id), 'button', ctx),
  title: (id: TableId, ctx?: Ctx): string => face(entryOf(id), 'title', ctx)
}

/**
 * Every word of the table a literal elsewhere must not repeat (the sweep's rule): each face of
 * each entry – the menu's and the derived sentence, with and without the ellipsis – and every
 * axis's words, filled per side of the noun axis.
 */
export function tableValues(): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const [id, entry] of Object.entries(TABLE) as Array<[string, Entry]>) {
    const add = (text: string): void => {
      if (!out.has(text)) out.set(text, id)
    }
    const faces = (text: string, ask: boolean): void => {
      add(text)
      add(sentence(text))
      if (ask) {
        add(text + ELLIPSIS)
        add(sentence(text) + ELLIPSIS)
      }
    }
    const nouns: Array<Noun | undefined> = entry.noun ? ['folder', 'group'] : [undefined]
    for (const noun of nouns) {
      const ctx: Ctx = { noun }
      faces(wordsOf(entry, ctx).text, entry.ask === true)
      if (entry.sentence !== undefined) {
        add(entry.sentence)
        if (entry.ask) add(entry.sentence + ELLIPSIS)
      }
      if (entry.state) {
        faces(wordsOf(entry, { ...ctx, state: true }).text, entry.ask === true)
        faces(wordsOf(entry, { ...ctx, state: false }).text, entry.ask === true)
      }
      if (entry.count) {
        // The count's hole stays a hole: "Add {n} Tabs to Folder" names every count at once.
        const side: Record<string, string> = entry.noun
          ? { noun: entry.noun[noun ?? 'folder'] }
          : {}
        faces(fill(entry.count.one, side), entry.ask === true)
        faces(fill(entry.count.other, side), entry.ask === true)
      }
      if (entry.orientation) {
        faces(wordsOf(entry, { ...ctx, orientation: 'horizontal' }).text, entry.ask === true)
        faces(wordsOf(entry, { ...ctx, orientation: 'vertical' }).text, entry.ask === true)
      }
      if (entry.os) {
        for (const os of Object.keys(entry.os) as Platform[]) {
          const { text, ask } = wordsOf(entry, { ...ctx, os })
          faces(text, ask)
        }
      }
    }
  }
  return out
}

/** The table's entries by act, for the sweep's checks of the values themselves. */
export function tableEntries(): ReadonlyArray<readonly [id: string, entry: Entry]> {
  return Object.entries(TABLE) as Array<[string, Entry]>
}

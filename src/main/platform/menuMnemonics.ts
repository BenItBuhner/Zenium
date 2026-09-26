import type { MenuItemTemplate } from '../../core/platform'

/**
 * Alt mnemonics for the desktop's native menus (context-menus-118, shortcuts-menus-167).
 *
 * A native menu on Windows and Linux underlines one letter per row; pressing it picks the row.
 * Chromium's menus read the letter from a `&` in the label (`&&` is a literal ampersand), and
 * Electron builds its popups with `HAS_MNEMONICS`, so a `&` in the template's label is all it
 * takes. The core's descriptors carry none – the phone renders the same labels as text – so the
 * letters live here, on the desktop side, keyed by the label the core produces.
 *
 * The letters are Chrome's where Zenium has Chrome's item (its `generated_resources.grd`), and
 * follow Chrome's rule elsewhere: the first letter unless a row before it took that one, else
 * another word's initial, else a distinctive consonant. Every menu level gets its own set, so
 * two rows in one menu never share a letter (Chrome's own duplicates only move the selection).
 *
 * macOS shows no mnemonics: Electron's Cocoa menus run every label through
 * `l10n_util::FixUpWindowsStyleLabel`, which drops a lone `&` and turns `&&` into `&` – so the
 * escaping is the same on every desktop and the marker is left out there.
 */

/**
 * Chrome's letters for the items Zenium shares with it, keyed by Zenium's label. A label's
 * letter must be a character of that label; the first occurrence (case-insensitive) is marked.
 */
export const CHROME_MNEMONICS: ReadonlyMap<string, string> = new Map<string, string>([
  // The page (IDS_CONTENT_CONTEXT_*).
  ['Back', 'B'],
  ['Forward', 'F'],
  ['Reload', 'R'],
  ['Save Page As…', 'A'],
  ['Save Page As', 'A'],
  ['Print…', 'P'],
  ['View Page Source', 'V'],
  ['View Frame Source', 'V'],
  ['Reload Frame', 'F'],
  ['Inspect Element', 'n'],
  // Links.
  ['Open Link in New Tab', 'T'],
  ['Open Link in New Window', 'W'],
  ['Save Link As…', 'k'],
  ['Copy Link Address', 'e'],
  ['Copy Link Text', 'x'],
  ['Copy Email Address', 'E'],
  // Pictures and media.
  ['Open Image in New Tab', 'I'],
  ['Save Image As…', 'v'],
  ['Copy Image', 'y'],
  ['Copy Image Address', 'o'],
  ['Loop', 'L'],
  ['Show Controls', 'C'],
  // Editing.
  ['Undo', 'U'],
  ['Redo', 'R'],
  ['Cut', 't'],
  ['Copy', 'C'],
  ['Paste', 'P'],
  ['Delete', 'D'],
  ['Select All', 'A'],
  ['Add to Dictionary', 'A'],
  ['Spell Check', 'S'],
  ['Language Settings', 'L'],
  ['Language Settings…', 'L'],
  ['Translate Page', 'T'],
  ['Translate Page…', 'T'],
  ['Translate Selection', 'T'],
  // The strip's empty area and the window (IDS_NEW_TAB, IDS_RESTORE_TAB, IDS_NAME_WINDOW,
  // IDS_TASK_MANAGER, IDS_CLOSE_WINDOW_LINUX, IDS_*_WINDOW_MENU_WIN).
  ['New Tab', 'T'],
  ['New Window', 'N'],
  ['Reopen Closed Tab', 'e'],
  ['Name Window…', 'W'],
  ['Task Manager', 'T'],
  ['Close Window', 'd'],
  ['Restore', 'R'],
  ['Move', 'M'],
  ['Size', 'S'],
  ['Minimize', 'n'],
  ['Maximize', 'x'],
  ['Close', 'C'],
  // The app menu (IDS_HISTORY_MENU, IDS_SHOW_DOWNLOADS, IDS_READING_LIST_MENU, IDS_ZOOM_*,
  // IDS_FIND, IDS_MORE_TOOLS_MENU, IDS_HELP_MENU, IDS_SETTINGS, IDS_FEEDBACK, IDS_EDIT, …).
  ['History', 'H'],
  ['Downloads', 'D'],
  ['Reading List', 'R'],
  ['Extensions', 'E'],
  ['Zoom…', 'Z'],
  ['Zoom In', 'I'],
  ['Zoom Out', 'O'],
  ['Find in Page…', 'F'],
  ['Save and Share', 'S'],
  ['Copy Link', 'L'],
  ['Copy URL', 'U'],
  ['Send to Your Devices', 'd'],
  ['Send to Your Devices…', 'd'],
  ['More Tools', 'l'],
  ['Help', 'e'],
  ['Settings', 'g'],
  ['Report an Issue…', 'R'],
  ['Delete Browsing Data…', 'D'],
  ['Manage Search Engines…', 'M'],
  ['Edit', 'E'],
  // Downloads (IDS_DOWNLOAD_MENU_*).
  ['Open', 'O'],
  ['Open When Done', 'd'],
  ['Always Open Files of This Type', 'A'],
  ['Cancel', 'C'],
  ['Pause', 'P'],
  ['Resume', 'R'],
  ['Show in Folder', 'S']
])

/**
 * Chrome's letters for labels the core builds from a value – `Search Google for “…”`, `Save Video
 * As…` – matched by shape. The first match wins.
 */
export const CHROME_TEMPLATE_MNEMONICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Search .+ for “/u, 'S'], // &Search Google for “flowers”
  [/^Search Image with /u, 'S'], // &Search Google for image
  [/^Go to /u, 'G'], // &Go to http://…
  [/^Save (Video|Audio) As…$/u, 'v'], // Sa&ve video as...
  [/^Copy (Video|Audio) Address$/u, 'o'], // C&opy video address
  [/^Open (Video|Audio) in New Tab$/u, 'O'], // &Open video in new tab
  [/^Send to /u, 'd'] // Send to your &device
]

/**
 * Zenium's own letters where Chrome has no such item and the first-letter rule would land on a
 * poor one or on a neighbour's – kept small; the rule does the rest.
 */
export const ZENIUM_MNEMONICS: ReadonlyMap<string, string> = new Map<string, string>([
  ['Open Link in New Private Window', 'P'],
  ['Open Link in Private Tab', 'v'],
  ['New Private Window', 'P'],
  ['New Private Tab', 'v'],
  ['Bookmark All Tabs…', 'B'],
  ['Quit', 'Q'],
  ['Exit Full Screen', 'x'],
  ['Developer Tools', 'D']
])

/** Every `&` doubled: Chromium's menus read a lone `&` as the mnemonic marker. */
export function escapeAmpersands(label: string): string {
  return label.replace(/&/g, '&&')
}

/** The table's letter for a label, if it has one. */
export function tableMnemonic(label: string): string | undefined {
  const fixed = CHROME_MNEMONICS.get(label) ?? ZENIUM_MNEMONICS.get(label)
  if (fixed !== undefined) return fixed
  for (const [pattern, letter] of CHROME_TEMPLATE_MNEMONICS) {
    if (pattern.test(label)) return letter
  }
  return undefined
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

/**
 * The positions in a label that may carry its mnemonic, best first: the table's letter, the
 * first letter, the other words' initials, the consonants in reading order, then the vowels and
 * digits. Only letters and digits qualify; the marker never lands on punctuation.
 */
export function mnemonicCandidates(label: string): number[] {
  const chars = [...label]
  const out: number[] = []
  const push = (index: number): void => {
    if (!out.includes(index)) out.push(index)
  }
  const table = tableMnemonic(label)
  if (table !== undefined) {
    const at = chars.findIndex((char) => char.toLowerCase() === table.toLowerCase())
    if (at >= 0) push(at)
  }
  const initials: number[] = []
  const consonants: number[] = []
  const vowels: number[] = []
  const digits: number[] = []
  chars.forEach((char, index) => {
    if (!LETTER_OR_DIGIT.test(char)) return
    const lower = char.toLowerCase()
    if (index === 0 || /\s/u.test(chars[index - 1] ?? '')) initials.push(index)
    if (/\p{N}/u.test(char)) digits.push(index)
    else if (VOWELS.has(lower)) vowels.push(index)
    else consonants.push(index)
  })
  for (const index of [...initials, ...consonants, ...vowels, ...digits]) push(index)
  // Positions are indexes into the code-point array; callers mark the same array.
  return out
}

/**
 * One letter per label, unique within the list (case-insensitive) – `undefined` where every
 * letter of a label is taken. Rows are served in order, so an earlier row keeps its table letter
 * and a later one that wanted the same moves on, as Chrome's rule reads.
 */
export function chooseMnemonics(labels: ReadonlyArray<string | undefined>): (number | undefined)[] {
  const taken = new Set<string>()
  const picks: (number | undefined)[] = labels.map(() => undefined)
  // Two passes: rows with a table letter claim it first, so a row's Chrome letter is not lost to
  // a neighbour whose first-letter fallback happens to be the same character.
  const claim = (index: number, candidates: number[]): boolean => {
    const chars = [...(labels[index] ?? '')]
    for (const at of candidates) {
      const key = chars[at]?.toLowerCase()
      if (key === undefined || taken.has(key)) continue
      taken.add(key)
      picks[index] = at
      return true
    }
    return false
  }
  labels.forEach((label, index) => {
    if (label === undefined || tableMnemonic(label) === undefined) return
    const [first, ...rest] = mnemonicCandidates(label)
    if (first !== undefined && !claim(index, [first])) claim(index, rest)
  })
  labels.forEach((label, index) => {
    if (label === undefined || picks[index] !== undefined) return
    if (tableMnemonic(label) !== undefined) return // Handled above (or every letter taken).
    claim(index, mnemonicCandidates(label))
  })
  return picks
}

/** The label with its `&` characters escaped and the mnemonic marker before `at`, if any. */
export function markMnemonic(label: string, at: number | undefined): string {
  const chars = [...label]
  if (at === undefined || at < 0 || at >= chars.length) return escapeAmpersands(label)
  return `${escapeAmpersands(chars.slice(0, at).join(''))}&${escapeAmpersands(chars.slice(at).join(''))}`
}

/**
 * The template's labels as Electron should see them on `os`: every `&` escaped everywhere, and
 * on Windows and Linux a unique mnemonic per row of each menu level, submenus included. Items
 * are copied; the core's descriptors are left as they were.
 */
export function withMnemonics(items: MenuItemTemplate[], os: NodeJS.Platform): MenuItemTemplate[] {
  const marks = os === 'darwin' ? false : true
  const picks = marks
    ? chooseMnemonics(items.map((item) => (item.type === 'separator' ? undefined : item.label)))
    : []
  return items.map((item, index) => {
    if (item.type === 'separator') return item
    const out: MenuItemTemplate = { ...item }
    if (item.label !== undefined) out.label = markMnemonic(item.label, marks ? picks[index] : undefined)
    if (item.submenu) out.submenu = withMnemonics(item.submenu, os)
    return out
  })
}

/**
 * What Chromium's `MenuItemView` reads from a marked label: the letter after the first lone `&`
 * (lower-cased) and the text with the markers gone and `&&` collapsed – the row as drawn.
 */
export function parseMnemonic(label: string): { text: string; mnemonic?: string } {
  let text = ''
  let mnemonic: string | undefined
  const chars = [...label]
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    if (char !== '&') {
      text += char
      continue
    }
    const next = chars[i + 1]
    if (next === '&') {
      text += '&'
      i++
      continue
    }
    if (next !== undefined && mnemonic === undefined) mnemonic = next.toLowerCase()
  }
  return mnemonic === undefined ? { text } : { text, mnemonic }
}

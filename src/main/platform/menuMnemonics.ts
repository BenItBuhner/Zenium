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
  ['Close Tab', 'C'],
  ['Close Tab (keep pinned)', 'C'],
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
  // The submenu headers (IDS_PASSWORDS_AND_AUTOFILL_MENU "Passwords and &autofill" – the A of
  // Autofill in Title Case – and IDS_FIND_AND_EDIT_MENU "&Find and edit").
  ['Passwords and Autofill', 'A'],
  ['Find and Edit', 'F'],
  ['Save and Share', 'S'],
  ['Copy Link', 'L'],
  ['Copy URL', 'U'],
  ['Send to Your Devices', 'D'],
  ['Send to Your Devices…', 'D'],
  ['More Tools', 'l'],
  ['Help', 'e'],
  ['Settings', 'g'],
  ['Report an Issue…', 'R'],
  ['Delete Browsing Data…', 'D'],
  ['Manage Search Engines…', 'M'],
  ['Paste and Go', 's'],
  ['Paste and Search', 's'],
  ['Edit', 'E'],
  // Downloads (IDS_DOWNLOAD_MENU_*).
  ['Open', 'O'],
  ['Open When Done', 'D'],
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
  [/^Open (Video|Audio) in New Tab$/u, 'O'] // &Open video in new tab
]

/** Zenium's own shaped labels: the bookmark folder's Open All rows, by the word that tells them apart. */
export const ZENIUM_TEMPLATE_MNEMONICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Open All \(\d+\)$/u, 'O'],
  [/^Open All \(\d+\) in New Window$/u, 'W'],
  [/^Open All \(\d+\) in New Private Window$/u, 'P'],
  [/^Open All \(\d+\) in New Tab Folder$/u, 'F']
]

/**
 * Zenium's own letters where Chrome has no such item and the first-letter rule would land on a
 * poor one or on a neighbour's: Firefox's access keys where Firefox has the row (Book&mark Page,
 * &Bookmark Tab, &Reload Tab, &Mute Tab, &Pin Tab, &Duplicate Tab, Mo&ve Tab, Close &Other Tabs,
 * Move &Left / &Right), the distinguishing word elsewhere (Open in New &Window, Open Link in
 * &Glance). The rule does the rest.
 */
export const ZENIUM_MNEMONICS: ReadonlyMap<string, string> = new Map<string, string>([
  // Links and rows that open somewhere: the word that tells the rows apart.
  ['Open Link in New Private Window', 'P'],
  ['Open Link in Private Tab', 'v'],
  ['Open Link in Glance', 'G'],
  ['Open Link in Split View', 'S'],
  ['Open Link in New Container Tab', 'C'],
  ['Open in New Tab', 'T'],
  ['Open in New Window', 'W'],
  ['Open in New Private Window', 'P'],
  ['Open in Private Tab', 'v'],
  ['Open in Glance', 'G'],
  ['Open in Split View', 'S'],
  ['Open in New Container Tab', 'C'],
  ['Open All in Tabs', 'O'],
  ['New Private Window', 'P'],
  ['New Private Tab', 'v'],
  // The page and the tab (Firefox's letters where it has the row).
  ['Bookmark Page', 'm'],
  ['Bookmark Tab', 'B'],
  ['Bookmark All Tabs…', 'B'],
  ['Bookmark Manager', 'M'],
  ['New Tab Below', 'N'],
  ['Reload Tab', 'R'],
  ['Mute Tab', 'M'],
  ['Mute Site', 'S'],
  ['Unload Tab', 'U'],
  ['Freeze Tab', 'F'],
  ['Duplicate Tab', 'D'],
  ['Pin Tab', 'P'],
  ['Unpin Tab', 'p'],
  ['Add to Essentials', 'A'],
  ['Add Tab to Reading List', 'L'],
  ['Change Icon…', 'I'],
  ['Move Tab', 'v'],
  ['Close Tabs Above', 'A'],
  ['Close Tabs Below', 'B'],
  ['Close Other Tabs', 'O'],
  ['Move Left', 'L'],
  ['Move Right', 'R'],
  ['Rename…', 'n'],
  ['Paste as Plain Text', 'l'],
  ['Quit', 'Q'],
  ['Exit Full Screen', 'x'],
  ['Developer Tools', 'D']
])

/** Every `&` doubled: Chromium's menus read a lone `&` as the mnemonic marker. */
export function escapeAmpersands(label: string): string {
  return label.replace(/&/g, '&&')
}

/** Whose letter a label carries: Chrome's are claimed before Zenium's, both before the rule's. */
export type MnemonicSource = 'chrome' | 'zenium'

function lookUp(
  label: string,
  fixed: ReadonlyMap<string, string>,
  shaped: ReadonlyArray<readonly [RegExp, string]>
): string | undefined {
  const exact = fixed.get(label)
  if (exact !== undefined) return exact
  for (const [pattern, letter] of shaped) if (pattern.test(label)) return letter
  return undefined
}

/** The table's letter for a label and whose it is, if it has one. */
export function tableEntry(label: string): { letter: string; source: MnemonicSource } | undefined {
  const chrome = lookUp(label, CHROME_MNEMONICS, CHROME_TEMPLATE_MNEMONICS)
  if (chrome !== undefined) return { letter: chrome, source: 'chrome' }
  const zenium = lookUp(label, ZENIUM_MNEMONICS, ZENIUM_TEMPLATE_MNEMONICS)
  return zenium === undefined ? undefined : { letter: zenium, source: 'zenium' }
}

/** The table's letter for a label, if it has one. */
export function tableMnemonic(label: string): string | undefined {
  return tableEntry(label)?.letter
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

const isInitial = (chars: string[], index: number): boolean =>
  index === 0 || /\s/u.test(chars[index - 1] ?? '')

/**
 * Where a table letter sits in its label: the letter as written (Chrome's `Sa&ve` is the small
 * v, its `Save &as` the capital of Zenium's `As`), else a word's initial of either case, else
 * its first occurrence; -1 when the label has no such letter.
 */
export function tableLetterIndex(label: string, letter: string): number {
  const chars = [...label]
  const exact = chars.indexOf(letter)
  if (exact >= 0) return exact
  const lower = letter.toLowerCase()
  const initial = chars.findIndex((c, i) => c.toLowerCase() === lower && isInitial(chars, i))
  return initial >= 0 ? initial : chars.findIndex((c) => c.toLowerCase() === lower)
}

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
    const at = tableLetterIndex(label, table)
    if (at >= 0) push(at)
  }
  const initials: number[] = []
  const consonants: number[] = []
  const vowels: number[] = []
  const digits: number[] = []
  // In a Title Case label the small words (in, to, as) start lower-case and make poor letters;
  // their initials count as consonants or vowels only. A label with no capital at all – a
  // spelling suggestion, a page's own words – keeps every word's initial.
  const capitals = /\p{Lu}/u.test(label)
  chars.forEach((char, index) => {
    if (!LETTER_OR_DIGIT.test(char)) return
    if (isInitial(chars, index) && (!capitals || /[\p{Lu}\p{N}]/u.test(char))) initials.push(index)
    if (/\p{N}/u.test(char)) digits.push(index)
    else if (VOWELS.has(char.toLowerCase())) vowels.push(index)
    else consonants.push(index)
  })
  for (const index of [...initials, ...consonants, ...vowels, ...digits]) push(index)
  // Positions are indexes into the code-point array; callers mark the same array.
  return out
}

/**
 * One letter per label, unique within the list (case-insensitive) – `undefined` only where no
 * assignment can give the row a letter of its own.
 *
 * Rows with a table letter claim it first – Chrome's rows before Zenium's, each set in menu
 * order, so a Zenium row placed above Cut never costs Cu&t its t (two rows wanting one letter:
 * the first keeps it, the other joins the rest). The rest are served in order and take their
 * best free candidate. A row that finds every letter taken makes room by moving a neighbour on
 * to another of its letters – the fewest neighbours it can (a shortest augmenting path, so the
 * matching is a maximum one), rows with no table letter before Zenium's own, Chrome's never. A
 * crowded menu – the tab's two dozen rows draw on twenty-one distinct letters – leaves a row
 * unmarked only when every letter it has is held by a row that has no other.
 */
export function chooseMnemonics(labels: ReadonlyArray<string | undefined>): (number | undefined)[] {
  const rows = labels.map((label) => [...(label ?? '')])
  const candidates = labels.map((label) => (label === undefined ? [] : mnemonicCandidates(label)))
  const picks: (number | undefined)[] = labels.map(() => undefined)
  const holder = new Map<string, number>()
  const fixed = new Set<number>()
  const settled = new Set<number>()
  const keyAt = (row: number, at: number): string => rows[row]![at]!.toLowerCase()

  for (const source of ['chrome', 'zenium'] as const) {
    labels.forEach((label, row) => {
      if (label === undefined || tableEntry(label)?.source !== source) return
      const at = candidates[row]![0]
      if (at === undefined || holder.has(keyAt(row, at))) return
      holder.set(keyAt(row, at), row)
      picks[row] = at
      // Chrome's letters are the ones a Chrome user's hand knows: those rows stay put. Zenium's
      // own are settled – moved only when nothing else makes room.
      if (source === 'chrome') fixed.add(row)
      else settled.add(row)
    })
  }

  const take = (row: number, at: number): void => {
    holder.set(keyAt(row, at), row)
    picks[row] = at
    settled.delete(row)
  }
  // Breadth-first from `row` over the rows holding its letters: the first free letter found ends
  // the shortest chain of moves, and every row on the chain steps on to the letter it wanted.
  const place = (row: number, movable: (other: number) => boolean): boolean => {
    const wanted = new Map<number, { by: number; at: number }>()
    const queue = [row]
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!
      for (const at of candidates[current]!) {
        const other = holder.get(keyAt(current, at))
        if (other === undefined) {
          take(current, at)
          for (let step = wanted.get(current); step !== undefined; step = wanted.get(step.by)) {
            take(step.by, step.at)
          }
          return true
        }
        if (other === row || wanted.has(other) || !movable(other)) continue
        wanted.set(other, { by: current, at })
        queue.push(other)
      }
    }
    return false
  }
  labels.forEach((label, row) => {
    if (label === undefined || picks[row] !== undefined) return
    place(row, (other) => !fixed.has(other) && !settled.has(other)) ||
      place(row, (other) => !fixed.has(other))
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
    if (item.label !== undefined)
      out.label = markMnemonic(item.label, marks ? picks[index] : undefined)
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

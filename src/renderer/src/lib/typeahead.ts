/*
 * Type-ahead in a listbox (v2 draft §9.22, the menulist popup of §9.13), with Chromium's
 * `TypeAhead` – the class behind a `<select>` popup's letters – as the rule book: the keys typed
 * within a second of each other form one search for the option whose label starts with them; the
 * same key pressed again and again cycles through the options starting with it. Pure, so the
 * matcher is tested without a layout; the popup keeps the buffer and the clock.
 */

/** How long after a key the next one still extends the search (Chromium's `kTypeAheadTimeout`). */
export const TYPEAHEAD_RESET_MS = 1000

/** What has been typed so far, and when the last key came. */
export interface TypeaheadBuffer {
  text: string
  at: number
}

/**
 * The letter a key press adds to the search, or null when it is not one: one printable
 * character with no Control, Alt or Command held. Space is the list's Enter, not a letter.
 */
export function typeaheadKey(e: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if ([...e.key].length !== 1 || e.key === ' ') return null
  return e.key
}

/** The buffer after `key` at `now`: extended, or begun again when the last key is over a second old. */
export function typeaheadExtend(
  buffer: TypeaheadBuffer | null,
  key: string,
  now: number
): TypeaheadBuffer {
  const text = buffer && now - buffer.at <= TYPEAHEAD_RESET_MS ? buffer.text + key : key
  return { text, at: now }
}

/**
 * The option the search in `buffer` lands on, among `labels` (null for an option the keys skip)
 * with the cursor at `current` (-1 for none), or null when nothing starts with it. One letter
 * repeated cycles: the search is for that letter and starts after the current option, round to
 * the first; a longer prefix starts at the current option itself, so typing on stays on a match
 * that still holds. Leading spaces in a label are ignored; case is not compared.
 */
export function typeaheadMatch(
  labels: ReadonlyArray<string | null>,
  buffer: string,
  current: number
): number | null {
  if (buffer.length === 0 || labels.length === 0) return null
  const chars = [...buffer]
  const repeating = chars.every((c) => c === chars[0])
  const prefix = (repeating ? chars[0] : buffer).toLocaleLowerCase()
  const from = repeating ? current + 1 : Math.max(0, current)
  for (let step = 0; step < labels.length; step++) {
    const i = (from + step) % labels.length
    const label = labels[i]
    if (label !== null && label.trimStart().toLocaleLowerCase().startsWith(prefix)) return i
  }
  return null
}

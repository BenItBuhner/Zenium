/*
 * The open path of the bookmarks bar's cascading folder panels (`BarMenu`): `path[d]` is the
 * folder whose panel stands as level `d + 1`, so level 0 is the root under the chip and a path
 * of n folders shows n + 1 levels. Pure, so the keyboard's and the pointer's moves through the
 * cascade can be tested without a layout. Both moves hand back the same array when nothing
 * changes, so a state set with them can bail out.
 */

/** Where the focus goes after the cascade changes: a level's first row, or a row by its folder id. */
export type PathFocus = { depth: number; target: 'first' | { id: string } }

/**
 * Open `folderId`'s panel beside level `depth`: the levels deeper than `depth` go, the folder's
 * takes their place. Opening the folder that is already open there changes nothing – what stood
 * beside it stays too (the pointer coming back over an open folder row keeps its cascade).
 */
export function openedAt(path: string[], depth: number, folderId: string): string[] {
  return path[depth] === folderId ? path : [...path.slice(0, depth), folderId]
}

/** The focus request opening a level from the keyboard calls for: the new level's first row. */
export function focusAfterOpen(depth: number): PathFocus {
  return { depth: depth + 1, target: 'first' }
}

/** Close the levels deeper than `depth`; level `depth` and what is above it stay. */
export function closedTo(path: string[], depth: number): string[] {
  return path.length > depth ? path.slice(0, depth) : path
}

/**
 * The row of level `depth` that had opened the levels `closedTo(path, depth)` closes – the folder
 * `path[depth]` – which takes the focus back after ArrowLeft, Backspace or Escape (§9.22); null
 * when nothing deeper was open, so there is no row to go back to.
 */
export function openerOf(path: readonly string[], depth: number): string | null {
  return path[depth] ?? null
}

/** The focus request `closedTo` calls for from the keyboard: the opener row, when one was open. */
export function focusAfterClose(path: readonly string[], depth: number): PathFocus | null {
  const opener = openerOf(path, depth)
  return opener ? { depth, target: { id: opener } } : null
}

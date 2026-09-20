/**
 * The text selection the WebView's action mode clears, kept for the core's read-aloud
 * extraction (EDGE-11 / GN-13; the selection toolbar's Read Aloud, #206's `TabWebView`).
 *
 * A touch on one of Zenium's toolbar items reads the selection, sends `selection.action` to the
 * core and finishes the mode, and finishing the mode collapses the page's selection (the
 * system's items do the same). The core's `readAloud.start { from: 'selection' }` then asks the
 * document for the selection's blocks (`readAloud.extract`), but the request rides the bridge
 * through the chrome and reaches the document after the collapse: the live selection is gone and
 * the extraction would find no text. So the selection the mode cleared is remembered here at the
 * moment it collapses, and stands in for the live one, for the synchronous extraction alone,
 * when the request arrives within [CLEARED_SELECTION_MS] of the collapse; the document is left
 * collapsed again as the mode left it. A selection still up (a request that came another way)
 * is used as it stands. The shared extraction (`readAloudScript.ts`, services') reads
 * `document.getSelection()` and is not changed.
 */
export interface SelectionMemory {
  /**
   * Run `work` with the selection the mode cleared restored for its duration, when the live
   * selection is collapsed and the cleared one is recent; else run it as things stand.
   */
  withCleared<T>(work: () => T): T
  dispose(): void
}

/** How long a cleared selection stands in: the bridge's round trip is well under a second. */
export const CLEARED_SELECTION_MS = 5_000

export function rememberClearedSelection(
  doc: Document,
  now: () => number = () => Date.now(),
  keepMs: number = CLEARED_SELECTION_MS
): SelectionMemory {
  /** The selection as it stands while it is not collapsed. */
  let standing: Range | null = null
  /** The last standing selection, from the moment it collapsed. */
  let cleared: { range: Range; at: number } | null = null

  const onChange = (): void => {
    const selection = doc.getSelection()
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      standing = selection.getRangeAt(0).cloneRange()
      cleared = null
    } else if (standing) {
      cleared = { range: standing, at: now() }
      standing = null
    }
  }
  doc.addEventListener('selectionchange', onChange)

  return {
    withCleared: (work) => {
      const selection = doc.getSelection()
      const collapsed = !selection || selection.rangeCount === 0 || selection.isCollapsed
      const recent = cleared !== null && now() - cleared.at <= keepMs
      if (!selection || !collapsed || !recent) return work()
      const range = cleared.range
      selection.removeAllRanges()
      selection.addRange(range)
      try {
        return work()
      } finally {
        selection.removeAllRanges()
        // Where the mode left the caret: at the selection's end.
        const caret = range.cloneRange()
        caret.collapse(false)
        selection.addRange(caret)
      }
    },
    dispose: () => doc.removeEventListener('selectionchange', onChange)
  }
}

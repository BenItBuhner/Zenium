import type { RefCallback } from 'react'

/**
 * A Settings row's line count (rows.tsx, §9.18): whatever trails the text centres on the row
 * until the text runs to three lines (a description wrapped, or a search result's caption above
 * the label), when the control centres on the label's line instead. The row measures its own
 * text block for that: `data-lines="3"` and `--zen-settings-label-top` (the label line's offset
 * in the block) go on the row. On its own so a row drawn outside the model on the same primitive
 * (the site-data viewer's origin rows) can measure itself the same way.
 */

/** The row's text block as laid out: three lines or more, and where the label line starts. */
function measureLines(row: HTMLElement): void {
  const text = row.querySelector<HTMLElement>('.zen-settings-row-text')
  const label = text?.querySelector<HTMLElement>('.zen-settings-label')
  if (!text || !label) return
  const line = parseFloat(getComputedStyle(label).lineHeight) || 20
  const block = text.getBoundingClientRect()
  const three = block.height > line * 2.5
  if (three) {
    row.dataset.lines = '3'
    row.style.setProperty(
      '--zen-settings-label-top',
      `${(label.getBoundingClientRect().top - block.top).toFixed(2)}px`
    )
  } else {
    delete row.dataset.lines
    row.style.removeProperty('--zen-settings-label-top')
  }
}

/**
 * Keep a row's line count current: measured once it is on screen and again whenever its text
 * block changes size (the label wraps at a new width, the description changes). Only rows with
 * something trailing the text need it.
 */
export const attachLineCount: RefCallback<HTMLElement> = (row) => {
  if (!row) return
  measureLines(row)
  if (typeof ResizeObserver !== 'function') return
  const text = row.querySelector('.zen-settings-row-text')
  if (!text) return
  const observer = new ResizeObserver(() => measureLines(row))
  observer.observe(text)
  return () => observer.disconnect()
}

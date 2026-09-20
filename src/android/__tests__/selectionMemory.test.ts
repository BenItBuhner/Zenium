// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { CLEARED_SELECTION_MS, rememberClearedSelection } from '../selectionMemory'

let clock = 1_000
const now = (): number => clock

function select(text: string): void {
  const node = document.querySelector('p')!.firstChild as Text
  const start = node.data.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

/** What the WebView does when the action mode finishes: the selection collapses. */
function collapse(): void {
  document.getSelection()!.collapseToEnd()
  document.dispatchEvent(new Event('selectionchange'))
}

beforeEach(() => {
  document.body.innerHTML = '<p>He had learned early that the sea keeps its own arithmetic.</p>'
  document.getSelection()?.removeAllRanges()
  clock = 1_000
})

describe('the selection the action mode cleared, kept for the read-aloud extraction', () => {
  it('stands in for the collapsed live selection when the request comes soon after the collapse', () => {
    const memory = rememberClearedSelection(document, now)
    select('arithmetic')
    collapse()
    clock += 400
    const seen = memory.withCleared(() => document.getSelection()!.toString())
    expect(seen).toBe('arithmetic')
    // The document is left as the mode left it: collapsed, the caret at the selection's end.
    expect(document.getSelection()!.isCollapsed).toBe(true)
    memory.dispose()
  })

  it('uses a selection still standing as it is', () => {
    const memory = rememberClearedSelection(document, now)
    select('the sea')
    const seen = memory.withCleared(() => document.getSelection()!.toString())
    expect(seen).toBe('the sea')
    expect(document.getSelection()!.isCollapsed).toBe(false)
    memory.dispose()
  })

  it('lets a stale clearance go (a request long after the mode finished reads the document as it stands)', () => {
    const memory = rememberClearedSelection(document, now)
    select('arithmetic')
    collapse()
    clock += CLEARED_SELECTION_MS + 1
    expect(memory.withCleared(() => document.getSelection()!.toString())).toBe('')
    memory.dispose()
  })

  it('remembers the last selection standing, not the first', () => {
    const memory = rememberClearedSelection(document, now)
    select('learned')
    select('sea keeps')
    collapse()
    expect(memory.withCleared(() => document.getSelection()!.toString())).toBe('sea keeps')
    memory.dispose()
  })

  it('hears nothing once disposed', () => {
    const memory = rememberClearedSelection(document, now)
    memory.dispose()
    select('arithmetic')
    collapse()
    expect(memory.withCleared(() => document.getSelection()!.toString())).toBe('')
  })
})

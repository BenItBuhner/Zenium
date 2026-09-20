// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ReadAloudExtraction } from '@shared/readAloud'

/**
 * The page script Kotlin injects into every page WebView (`src/android/pageScript.ts`), run
 * against a document with the `__zenPageBridge` stand-in Kotlin's WebMessage listener would be:
 * what the host posts down comes through `onmessage`, what the script sends up lands in
 * `posted`, with the session token Kotlin substitutes (`__ZEN_TOKEN__` unreplaced here).
 */
interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const posted: string[] = []
const bridge: Bridge = { postMessage: (message) => void posted.push(message), onmessage: null }

/** The messages the script sent up so far, parsed, oldest first. */
function sent(): Array<Record<string, unknown>> {
  return posted.map((raw) => JSON.parse(raw) as Record<string, unknown>)
}

/** Post a host message down the bridge, as Kotlin's `postToPage` does. */
function down(message: Record<string, unknown>): void {
  bridge.onmessage!({ data: JSON.stringify(message) })
}

beforeAll(async () => {
  document.body.innerHTML =
    '<article><h1>The lighthouse keeper</h1><p>Every evening he climbed the steps. The ledger did not care.</p></article>'
  ;(window as unknown as { __zenPageBridge: Bridge }).__zenPageBridge = bridge
  // The script is an IIFE over `window.__zenPageBridge`: it installs on import.
  await import('../pageScript')
})

beforeEach(() => {
  posted.length = 0
})

describe('the Android page script and read aloud (A11Y-06; the core’s model, #246)', () => {
  it('installs on the bridge', () => {
    expect(bridge.onmessage).toBeTypeOf('function')
  })

  it('answers the core’s readAloud.extract with the document’s blocks, riding the page-message path', () => {
    down({ type: 'readAloud', action: 'extract', requestId: 'ra1', from: 'top', keep: null })
    const answer = sent().find((m) => m.type === 'readAloud')
    expect(answer).toBeDefined()
    // Kotlin checks the token and forwards the rest as the tab's `pageMessage` view event.
    expect(answer!.token).toBe('__ZEN_TOKEN__')
    const extraction = answer!.readAloud as ReadAloudExtraction
    expect(extraction.requestId).toBe('ra1')
    expect(extraction.blocks.map((b) => b.text)).toEqual([
      'The lighthouse keeper',
      'Every evening he climbed the steps. The ledger did not care.'
    ])
    // Where each block's text lives, for the highlight (the walker's element path and run).
    expect(extraction.blocks.every((b) => Array.isArray(b.at.path))).toBe(true)
  })

  it('answers readAloud.extract from the selection the action mode cleared (the toolbar’s Read Aloud)', () => {
    // A long press selects a word; the touch on Read Aloud finishes the mode, which collapses the
    // selection; the core's request reaches the document after that (`selectionMemory.ts`).
    const text = document.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, text.data.indexOf('ledger'))
    range.setEnd(text, text.data.length)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    selection.collapseToEnd()
    document.dispatchEvent(new Event('selectionchange'))
    down({ type: 'readAloud', action: 'extract', requestId: 'ra2', from: 'selection', keep: null })
    const extraction = sent().find((m) => m.type === 'readAloud')!.readAloud as ReadAloudExtraction
    expect(extraction.requestId).toBe('ra2')
    // Edge's behaviour: the selection first, then on to the end (the block cut to the selection's start).
    expect(extraction.blocks.map((b) => b.text)).toEqual(['ledger did not care.'])
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })

  it('takes the core’s highlight messages without an answer (painted, or nothing without the Highlight API)', () => {
    down({
      type: 'readAloud',
      action: 'highlight',
      tabId: 't1',
      blockId: 'b1',
      at: { path: [0, 1], run: 0, offset: 0 },
      sentence: { start: 0, end: 34 },
      word: { start: 6, end: 13 },
      mode: 'both'
    })
    expect(sent().filter((m) => m.type === 'readAloud')).toEqual([])
  })

  it('leaves other host messages to their own handlers', () => {
    down({ type: 'zap', on: true })
    expect(sent().filter((m) => m.type === 'readAloud')).toEqual([])
  })
})

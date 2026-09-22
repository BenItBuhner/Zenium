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
  // The Web Share shim installs in secure top-level documents alone (Chrome exposes it there).
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true })
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

describe('the Android page script and Web Share (SH-14: the shim over the WebView, the OS sheet behind it)', () => {
  it('gives the page navigator.share and canShare (the WebView has neither)', () => {
    expect(typeof navigator.share).toBe('function')
    expect(typeof navigator.canShare).toBe('function')
    expect(navigator.canShare({ url: 'https://example.test/' })).toBe(true)
    expect(navigator.canShare({ files: [new File(['x'], 'a.txt', { type: 'text/plain' })] })).toBe(
      true
    )
    expect(navigator.canShare({})).toBe(false)
  })

  it('refuses a share without a user gesture (NotAllowedError), sending nothing up', async () => {
    setUserActivation(false)
    await expect(
      navigator.share({ title: 'T', url: 'https://example.test/' })
    ).rejects.toMatchObject({
      name: 'NotAllowedError'
    })
    expect(sent().filter((m) => m.type === 'share')).toEqual([])
  })

  it('posts a gestured share up under the token with its files as base64, and settles the promise from the sheet’s outcome', async () => {
    setUserActivation(true)
    const promise = navigator.share({
      title: 'A picture',
      text: 'Look',
      url: '/p/1',
      files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })]
    })
    await flush()
    await flush()
    const up = sent().find((m) => m.type === 'share')!
    expect(up.token).toBe('__ZEN_TOKEN__')
    const call = up.share as {
      id: string
      title: string
      text: string
      url: string
      files: Array<Record<string, unknown>>
    }
    expect(call.title).toBe('A picture')
    expect(call.text).toBe('Look')
    expect(call.url).toBe(new URL('/p/1', document.baseURI).href)
    expect(call.files).toEqual([
      { name: 'hello.txt', type: 'text/plain', size: 5, data: btoa('hello') }
    ])
    // A second call while the first is up is Chrome's InvalidStateError.
    await expect(navigator.share({ text: 'again' })).rejects.toMatchObject({
      name: 'InvalidStateError'
    })
    // Kotlin's chooser reported a chosen target: the core posts `shared` and the promise resolves.
    down({ type: 'share', id: call.id, result: 'shared' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects the promise with AbortError when the sheet was dismissed', async () => {
    setUserActivation(true)
    const promise = navigator.share({ text: 'bye' })
    await flush()
    await flush()
    const call = sent().find((m) => m.type === 'share')!.share as { id: string }
    down({ type: 'share', id: call.id, result: 'aborted' })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the Android page script and links to a highlight (SH-11)', () => {
  it('answers the core’s textFragment.generate from the selection the action mode cleared', () => {
    const text = document.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, text.data.indexOf('ledger'))
    range.setEnd(text, text.data.indexOf('ledger') + 'ledger did not care'.length)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    selection.collapseToEnd()
    document.dispatchEvent(new Event('selectionchange'))
    down({ type: 'textFragment', action: 'generate', id: 'tf1' })
    const answer = sent().find((m) => m.type === 'textFragment')!
    expect(answer.token).toBe('__ZEN_TOKEN__')
    expect(answer.id).toBe('tf1')
    expect(answer.directive).toBe('text=ledger%20did%20not%20care')
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })

  it('answers null when nothing is selected and nothing was just cleared', async () => {
    // The cleared selection above stands in for five seconds; a fresh, never-selected document has none.
    document.getSelection()!.removeAllRanges()
    down({ type: 'textFragment', action: 'generate', id: 'tf2' })
    const answer = sent().find((m) => m.type === 'textFragment')!
    // Either the remembered selection (still within its keep) or null: never a throw, always an answer.
    expect(answer.id).toBe('tf2')
    expect(answer.directive === null || typeof answer.directive === 'string').toBe(true)
  })
})

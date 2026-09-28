// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIPBOARD_READ_DENIED,
  CLIPBOARD_READ_UNFOCUSED,
  installClipboardReadShim,
  isClipboardReadCall,
  type ClipboardReadCall,
  type ClipboardReadResult,
  type ClipboardReadTransport
} from '../clipboardRead'

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

const realHasFocus = document.hasFocus

function setFocused(focused: boolean): void {
  document.hasFocus = focused ? realHasFocus : () => false
}

interface ScriptedHost {
  /** What the shim posted up the bridge. */
  sent: ClipboardReadCall[]
  /** How many times the shim asked to hear the answers (once, at the first call). */
  listens: number
  /** The core's answer to one call. */
  answer: (result: ClipboardReadResult) => void
}

/** The shim installed over this window's `Clipboard`, the core scripted. */
function install(sendThrows?: Error): ScriptedHost {
  let push: (result: ClipboardReadResult) => void = () => undefined
  const host: ScriptedHost = { sent: [], listens: 0, answer: (result) => push(result) }
  const transport: ClipboardReadTransport = {
    send: (call) => {
      if (sendThrows) throw sendThrows
      host.sent.push(call)
    },
    onResult: (listener) => {
      host.listens++
      push = listener
    }
  }
  installClipboardReadShim(transport)
  return host
}

const clipboard = (): Clipboard => navigator.clipboard

afterEach(() => {
  setFocused(true)
  setUserActivation(true)
})

/*
 * `navigator.clipboard.read()` / `readText()` where the engine refuses every read (MW-38): the
 * shim's answers are Chrome's – the promise resolves with the clipboard's text, or rejects with
 * the `NotAllowedError` Chrome's `ClipboardPromise` throws (its message verbatim) – and its
 * preconditions are Chrome's two: a focused document and the permission, no user activation.
 */
describe('installClipboardReadShim', () => {
  it('lays the two methods over Clipboard.prototype and does nothing more until the first call', () => {
    const host = install()
    expect(typeof Clipboard.prototype.readText).toBe('function')
    expect(typeof Clipboard.prototype.read).toBe('function')
    expect(host.sent).toEqual([])
    // Lazy: the answer channel is opened by the first call, not at install.
    expect(host.listens).toBe(0)
  })

  it('reads without a user gesture, as Chrome does: a focused document and the permission are the gates', async () => {
    const host = install()
    setUserActivation(false)
    const text = clipboard().readText()
    const items = clipboard().read()
    expect(host.sent.map((call) => call.kind)).toEqual(['text', 'items'])
    host.answer({ id: host.sent[0].id, text: 'no gesture needed' })
    host.answer({ id: host.sent[1].id, text: 'no gesture needed' })
    await expect(text).resolves.toBe('no gesture needed')
    await expect(items).resolves.toHaveLength(1)
  })

  it("rejects when the document is not focused, with Chrome's message", async () => {
    const host = install()
    setFocused(false)
    await expect(clipboard().read()).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: `Failed to execute 'read' on 'Clipboard': ${CLIPBOARD_READ_UNFOCUSED}`
    })
    expect(host.sent).toEqual([])
  })

  it("resolves readText with the host's text once the core allows the read", async () => {
    const host = install()
    const pending = clipboard().readText()
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0].kind).toBe('text')
    expect(host.listens).toBe(1)
    host.answer({ id: host.sent[0].id, text: 'copied words' })
    await expect(pending).resolves.toBe('copied words')
  })

  it("rejects a refused read with Chrome's NotAllowedError 'Read permission denied.'", async () => {
    const host = install()
    const pending = clipboard().readText()
    host.answer({ id: host.sent[0].id, error: 'denied' })
    await expect(pending).rejects.toBeInstanceOf(DOMException)
    await expect(pending).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: CLIPBOARD_READ_DENIED
    })
  })

  it('read() gives one text/plain ClipboardItem with the text, and no item for an empty clipboard', async () => {
    const host = install()
    const pending = clipboard().read()
    expect(host.sent[0].kind).toBe('items')
    host.answer({ id: host.sent[0].id, text: 'from the clip' })
    const items = await pending
    expect(items).toHaveLength(1)
    expect(items[0]).toBeInstanceOf(ClipboardItem)
    expect(items[0].types).toEqual(['text/plain'])
    const blob = await items[0].getType('text/plain')
    expect(blob.type).toBe('text/plain')
    expect(await blob.text()).toBe('from the clip')

    const empty = clipboard().read()
    host.answer({ id: host.sent[1].id, text: '' })
    await expect(empty).resolves.toEqual([])
  })

  it('settles each call by its id, in any order, and ignores answers it did not ask for', async () => {
    const host = install()
    const first = clipboard().readText()
    const second = clipboard().readText()
    expect(host.sent.map((call) => call.id)).toHaveLength(2)
    expect(host.sent[0].id).not.toBe(host.sent[1].id)
    host.answer({ id: 'clip-never-asked', text: 'stray' })
    host.answer({ id: host.sent[1].id, text: 'two' })
    host.answer({ id: host.sent[0].id, error: 'denied' })
    await expect(second).resolves.toBe('two')
    await expect(first).rejects.toMatchObject({ name: 'NotAllowedError' })
    // A settled call's answer is not heard twice.
    host.answer({ id: host.sent[1].id, text: 'again' })
    expect(host.listens).toBe(1)
  })

  it('rejects the call with the bridge’s own error when the message cannot go up', async () => {
    install(new Error('bridge gone'))
    await expect(clipboard().readText()).rejects.toThrow('bridge gone')
  })

  it('leaves a window without the Clipboard API alone', () => {
    expect(() =>
      installClipboardReadShim(
        { send: () => undefined, onResult: () => undefined },
        {} as Window & typeof globalThis
      )
    ).not.toThrow()
  })
})

describe('isClipboardReadCall', () => {
  it('accepts the shim’s two calls and nothing else', () => {
    expect(isClipboardReadCall({ id: 'clip-1', kind: 'text' })).toBe(true)
    expect(isClipboardReadCall({ id: 'clip-2', kind: 'items' })).toBe(true)
    expect(isClipboardReadCall({ id: '', kind: 'text' })).toBe(false)
    expect(isClipboardReadCall({ id: 'clip-3', kind: 'image' })).toBe(false)
    expect(isClipboardReadCall({ id: 4, kind: 'text' })).toBe(false)
    expect(isClipboardReadCall('clip-1')).toBe(false)
    expect(isClipboardReadCall(null)).toBe(false)
    expect(isClipboardReadCall(undefined)).toBe(false)
  })
})

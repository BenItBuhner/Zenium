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

  /*
   * The clip's image (MW-38, the phone): the host hands a bounded PNG as base64 beside the text;
   * `read()` answers as Chrome does for the system clipboard – ONE `ClipboardItem` carrying every
   * representation (`clipboard_promise.cc` `ResolveRead`), `text/plain` before `image/png`
   * (`clipboard_android.cc` `ReadAvailableTypes`) – and `readText()` stays the text.
   */
  describe('the clip’s image', () => {
    // Eight bytes: the PNG signature, enough to tell the blob decoded to the host's bytes.
    const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES))

    const bytesOf = async (blob: Blob): Promise<number[]> =>
      Array.from(new Uint8Array(await blob.arrayBuffer()))

    it('read() gives one item with text/plain and image/png, in that order, for a clip carrying both', async () => {
      const host = install()
      const pending = clipboard().read()
      host.answer({ id: host.sent[0].id, text: 'caption', image: { png: PNG_BASE64 } })
      const items = await pending
      expect(items).toHaveLength(1)
      expect(items[0].types).toEqual(['text/plain', 'image/png'])
      expect(await (await items[0].getType('text/plain')).text()).toBe('caption')
      const png = await items[0].getType('image/png')
      expect(png.type).toBe('image/png')
      expect(await bytesOf(png)).toEqual(PNG_BYTES)
    })

    it('read() gives one image/png item for an image alone', async () => {
      const host = install()
      const pending = clipboard().read()
      host.answer({
        id: host.sent[0].id,
        text: '',
        image: { png: PNG_BASE64, width: 8, height: 8 }
      })
      const items = await pending
      expect(items).toHaveLength(1)
      expect(items[0].types).toEqual(['image/png'])
      expect(await bytesOf(await items[0].getType('image/png'))).toEqual(PNG_BYTES)
    })

    it('hands the text alone when the image does not decode: malformed base64, or no png string', async () => {
      const host = install()
      const malformed = clipboard().read()
      host.answer({ id: host.sent[0].id, text: 'still here', image: { png: '%%not base64%%' } })
      const items = await malformed
      expect(items).toHaveLength(1)
      expect(items[0].types).toEqual(['text/plain'])

      const shapeless = clipboard().read()
      host.answer({
        id: host.sent[1].id,
        text: 'still here',
        image: { png: 42 } as unknown as ClipboardReadResult['image']
      })
      expect((await shapeless)[0].types).toEqual(['text/plain'])

      // Neither text nor a decodable image: the empty list, as for an empty clipboard.
      const nothing = clipboard().read()
      host.answer({ id: host.sent[2].id, text: '', image: { png: '%%not base64%%' } })
      await expect(nothing).resolves.toEqual([])
    })

    it('readText() is the text, whatever image came with it', async () => {
      const host = install()
      const pending = clipboard().readText()
      host.answer({ id: host.sent[0].id, text: 'words', image: { png: PNG_BASE64 } })
      await expect(pending).resolves.toBe('words')
    })

    it('decodes whatever size the host hands – the cap is the host’s (2048 px, 8 MiB), the page side has none', async () => {
      const host = install()
      // A megabyte of bytes with every value in it, so the round trip proves the decode whole.
      const big = new Uint8Array(1024 * 1024)
      for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff
      let binary = ''
      for (let i = 0; i < big.length; i += 0x8000) {
        binary += String.fromCharCode(...big.subarray(i, i + 0x8000))
      }
      const pending = clipboard().read()
      host.answer({ id: host.sent[0].id, text: '', image: { png: btoa(binary) } })
      const items = await pending
      expect(items[0].types).toEqual(['image/png'])
      const blob = await items[0].getType('image/png')
      expect(blob.size).toBe(big.length)
      expect(Buffer.compare(Buffer.from(await blob.arrayBuffer()), Buffer.from(big))).toBe(0)
    })
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

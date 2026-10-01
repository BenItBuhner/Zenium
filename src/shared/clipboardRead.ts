/**
 * `navigator.clipboard.read()` / `readText()` where the engine refuses every read (MW-38). The
 * Android WebView denies `CLIPBOARD_READ_WRITE` outright (`aw_permission_manager.cc`), so a
 * page's read never reaches a prompt there: `installClipboardReadShim` runs in the page's main
 * world and routes the two reads to the browser, which decides the site's `clipboard-read`
 * permission as the desktop's engine has it decided (the same prompt, the same remembered
 * answer, the same Settings row – `PermissionService`) and reads the clipboard through the host
 * (`ClipboardReadService`).
 *
 * Chrome's two gates are the shim's two gates
 * (`third_party/blink/renderer/modules/clipboard/clipboard_promise.cc`): a focused document
 * (`RejectIfDocumentNotFocused`: "Document is not focused.") and the permission – refused, the
 * promise rejects with a `NotAllowedError` reading "Read permission denied."
 * (`HandleReadTextWithPermission`). No user activation is asked of a read, as Chrome asks none
 * (its descriptor's `has_user_gesture` serves the sanitized-write shortcut alone,
 * `blink/common/permissions/permission_utils.cc`). A secure context is the engine's own gate
 * already: the `Clipboard` interface is `[SecureContext]`, so there is nothing to shim elsewhere.
 *
 * `read()` answers as Chrome does for the clip's representations: ONE `ClipboardItem` carrying
 * every type the clipboard holds (`clipboard_promise.cc` `ResolveRead` builds a single item from
 * all the types read), `text/plain` first and `image/png` after it – the order
 * `ui/base/clipboard/clipboard_android.cc` `ReadAvailableTypes` lists them – and an empty list
 * for a clipboard holding neither. The image is the host's (`ClipboardImage`: PNG, base64,
 * bounded there); the shim decodes it to a `Blob` and hands the text alone when the bytes do not
 * decode. `readText()` is the text, as before.
 *
 * Lazy by design: installing defines the two functions on `Clipboard.prototype` and nothing
 * more – no listener, no map, no read – so a page that never calls them pays nothing at load
 * (the script is on the phone's boot path).
 */

import type { ClipboardImage } from './types'

/** `text`: `readText()`, the string. `items`: `read()`, a `ClipboardItem` list made of it. */
export type ClipboardReadKind = 'text' | 'items'

/** One read of the page's shim, up to the browser. */
export interface ClipboardReadCall {
  id: string
  kind: ClipboardReadKind
}

/**
 * The browser's answer to one call: the clipboard's text (and, for `read()`, the clip's image
 * where the host read one), or the refusal.
 */
export interface ClipboardReadResult {
  id: string
  text?: string
  image?: ClipboardImage
  error?: 'denied'
}

/** What the browser allowed: the text ('' for none) and the image where there is one. */
interface ClipboardReadAnswer {
  text: string
  image?: ClipboardImage
}

/** The host's image field as the page may receive it: the PNG's base64, or nothing usable. */
function imageOf(value: unknown): ClipboardImage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const png = (value as { png?: unknown }).png
  return typeof png === 'string' && png !== '' ? { png } : undefined
}

export interface ClipboardReadTransport {
  /** The shim's call, to the browser. */
  send(call: ClipboardReadCall): void
  /** The browser's answers, to the shim. */
  onResult(listener: (result: ClipboardReadResult) => void): void
}

export function isClipboardReadCall(value: unknown): value is ClipboardReadCall {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return typeof c.id === 'string' && c.id !== '' && (c.kind === 'text' || c.kind === 'items')
}

/** Chrome's words (`clipboard_promise.cc`), verbatim, so a page's error handling sees the same. */
export const CLIPBOARD_READ_DENIED = 'Read permission denied.'
export const CLIPBOARD_READ_UNFOCUSED = 'Document is not focused.'

/**
 * Runs in the page's main world, the bridge in the same world (the phone's page script). The
 * two functions go on `Clipboard.prototype`, where the engine's own are, so `navigator.clipboard
 * instanceof Clipboard` and a page's `Clipboard.prototype.readText.call(navigator.clipboard)`
 * hold as before; `read` only where `ClipboardItem` exists to answer with. Nothing else happens
 * until a page calls one of them.
 */
export function installClipboardReadShim(
  transport: ClipboardReadTransport,
  win: Window & typeof globalThis = globalThis as Window & typeof globalThis
): void {
  const proto = (win as unknown as { Clipboard?: { prototype: Clipboard } }).Clipboard?.prototype
  if (!proto) return
  const doc = win.document
  const ClipboardItemCtor = (win as unknown as { ClipboardItem?: typeof ClipboardItem })
    .ClipboardItem

  type Waiter = { resolve: (answer: ClipboardReadAnswer) => void; reject: (error: Error) => void }
  let pending: Map<string, Waiter> | null = null
  let counter = 0

  /** The first call brings the listener; the browser's answer finds its waiter by id. */
  const listen = (): Map<string, Waiter> => {
    if (pending) return pending
    const map = new Map<string, Waiter>()
    pending = map
    transport.onResult((result) => {
      if (!result || typeof result.id !== 'string') return
      const waiter = map.get(result.id)
      if (!waiter) return
      map.delete(result.id)
      if (typeof result.text === 'string') {
        waiter.resolve({ text: result.text, image: imageOf(result.image) })
      } else {
        waiter.reject(new win.DOMException(CLIPBOARD_READ_DENIED, 'NotAllowedError'))
      }
    })
    return map
  }

  /**
   * The host's PNG (base64) as a `Blob` for the item; null for bytes that do not decode (the
   * text still goes to the page). The host bounds the size (`ClipboardImage`); the page side
   * takes what it is handed – one `atob`, one typed array, no cap of its own.
   */
  const pngBlob = (image: ClipboardImage | undefined): Blob | null => {
    if (!image) return null
    try {
      const binary = win.atob(image.png)
      const bytes = new win.Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new win.Blob([bytes], { type: 'image/png' })
    } catch {
      return null
    }
  }

  const refusal = (name: string): Error | null => {
    const prefix = `Failed to execute '${name}' on 'Clipboard': `
    let focused = true
    try {
      focused = doc.hasFocus()
    } catch {
      /* a document that cannot say is taken as focused, as a worker's absence of one is */
    }
    if (!focused) return new win.DOMException(prefix + CLIPBOARD_READ_UNFOCUSED, 'NotAllowedError')
    return null
  }

  const ask = (name: string, kind: ClipboardReadKind): Promise<ClipboardReadAnswer> => {
    const refused = refusal(name)
    if (refused) return Promise.reject(refused)
    const waiters = listen()
    const id = `clip-${++counter}`
    return new Promise<ClipboardReadAnswer>((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      try {
        transport.send({ id, kind })
      } catch (error) {
        waiters.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const define = (name: string, value: unknown): void => {
    try {
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      })
    } catch {
      /* a frozen prototype keeps the engine's own */
    }
  }

  define('readText', function readText(this: Clipboard): Promise<string> {
    return ask('readText', 'text').then((answer) => answer.text)
  })
  if (typeof ClipboardItemCtor === 'function') {
    define('read', function read(this: Clipboard): Promise<ClipboardItem[]> {
      // One item with every representation the clip has, as Chrome hands one `ClipboardItem`
      // for the system clipboard (`clipboard_promise.cc` `ResolveRead`): `text/plain` for a
      // clipboard that has text, `image/png` for one that has an image the host could read,
      // both for a clip that carries both – in that order (`clipboard_android.cc`
      // `ReadAvailableTypes`); an empty list for a clipboard holding neither (`readText` says
      // '' there).
      return ask('read', 'items').then((answer) => {
        const types: Record<string, Blob> = {}
        if (answer.text !== '') {
          types['text/plain'] = new win.Blob([answer.text], { type: 'text/plain' })
        }
        const png = pngBlob(answer.image)
        if (png) types['image/png'] = png
        return Object.keys(types).length === 0 ? [] : [new ClipboardItemCtor(types)]
      })
    })
  }
}

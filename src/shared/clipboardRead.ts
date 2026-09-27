/**
 * `navigator.clipboard.read()` / `readText()` where the engine refuses every read (MW-38). The
 * Android WebView denies `CLIPBOARD_READ_WRITE` outright (`aw_permission_manager.cc`), so a
 * page's read never reaches a prompt there: `installClipboardReadShim` runs in the page's main
 * world and routes the two reads to the browser, which decides the site's `clipboard-read`
 * permission as the desktop's engine has it decided (the same prompt, the same remembered
 * answer, the same Settings row – `PermissionService`) and reads the clipboard through the host
 * (`ClipboardReadService`).
 *
 * Chrome's gates, kept (`third_party/blink/renderer/modules/clipboard/clipboard_promise.cc`):
 * a secure context (the `Clipboard` interface is `[SecureContext]`, so there is nothing to shim
 * elsewhere), a focused document (`RejectIfDocumentNotFocused`: "Document is not focused."),
 * and the permission – refused, the promise rejects with a `NotAllowedError` reading "Read
 * permission denied." (`HandleReadTextWithPermission`). Zenium's stricter gate on top: a
 * transient user activation (`navigator.userActivation.isActive`), which Chrome does not ask
 * of a read (its descriptor's `has_user_gesture` serves the sanitized-write shortcut alone,
 * `blink/common/permissions/permission_utils.cc`) but Safari and Firefox do – a page that has
 * not been touched gets no prompt and no read, as the brief for the phone asked.
 *
 * Lazy by design: installing defines the two functions on `Clipboard.prototype` and nothing
 * more – no listener, no map, no read – so a page that never calls them pays nothing at load
 * (the script is on the phone's boot path).
 */

/** `text`: `readText()`, the string. `items`: `read()`, a `ClipboardItem` list made of it. */
export type ClipboardReadKind = 'text' | 'items'

/** One read of the page's shim, up to the browser. */
export interface ClipboardReadCall {
  id: string
  kind: ClipboardReadKind
}

/** The browser's answer to one call: the clipboard's text, or the refusal. */
export interface ClipboardReadResult {
  id: string
  text?: string
  error?: 'denied'
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
/** Zenium's own gate, in the register of Chrome's share message. */
export const CLIPBOARD_READ_NO_GESTURE = 'Must be handling a user gesture to read the clipboard.'

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

  type Waiter = { resolve: (text: string) => void; reject: (error: Error) => void }
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
      if (typeof result.text === 'string') waiter.resolve(result.text)
      else waiter.reject(new win.DOMException(CLIPBOARD_READ_DENIED, 'NotAllowedError'))
    })
    return map
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
    const activation = (win.navigator as Navigator & { userActivation?: { isActive: boolean } })
      .userActivation
    if (activation && !activation.isActive)
      return new win.DOMException(prefix + CLIPBOARD_READ_NO_GESTURE, 'NotAllowedError')
    return null
  }

  const ask = (name: string, kind: ClipboardReadKind): Promise<string> => {
    const refused = refusal(name)
    if (refused) return Promise.reject(refused)
    const waiters = listen()
    const id = `clip-${++counter}`
    return new Promise<string>((resolve, reject) => {
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
    return ask('readText', 'text')
  })
  if (typeof ClipboardItemCtor === 'function') {
    define('read', function read(this: Clipboard): Promise<ClipboardItem[]> {
      // The host hands text alone: one `text/plain` item for a clipboard that has some, an
      // empty list for one that does not (an image, or nothing) – `readText` says '' there.
      return ask('read', 'items').then((text) =>
        text === ''
          ? []
          : [new ClipboardItemCtor({ 'text/plain': new win.Blob([text], { type: 'text/plain' }) })]
      )
    })
  }
}

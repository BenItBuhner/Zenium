/**
 * Web Share (MW-21): `navigator.share` / `navigator.canShare` for hosts whose engine has no
 * share service (Electron leaves both undefined). `installShareShim` runs in the page's main
 * world and gives the page Chrome's API – its argument checks, its errors and its one-at-a-time
 * rule – posting each call to the isolated world, whose `installShareBridge` hands it to the
 * browser. The browser's share sheet (`ShareService`) answers with `shared` (the promise
 * resolves) or `aborted` (it rejects with `AbortError`, as when Chrome's sheet is dismissed).
 *
 * Files travel as base64 in the message; Chrome's own limits apply (10 files, 50 MB in all).
 *
 * On Android (SH-14) the shim and the bridge share the page's one world, the host spills the
 * files to its cache on the way through (`ShareFile.uri`, a `content:` address behind its
 * FileProvider) and the OS's own sheet takes the call: the chosen target resolves the promise,
 * a dismissed sheet rejects it.
 */

/**
 * A file the page shared: its bytes as base64 (`data`), or – once a host has written them to a
 * file of its own on the way to its share sheet – the file's address (`uri`). One of the two.
 */
export interface ShareFile {
  name: string
  type: string
  size: number
  /** The bytes, base64. */
  data?: string
  /** The host's copy of the file (a `content:` URI on Android); the bytes are no longer carried. */
  uri?: string
}

/** What the sheet shows about a shared file (no bytes). */
export interface ShareFileInfo {
  name: string
  type: string
  size: number
}

/** One `navigator.share` call. */
export interface ShareCall {
  id: string
  title: string
  text: string
  /** Absolute http(s) URL, or ''. */
  url: string
  files: ShareFile[]
}

export type ShareOutcome = 'shared' | 'aborted'

/** Chrome's caps on `navigator.share` files. */
export const SHARE_MAX_FILES = 10
export const SHARE_MAX_BYTES = 50 * 1024 * 1024

export interface ShareShimEvents {
  /** Main world → isolated world: a `ShareCall`, JSON in `detail`. */
  request: string
  /** Isolated world → main world: `{ id, result }`, JSON in `detail`. */
  result: string
}

export const SHARE_EVENTS: ShareShimEvents = {
  request: 'zen-share-request',
  result: 'zen-share-result'
}

export interface ShareBridgeTransport {
  send(call: ShareCall): void
  onResult(listener: (id: string, result: ShareOutcome) => void): void
  installShim(events: ShareShimEvents): void
}

export function isShareFile(value: unknown): value is ShareFile {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  if (typeof f.name !== 'string' || typeof f.type !== 'string' || typeof f.size !== 'number')
    return false
  const data = typeof f.data === 'string'
  const uri = typeof f.uri === 'string' && f.uri.length > 0
  return data !== uri
}

/** Whether a value has the shape of a share call within Chrome's limits (the page is not trusted). */
export function isShareCall(value: unknown): value is ShareCall {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string' || !c.id) return false
  if (typeof c.title !== 'string' || typeof c.text !== 'string' || typeof c.url !== 'string')
    return false
  if (c.url && !/^https?:\/\//i.test(c.url)) return false
  if (!Array.isArray(c.files) || c.files.length > SHARE_MAX_FILES) return false
  if (!c.files.every(isShareFile)) return false
  const total = (c.files as ShareFile[]).reduce((sum, f) => sum + f.size, 0)
  if (total > SHARE_MAX_BYTES) return false
  return Boolean(c.title || c.text || c.url || c.files.length > 0)
}

/** The sheet's view of a call: no bytes. */
export function shareFileInfo(file: ShareFile): ShareFileInfo {
  return { name: file.name, type: file.type, size: file.size }
}

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`: one self-contained
 * function (it is serialised), taking everything it needs as arguments. Defines `share` and
 * `canShare` in secure top-level documents, as Chrome exposes them.
 */
export function installShareShim(events: ShareShimEvents): void {
  const win = globalThis as Window & typeof globalThis
  const doc = win.document
  try {
    if (!win.isSecureContext) return
    if (win !== win.top) return
  } catch {
    return
  }
  const MAX_FILES = 10
  const MAX_BYTES = 50 * 1024 * 1024
  interface Data {
    title?: unknown
    text?: unknown
    url?: unknown
    files?: unknown
  }
  const define = (target: object, name: string, value: unknown): void => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      })
    } catch {
      /* a frozen prototype keeps the engine's own */
    }
  }
  const resolveUrl = (value: unknown): string | null => {
    if (value === undefined) return ''
    try {
      const url = new URL(String(value), doc.baseURI)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
    } catch {
      return null
    }
  }
  const isFileList = (value: unknown): value is File[] =>
    Array.isArray(value) && value.every((f) => f instanceof win.File)
  /** Chrome's `canShare` rule: some known member, a parseable http(s) URL, files within limits. */
  const shareable = (data: unknown): boolean => {
    if (!data || typeof data !== 'object') return false
    const d = data as Data
    const known =
      d.title !== undefined || d.text !== undefined || d.url !== undefined || d.files !== undefined
    if (!known) return false
    if (d.url !== undefined && resolveUrl(d.url) === null) return false
    if (d.files !== undefined) {
      if (!isFileList(d.files)) return false
      if (d.files.length > MAX_FILES) return false
      if (d.files.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES) return false
    }
    return true
  }
  const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < view.length; i += chunk)
      binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + chunk)))
    return win.btoa(binary)
  }

  let pending: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  let counter = 0
  doc.addEventListener(events.result, (e) => {
    let payload: { id?: unknown; result?: unknown }
    try {
      const detail = (e as CustomEvent<unknown>).detail
      payload = typeof detail === 'string' ? JSON.parse(detail) : (detail as typeof payload)
    } catch {
      return
    }
    if (!pending || !payload || payload.id !== pending.id) return
    const current = pending
    pending = null
    if (payload.result === 'shared') current.resolve()
    else current.reject(new DOMException('Share canceled', 'AbortError'))
  })

  const share = function (this: Navigator, data?: unknown): Promise<void> {
    const prefix = "Failed to execute 'share' on 'Navigator': "
    if (data === undefined || data === null || typeof data !== 'object')
      return Promise.reject(new TypeError(`${prefix}1 argument required, but only 0 present.`))
    const d = data as Data
    const known =
      d.title !== undefined || d.text !== undefined || d.url !== undefined || d.files !== undefined
    if (!known)
      return Promise.reject(
        new TypeError(
          `${prefix}No known share data fields supplied. If using only new fields (e.g. 'files'), you must feature-detect first.`
        )
      )
    const url = resolveUrl(d.url)
    if (url === null) return Promise.reject(new TypeError(`${prefix}Invalid URL`))
    if (d.files !== undefined && !isFileList(d.files))
      return Promise.reject(
        new TypeError(`${prefix}The provided value is not a sequence of files.`)
      )
    const activation = (win.navigator as Navigator & { userActivation?: { isActive: boolean } })
      .userActivation
    if (activation && !activation.isActive)
      return Promise.reject(
        new DOMException(
          `${prefix}Must be handling a user gesture to perform a share request.`,
          'NotAllowedError'
        )
      )
    if (pending)
      return Promise.reject(
        new DOMException(`${prefix}An earlier share had not yet completed.`, 'InvalidStateError')
      )
    const files = d.files ?? []
    if (files.length > MAX_FILES || files.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES)
      return Promise.reject(new DOMException(`${prefix}Permission denied`, 'NotAllowedError'))
    const id = `share-${++counter}-${Date.now()}`
    return new Promise<void>((resolve, reject) => {
      pending = { id, resolve, reject }
      Promise.all(
        files.map((f) =>
          f.arrayBuffer().then((bytes) => ({
            name: String(f.name),
            type: String(f.type),
            size: f.size,
            data: toBase64(bytes)
          }))
        )
      )
        .then((encoded) => {
          if (!pending || pending.id !== id) return
          doc.dispatchEvent(
            new CustomEvent(events.request, {
              detail: JSON.stringify({
                id,
                title: d.title === undefined ? '' : String(d.title),
                text: d.text === undefined ? '' : String(d.text),
                url,
                files: encoded
              })
            })
          )
        })
        .catch(() => {
          if (!pending || pending.id !== id) return
          pending = null
          reject(new DOMException(`${prefix}Permission denied`, 'NotAllowedError'))
        })
    })
  }
  const canShare = function (this: Navigator, data?: unknown): boolean {
    return data === undefined ? false : shareable(data)
  }
  const proto = (win as unknown as { Navigator?: { prototype: Navigator } }).Navigator?.prototype
  if (proto) {
    define(proto, 'share', share)
    define(proto, 'canShare', canShare)
  } else {
    define(win.navigator, 'share', share)
    define(win.navigator, 'canShare', canShare)
  }
}

/** The isolated-world half: the shim's calls go to the browser, the browser's answers back. */
export function installShareBridge(
  transport: ShareBridgeTransport,
  events: ShareShimEvents = SHARE_EVENTS
): void {
  document.addEventListener(events.request, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    let value: unknown = detail
    if (typeof detail === 'string') {
      try {
        value = JSON.parse(detail)
      } catch {
        return
      }
    }
    if (isShareCall(value)) transport.send(value)
    else if (
      value &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string'
    )
      // A call the checks refuse ends for the page as a cancelled share.
      document.dispatchEvent(
        new CustomEvent(events.result, {
          detail: JSON.stringify({ id: (value as { id: string }).id, result: 'aborted' })
        })
      )
  })
  transport.onResult((id, result) => {
    document.dispatchEvent(
      new CustomEvent(events.result, { detail: JSON.stringify({ id, result }) })
    )
  })
  transport.installShim(events)
}

import { sha256Hex } from './sha256'
import {
  encodeImageThumbnail,
  readImageThumbnail,
  type ImageFetchResult,
  type ImageReadCanvas,
  type ImageReadOptions,
  type ImageReadWorld
} from './imageUpload'
import type { ImageThumbnailBounds } from './types'

/**
 * The frame side of the phone's frame-owner protocol for the image-search row
 * (`internal/parity-services/frame-owner-protocol-interface.md`; Android's Kotlin half pairs
 * with this at `v: 1`). The page's `<img>` the user long-pressed may sit in any frame – an
 * embedded player's, an ad's – and today's phone path evaluates the thumbnail script in the
 * top document, whose world may not hold the image. So the host asks *every* frame, over the
 * `__zenPageBridge` message channel each frame already has, which of them holds the image:
 * not by its address, which reaches no frame that does not already have it, but by a nonce –
 * each frame answers with the salted hashes `sha256(nonce ‖ url)` of every image address it
 * may name (§3), synchronously on receipt; the host matches the hit-tested address's hash
 * against the lists, sends the owner alone the thumbnail ask, and the owner draws its own
 * `<img>` (the renderer's decoded copy: no request, cookies and referrer moot) or, where the
 * canvas taints, fetches the address it already holds with #555's read
 * (`shared/imageUpload.ts`), and answers with #555's `ImageFetchResult` – base64 in the JSON,
 * one path – or a typed refusal.
 *
 * The prelude runs in the frame's main world at document start (§4.1), so the built-ins the
 * answer and the thumbnail rely on are captured at install, before any page script, and called
 * as captured: a page patching `JSON.stringify`, `fetch`, the canvas or `TextEncoder` cannot
 * make the frame lie about holding what it lacks (it cannot hash an address it does not know)
 * nor hand its own bytes in for the thumbnail. What the main world does not give is
 * confidentiality: the owner page can watch the frame draw or fetch its own image – nothing it
 * could not do itself, under the same CORS rules. Install does no work until a message arrives:
 * no enumeration, no hashing at load, in every frame of every page.
 */

export const IMAGE_OWNER_PROTOCOL_VERSION = 1
/** The most hashes one frame answers with (§2.2); a frame holding more says `truncated`. */
export const OWNER_MAX_HASHES = 2048
export const IMAGE_OWNER_QUESTION_TYPE = 'zen:image-owner?'
export const IMAGE_OWNER_ANSWER_TYPE = 'zen:image-owner'
export const IMAGE_THUMBNAIL_TYPE = 'zen:image-thumbnail'

/** Host → every frame (§2.1): the nonce only; the frame answers with all it holds. */
export interface ImageOwnerQuestion {
  v: 1
  type: typeof IMAGE_OWNER_QUESTION_TYPE
  /** 16 random bytes as 32 lowercase hex characters: the request's identity everywhere. */
  nonce: string
  alg: 'sha256'
}

/** Frame → host (§2.2): the salted hashes of the addresses it may name, deduplicated, in document order. */
export interface ImageOwnerAnswer {
  v: 1
  type: typeof IMAGE_OWNER_ANSWER_TYPE
  nonce: string
  hashes: string[]
  truncated: boolean
}

/** Host → the owner frame alone (§2.3): which of its images, and how to thumbnail it. */
export interface ImageThumbnailAsk {
  v: 1
  type: typeof IMAGE_THUMBNAIL_TYPE
  nonce: string
  /** The matching hash: the frame recomputes its candidates' and takes the elements whose equals it. */
  hash: string
  /** The engine's bounds (`LENS_IMAGE_THUMBNAIL` / `GENERIC_IMAGE_THUMBNAIL`), sent so the frame holds no engine table. */
  bounds: ImageThumbnailBounds
  /** `IMAGE_THUMBNAIL_JPEG_QUALITY`. */
  quality: number
  /** `IMAGE_UPLOAD_MAX_BYTES`. */
  maxBytes: number
}

/** Owner → host (§2.4): #555's `ImageFetchResult`, the thumbnail or a typed refusal. */
export interface ImageThumbnailAnswer {
  v: 1
  type: typeof IMAGE_THUMBNAIL_TYPE
  nonce: string
  result: ImageFetchResult
}

/** The channel the answerer listens on and answers through: the WebMessageListener's `__zenPageBridge`. */
export interface ImageOwnerBridge {
  postMessage(message: string): void
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
  onmessage?: ((event: { data: string }) => void) | null
}

export interface ImageOwnerHooks {
  /**
   * The session token every message up the bridge carries, written last so no field of the
   * message displaces it: Kotlin's `routePageMessage` drops a message without the session's as
   * a page's forgery.
   */
  token: string
  /** The salted hash (§2.5); the default is the protocol's, a test's spy may stand in. */
  hash?: (nonce: string, url: string) => string
}

/** One address a frame may name (§3) and the element that names it. */
export interface ImageOwnerCandidate {
  /** The address as the protocol hashes it: cut at the first `#`, nothing else touched. */
  url: string
  element: HTMLImageElement | HTMLInputElement
  kind: 'img' | 'input'
}

const NONCE = /^[0-9a-f]{32}$/
const HASH = /^[0-9a-f]{64}$/

/**
 * The address as both sides hash it (§2.6): the browser's canonical serialisation, cut at the
 * first `#` – in a canonical URL `#` occurs only as the fragment delimiter – with no other
 * normalisation (no lowercasing, no re-encoding, no trailing-slash or default-port edits): the
 * hit test's string and `img.currentSrc` come out of the same canonicaliser.
 */
export function imageOwnerUrl(url: string): string {
  const fragment = url.indexOf('#')
  return fragment < 0 ? url : url.slice(0, fragment)
}

/**
 * `lowercase_hex(SHA-256(UTF-8(nonce ‖ url)))` (§2.5): the nonce's 32 characters immediately
 * followed by the address (its fragment cut), no separator, no length prefix. `encode` is the
 * UTF-8 encoder – the answerer's captured `TextEncoder`; the world's by default.
 */
export function imageOwnerHash(
  nonce: string,
  url: string,
  encode: (text: string) => Uint8Array = (text) => new TextEncoder().encode(text)
): string {
  return sha256Hex(encode(nonce + imageOwnerUrl(url)))
}

/**
 * What the frame may name (§3), in document order, deduplicated on the cut address: for every
 * `<img>` its `currentSrc` (the picked `srcset`/`<picture>` candidate, completed, once the
 * request is current), its `src` (the resolved attribute – the hit test's value when no
 * candidate was picked, the pre-upgrade address on a mixed-content auto-upgrade) and
 * `currentSrc` completed against the document's base (on a load error `currentSrc` is the raw
 * candidate, possibly relative – this is the completion the hit test applied); for every
 * `<input type=image>` its `src`. Empty strings skipped. `getElementsByTagName` is the
 * caller's captured method (`document.images` by another name: every `<img>` in document
 * order); `resolve` its captured `URL`.
 */
export function imageOwnerCandidates(
  doc: Document,
  getElementsByTagName: (
    this: Document,
    name: string
  ) => HTMLCollectionOf<Element> = doc.getElementsByTagName,
  resolve: (url: string, base: string) => string = (url, base) => new URL(url, base).href
): ImageOwnerCandidate[] {
  const out: ImageOwnerCandidate[] = []
  const seen = new Set<string>()
  const name = (
    url: unknown,
    element: ImageOwnerCandidate['element'],
    kind: 'img' | 'input'
  ): void => {
    if (typeof url !== 'string' || !url) return
    const cut = imageOwnerUrl(url)
    if (!cut || seen.has(cut)) return
    seen.add(cut)
    out.push({ url: cut, element, kind })
  }
  const images = getElementsByTagName.call(doc, 'img')
  for (let i = 0; i < images.length; i++) {
    const img = images[i] as HTMLImageElement
    const current = img.currentSrc
    name(current, img, 'img')
    name(img.src, img, 'img')
    if (typeof current === 'string' && current) {
      try {
        name(resolve(current, doc.baseURI), img, 'img')
      } catch {
        /* a candidate no URL parser takes: the two above name it */
      }
    }
  }
  const inputs = getElementsByTagName.call(doc, 'input')
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] as HTMLInputElement
    if (input.type === 'image') name(input.src, input, 'input')
  }
  return out
}

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

/** The built-ins taken at install (§4.1), as the frame's world had them before any page script. */
interface Captured {
  postMessage: (message: string) => void
  parse: (text: string) => unknown
  stringify: (value: unknown) => string
  URL?: typeof URL
  TextEncoder?: typeof TextEncoder
  encode?: (this: TextEncoder, text: string) => Uint8Array
  getElementsByTagName: (this: Document, name: string) => HTMLCollectionOf<Element>
  createElement: (this: Document, name: string) => HTMLElement
  getContext?: (this: HTMLCanvasElement, id: '2d') => CanvasRenderingContext2D | null
  toBlob?: (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type: string,
    quality: number
  ) => void
  OffscreenCanvas?: typeof OffscreenCanvas
  offscreenGetContext?: (
    this: OffscreenCanvas,
    id: '2d'
  ) => OffscreenCanvasRenderingContext2D | null
  convertToBlob?: (
    this: OffscreenCanvas,
    options: { type: string; quality: number }
  ) => Promise<Blob>
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>
  fetch?: ImageReadWorld['fetch']
  responseBlob?: (this: Response) => Promise<Blob>
  responseBody?: (this: Response) => ReadableStream<Uint8Array<ArrayBuffer>> | null
  blobArrayBuffer?: (this: Blob) => Promise<ArrayBuffer>
  Blob?: typeof Blob
  Image?: typeof Image
  atob?: (text: string) => string
}

function capture(bridge: ImageOwnerBridge, doc: Document): Captured {
  const g = globalThis as unknown as Record<string, unknown>
  const ctor = <T>(name: string): T | undefined =>
    typeof g[name] === 'function' ? (g[name] as T) : undefined
  const proto = (name: string): object | undefined => {
    const c = g[name]
    return typeof c === 'function' ? (c as { prototype: object }).prototype : undefined
  }
  const method = <T>(owner: object | undefined, name: string): T | undefined => {
    if (!owner) return undefined
    const value = (owner as Record<string, unknown>)[name]
    return typeof value === 'function' ? (value as T) : undefined
  }
  const getter = <T>(owner: object | undefined, name: string): T | undefined => {
    if (!owner) return undefined
    const get = Object.getOwnPropertyDescriptor(owner, name)?.get
    return typeof get === 'function' ? (get as T) : undefined
  }
  const json = g.JSON as { parse: Captured['parse']; stringify: Captured['stringify'] }
  return {
    postMessage: bridge.postMessage,
    parse: json.parse,
    stringify: json.stringify,
    URL: ctor('URL'),
    TextEncoder: ctor('TextEncoder'),
    encode: method(proto('TextEncoder'), 'encode'),
    getElementsByTagName: doc.getElementsByTagName,
    createElement: doc.createElement,
    getContext: method(proto('HTMLCanvasElement'), 'getContext'),
    toBlob: method(proto('HTMLCanvasElement'), 'toBlob'),
    OffscreenCanvas: ctor('OffscreenCanvas'),
    offscreenGetContext: method(proto('OffscreenCanvas'), 'getContext'),
    convertToBlob: method(proto('OffscreenCanvas'), 'convertToBlob'),
    createImageBitmap: ctor('createImageBitmap'),
    fetch: ctor('fetch'),
    responseBlob: method(proto('Response'), 'blob'),
    responseBody: getter(proto('Response'), 'body'),
    blobArrayBuffer: method(proto('Blob'), 'arrayBuffer'),
    Blob: ctor('Blob'),
    Image: ctor('Image'),
    atob: ctor('atob')
  }
}

/** #555's read over the captured built-ins: what `readImageThumbnail` and `encodeImageThumbnail` call. */
function worldOf(c: Captured, doc: Document): ImageReadWorld {
  const canvas = (width: number, height: number): ImageReadCanvas | null => {
    if (c.OffscreenCanvas && c.offscreenGetContext && c.convertToBlob) {
      try {
        const surface = new c.OffscreenCanvas(width, height)
        const context = c.offscreenGetContext.call(surface, '2d')
        if (context) {
          const convert = c.convertToBlob
          return {
            context,
            toJpeg: (quality) => convert.call(surface, { type: 'image/jpeg', quality })
          }
        }
      } catch {
        /* the element's canvas below */
      }
    }
    if (c.getContext && c.toBlob) {
      const surface = c.createElement.call(doc, 'canvas') as HTMLCanvasElement
      surface.width = width
      surface.height = height
      const context = c.getContext.call(surface, '2d')
      if (context) {
        const toBlob = c.toBlob
        return {
          context,
          toJpeg: (quality) =>
            new Promise<Blob | null>((resolve, reject) => {
              try {
                toBlob.call(surface, resolve, 'image/jpeg', quality)
              } catch (error) {
                reject(error)
              }
            })
        }
      }
    }
    return null
  }
  const none = (): Promise<never> => Promise.reject(new Error('unavailable'))
  return {
    fetch: (url, init) => (c.fetch ? c.fetch(url, init) : none()),
    responseBlob: (response) => (c.responseBlob ? c.responseBlob.call(response) : none()),
    responseBody: (response) => (c.responseBody ? c.responseBody.call(response) : null),
    arrayBuffer: (blob) => (c.blobArrayBuffer ? c.blobArrayBuffer.call(blob) : none()),
    newBlob: (parts, type) => {
      if (!c.Blob) throw new Error('unavailable')
      return new c.Blob(parts, { type })
    },
    createImageBitmap: c.createImageBitmap ? (blob) => c.createImageBitmap!(blob) : null,
    newImage: () => {
      if (c.Image) return new c.Image()
      return c.createElement.call(doc, 'img') as HTMLImageElement
    },
    createObjectURL: (blob) => {
      if (!c.URL) throw new Error('unavailable')
      return c.URL.createObjectURL(blob)
    },
    revokeObjectURL: (url) => {
      if (c.URL) c.URL.revokeObjectURL(url)
    },
    canvas,
    atob: (text) => {
      if (!c.atob) throw new Error('unavailable')
      return c.atob(text)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The ask's fields checked, or null for a message the frame ignores (§2.3; a mistyped field is not answered). */
function readAsk(message: Record<string, unknown>): ImageThumbnailAsk | null {
  if (typeof message.hash !== 'string' || !HASH.test(message.hash)) return null
  const bounds = message.bounds
  if (!isRecord(bounds)) return null
  const { maxSide, minArea } = bounds
  if (!isFiniteNumber(maxSide) || maxSide < 1 || !isFiniteNumber(minArea) || minArea < 0)
    return null
  const { quality, maxBytes } = message
  if (!isFiniteNumber(quality) || quality <= 0 || quality > 1) return null
  if (!isFiniteNumber(maxBytes) || maxBytes < 1) return null
  return {
    v: 1,
    type: IMAGE_THUMBNAIL_TYPE,
    nonce: message.nonce as string,
    hash: message.hash,
    bounds: { maxSide, minArea },
    quality,
    maxBytes
  }
}

/**
 * Listen on the bridge for the host's question and the owner's ask, and answer them (§2–§4).
 * Nothing runs until a message arrives; the built-ins are captured now (§4.1). Installed once
 * per frame from the prelude, after the page script's own listener where the bridge has no
 * `addEventListener` (the legacy bridge's single `onmessage` slot is chained, not replaced).
 * Nothing thrown here reaches the page.
 */
export function installImageOwner(
  bridge: ImageOwnerBridge,
  doc: Document,
  hooks: ImageOwnerHooks
): void {
  const c = capture(bridge, doc)
  let encoder: TextEncoder | null = null
  const encode = (text: string): Uint8Array => {
    if (c.TextEncoder && c.encode) {
      encoder ??= new c.TextEncoder()
      return c.encode.call(encoder, text)
    }
    return new TextEncoder().encode(text)
  }
  const hash = hooks.hash ?? ((nonce: string, url: string) => imageOwnerHash(nonce, url, encode))
  let world: ImageReadWorld | null = null
  const resolve = (url: string, base: string): string => {
    if (!c.URL) throw new Error('unavailable')
    return new c.URL(url, base).href
  }
  const candidates = (): ImageOwnerCandidate[] =>
    imageOwnerCandidates(doc, c.getElementsByTagName, resolve)

  const post = (message: ImageOwnerAnswer | ImageThumbnailAnswer): void => {
    try {
      c.postMessage.call(bridge, c.stringify({ ...message, token: hooks.token }))
    } catch {
      /* a bridge that is gone */
    }
  }
  const answer = (nonce: string): void => {
    const hashes: string[] = []
    let truncated = false
    for (const candidate of candidates()) {
      if (hashes.length >= OWNER_MAX_HASHES) {
        truncated = true
        break
      }
      hashes.push(hash(nonce, candidate.url))
    }
    const reply: ImageOwnerAnswer = {
      v: 1,
      type: IMAGE_OWNER_ANSWER_TYPE,
      nonce,
      hashes,
      truncated
    }
    post(reply)
  }
  const thumbnail = async (ask: ImageThumbnailAsk): Promise<ImageFetchResult> => {
    const matches = candidates().filter((candidate) => hash(ask.nonce, candidate.url) === ask.hash)
    if (!matches.length) return { ok: false, reason: 'gone' }
    const options: ImageReadOptions = {
      maxSide: ask.bounds.maxSide,
      minArea: ask.bounds.minArea,
      quality: ask.quality,
      maxBytes: ask.maxBytes
    }
    world ??= worldOf(c, doc)
    // Step 1 (§4.2): the frame's own <img>, the renderer's decoded copy – no request. A broken
    // or unloaded image (no natural size) and an <input type=image> (not a CanvasImageSource)
    // fall to step 2; a tainted canvas – cross-origin without CORS – falls to it too, and marks
    // a refused fetch there as `opaque`.
    let tainted = false
    for (const match of matches) {
      if (match.kind !== 'img') continue
      const img = match.element as HTMLImageElement
      if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) continue
      const drawn = await encodeImageThumbnail(
        { source: img, width: img.naturalWidth, height: img.naturalHeight },
        options,
        world
      )
      if (drawn.ok || drawn.reason === 'no-canvas') return drawn
      if (drawn.reason === 'tainted') {
        tainted = true
        break
      }
    }
    // Step 2: the frame's own fetch of the address it holds – #555's read, in the owner's frame.
    const fetched = await readImageThumbnail(matches[0].url, options, world)
    if (!fetched.ok && fetched.reason === 'fetch-failed' && tainted)
      return { ok: false, reason: 'opaque' }
    return fetched
  }
  const onMessage = (data: string): void => {
    const message = c.parse(data)
    if (!isRecord(message) || message.v !== IMAGE_OWNER_PROTOCOL_VERSION) return
    if (typeof message.nonce !== 'string' || !NONCE.test(message.nonce)) return
    const nonce = message.nonce
    if (message.type === IMAGE_OWNER_QUESTION_TYPE) {
      if (message.alg !== 'sha256') return
      answer(nonce)
    } else if (message.type === IMAGE_THUMBNAIL_TYPE) {
      const ask = readAsk(message)
      if (!ask) return
      const reply = (result: ImageFetchResult): void => {
        const message: ImageThumbnailAnswer = { v: 1, type: IMAGE_THUMBNAIL_TYPE, nonce, result }
        post(message)
      }
      thumbnail(ask).then(reply, () => reply({ ok: false, reason: 'decode-failed' }))
    }
  }
  const listener = (event: { data: string }): void => {
    try {
      if (event && typeof event.data === 'string') onMessage(event.data)
    } catch {
      /* never into the page */
    }
  }
  if (typeof bridge.addEventListener === 'function') {
    bridge.addEventListener('message', listener)
  } else {
    const previous = bridge.onmessage
    bridge.onmessage = (event) => {
      if (previous) previous.call(bridge, event)
      listener(event)
    }
  }
}

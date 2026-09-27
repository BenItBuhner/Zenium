// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GENERIC_IMAGE_THUMBNAIL,
  IMAGE_THUMBNAIL_JPEG_QUALITY,
  IMAGE_UPLOAD_MAX_BYTES,
  LENS_IMAGE_THUMBNAIL,
  imageThumbnailSize,
  type ImageFetchResult
} from '../imageUpload'
import {
  IMAGE_OWNER_ANSWER_TYPE,
  IMAGE_OWNER_QUESTION_TYPE,
  IMAGE_THUMBNAIL_TYPE,
  OWNER_MAX_HASHES,
  imageOwnerCandidates,
  imageOwnerHash,
  imageOwnerUrl,
  installImageOwner,
  type ImageOwnerAnswer,
  type ImageOwnerBridge,
  type ImageThumbnailAnswer
} from '../imageOwner'

/**
 * The frame side of the frame-owner protocol (`frame-owner-protocol-interface.md` §7.1), run
 * against a happy-dom document with the `__zenPageBridge` stand-in of `pageScript.test.ts`:
 * what the host posts down comes through `onmessage`, what the answerer sends up lands in
 * `posted`, the session token stamped last.
 */
const NONCE = '0123456789abcdef0123456789abcdef'
const NONCE_2 = 'fedcba9876543210fedcba9876543210'
/** §2.5's pinned vector: `sha256(NONCE ‖ 'https://example.com/a.png')`. */
const VECTOR = '5008d908d5e08c6645f6aa651b540491afe63dde85ea320e6774c2808abbd885'
const TOKEN = 'session-token'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

let posted: string[] = []
const bridge: ImageOwnerBridge = {
  postMessage: (message) => void posted.push(message),
  onmessage: null
}
function sent(): Array<Record<string, unknown>> {
  return posted.map((raw) => JSON.parse(raw) as Record<string, unknown>)
}
function down(message: Record<string, unknown>): void {
  bridge.onmessage!({ data: JSON.stringify(message) })
}
const question = (nonce = NONCE): Record<string, unknown> => ({
  v: 1,
  type: IMAGE_OWNER_QUESTION_TYPE,
  nonce,
  alg: 'sha256'
})
const ask = (
  hash: string,
  extra: Record<string, unknown> = {},
  nonce = NONCE
): Record<string, unknown> => ({
  v: 1,
  type: IMAGE_THUMBNAIL_TYPE,
  nonce,
  hash,
  bounds: LENS_IMAGE_THUMBNAIL,
  quality: IMAGE_THUMBNAIL_JPEG_QUALITY,
  maxBytes: IMAGE_UPLOAD_MAX_BYTES,
  ...extra
})
const hashOf = (url: string, nonce = NONCE): string => imageOwnerHash(nonce, url)

/** An `<img>` appended to the body; `loaded` gives it a natural size (happy-dom loads nothing), `currentSrc` a picked candidate. */
function img(
  src: string,
  options: { loaded?: { width: number; height: number }; currentSrc?: string } = {}
): HTMLImageElement {
  const element = document.createElement('img')
  if (src) element.setAttribute('src', src)
  if (options.loaded) {
    Object.defineProperty(element, 'naturalWidth', {
      value: options.loaded.width,
      configurable: true
    })
    Object.defineProperty(element, 'naturalHeight', {
      value: options.loaded.height,
      configurable: true
    })
  }
  if (options.currentSrc !== undefined)
    Object.defineProperty(element, 'currentSrc', { value: options.currentSrc, configurable: true })
  document.body.appendChild(element)
  return element
}

/** What the stood-in canvas saw. */
interface Painted {
  size: { width: number; height: number }
  drawn: unknown
  encode: { type: string; quality: number } | null
}
const painted: Painted[] = []
/** What the stood-in `toBlob` does: the JPEG, or a `SecurityError` for a cross-origin source (`taint`), or nothing. */
let encode: 'jpeg' | 'taint' | 'decline' | ((drawn: unknown) => 'jpeg' | 'taint') = 'jpeg'
const fetches: Array<{ url: string; init: RequestInit }> = []
let fetched: ((url: string) => Promise<Response>) | null = null
let bitmap: { width: number; height: number } | null = { width: 1600, height: 800 }

const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
const originalGetContext = canvasProto.getContext
const originalToBlob = canvasProto.toBlob

/** The world the frame's prelude finds at document start: the canvas, `createImageBitmap`, `fetch` stood in, `OffscreenCanvas` absent (the element's canvas serves). */
function standIn(): void {
  vi.stubGlobal('OffscreenCanvas', undefined)
  canvasProto.getContext = function (this: HTMLCanvasElement) {
    const seen: Painted = {
      size: { width: this.width, height: this.height },
      drawn: null,
      encode: null
    }
    painted.push(seen)
    ;(this as unknown as { __seen: Painted }).__seen = seen
    return {
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: (source: unknown) => {
        seen.drawn = source
      }
    }
  }
  canvasProto.toBlob = function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type: string,
    quality: number
  ) {
    const seen = (this as unknown as { __seen: Painted }).__seen
    seen.encode = { type, quality }
    const mode = typeof encode === 'function' ? encode(seen.drawn) : encode
    if (mode === 'taint') {
      const error = new Error('The canvas has been tainted by cross-origin data.')
      error.name = 'SecurityError'
      throw error
    }
    callback(mode === 'decline' ? null : new Blob([JPEG], { type: 'image/jpeg' }))
  }
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    if (!bitmap) throw new Error('declined')
    return { ...bitmap, close: () => undefined, blob }
  })
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    fetches.push({ url, init })
    return fetched ? fetched(url) : Promise.reject(new TypeError('Failed to fetch'))
  })
}

function install(hooks: { hash?: (nonce: string, url: string) => string } = {}): void {
  installImageOwner(bridge, document, { token: TOKEN, ...hooks })
}

const answers = (): ImageOwnerAnswer[] =>
  sent().filter((m) => m.type === IMAGE_OWNER_ANSWER_TYPE) as unknown as ImageOwnerAnswer[]
const thumbnails = (): ImageThumbnailAnswer[] =>
  sent().filter((m) => m.type === IMAGE_THUMBNAIL_TYPE) as unknown as ImageThumbnailAnswer[]
const thumbnail = async (): Promise<ImageFetchResult> => {
  await vi.waitFor(() => expect(thumbnails()).toHaveLength(1))
  return thumbnails()[0]!.result
}

beforeEach(() => {
  document.body.innerHTML = ''
  posted = []
  painted.length = 0
  fetches.length = 0
  fetched = null
  encode = 'jpeg'
  bitmap = { width: 1600, height: 800 }
  bridge.onmessage = null
  standIn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  canvasProto.getContext = originalGetContext
  canvasProto.toBlob = originalToBlob
})

describe('the frame-owner answerer (zen:image-owner?)', () => {
  it('pins the protocol vector and the address rule: the fragment cut, nothing else touched', () => {
    expect(imageOwnerHash(NONCE, 'https://example.com/a.png')).toBe(VECTOR)
    expect(imageOwnerHash(NONCE, 'https://example.com/a.png#icon')).toBe(VECTOR)
    expect(imageOwnerUrl('https://example.com/a.png#icon')).toBe('https://example.com/a.png')
    expect(imageOwnerUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(imageOwnerUrl('https://example.com/A.PNG?Q=1#a#b')).toBe('https://example.com/A.PNG?Q=1')
    // No lowercasing, no re-encoding: another hash for another spelling.
    expect(imageOwnerHash(NONCE, 'https://example.com/A.png')).not.toBe(VECTOR)
    expect(imageOwnerHash(NONCE_2, 'https://example.com/a.png')).not.toBe(VECTOR)
  })

  it('answers the question with the hashes of its images, deduplicated in document order, once, with the session token last', () => {
    img('https://example.com/a.png', { loaded: { width: 10, height: 10 } })
    img('https://example.com/b.png')
    img('https://example.com/a.png') // the same image twice: one hash
    install()
    down(question())
    expect(answers()).toHaveLength(1)
    const answer = answers()[0]!
    expect(answer).toEqual({
      v: 1,
      type: IMAGE_OWNER_ANSWER_TYPE,
      nonce: NONCE,
      hashes: [VECTOR, hashOf('https://example.com/b.png')],
      truncated: false,
      token: TOKEN
    })
    expect(Object.keys(answer).at(-1)).toBe('token')
    // No address crosses the channel.
    expect(posted[0]).not.toContain('example.com')
  })

  it('answers synchronously on receipt: the answer is posted before any microtask runs', async () => {
    img('https://example.com/a.png')
    install()
    let afterMicrotask = -1
    const probe = Promise.resolve().then(() => {
      afterMicrotask = posted.length
    })
    down(question())
    expect(posted).toHaveLength(1)
    await probe
    expect(afterMicrotask).toBe(1)
  })

  it('answers "I hold none" for a document without images, and a second question under another nonce afresh', () => {
    install()
    down(question())
    expect(answers()[0]).toMatchObject({ nonce: NONCE, hashes: [], truncated: false })
    img('https://example.com/a.png')
    down(question(NONCE_2))
    expect(answers()[1]).toMatchObject({
      nonce: NONCE_2,
      hashes: [hashOf('https://example.com/a.png', NONCE_2)]
    })
  })

  describe('what a frame may name (the normalisation table)', () => {
    it('names currentSrc and src both when a srcset candidate was picked', () => {
      img('https://example.com/a.png', { currentSrc: 'https://example.com/a-2x.png' })
      install()
      down(question())
      expect(answers()[0]!.hashes).toEqual([
        hashOf('https://example.com/a-2x.png'),
        hashOf('https://example.com/a.png')
      ])
    })

    it('names the completed address for a broken image whose currentSrc is the raw relative candidate', () => {
      img('https://example.com/dir/a.png', { currentSrc: 'sub/broken.png' })
      install()
      down(question())
      // The raw candidate, the resolved `src`, and the candidate completed against the base.
      expect(answers()[0]!.hashes).toEqual([
        hashOf('sub/broken.png'),
        hashOf('https://example.com/dir/a.png'),
        hashOf(new URL('sub/broken.png', document.baseURI).href)
      ])
    })

    it('cuts a fragment before hashing, so a sprite view hashes as its file', () => {
      img('https://example.com/sprite.svg#icon-a')
      img('https://example.com/sprite.svg#icon-b')
      install()
      down(question())
      expect(answers()[0]!.hashes).toEqual([hashOf('https://example.com/sprite.svg')])
    })

    it('names data: and blob: sources as written, and keeps an uppercase path as it is', () => {
      const data = 'data:image/png;base64,AQIDBA=='
      const blob = 'blob:https://example.com/0b1a2c3d-4e5f-6789-abcd-ef0123456789'
      img(data)
      img(blob)
      img('https://example.com/Dir/Image.PNG?Size=L')
      install()
      down(question())
      expect(answers()[0]!.hashes).toEqual([
        hashOf(data),
        hashOf(blob),
        hashOf('https://example.com/Dir/Image.PNG?Size=L')
      ])
      expect(answers()[0]!.hashes).not.toContain(hashOf('https://example.com/dir/image.png?size=l'))
    })

    it('names an <input type=image> by its src, skips an <img> without one', () => {
      img('')
      const input = document.createElement('input')
      input.setAttribute('type', 'IMAGE')
      input.setAttribute('src', 'https://example.com/go.png')
      document.body.appendChild(input)
      const text = document.createElement('input')
      text.setAttribute('type', 'text')
      text.setAttribute('src', 'https://example.com/not-an-image.png')
      document.body.appendChild(text)
      install()
      down(question())
      expect(answers()[0]!.hashes).toEqual([hashOf(input.src)])
      const candidates = imageOwnerCandidates(document)
      expect(candidates.map((c) => c.kind)).toEqual(['input'])
    })

    it('caps the answer at 2048 hashes and says so', () => {
      for (let i = 0; i < OWNER_MAX_HASHES + 1; i++) img(`https://example.com/i/${i}.png`)
      install()
      down(question())
      const answer = answers()[0]!
      expect(answer.hashes).toHaveLength(2048)
      expect(answer.truncated).toBe(true)
      expect(answer.hashes[0]).toBe(hashOf('https://example.com/i/0.png'))
      expect(answer.hashes[2047]).toBe(hashOf('https://example.com/i/2047.png'))
      expect(posted[0]!.length).toBeLessThan(140_000)
    })
  })

  describe('protocol hygiene', () => {
    it('ignores another version, a missing or malformed nonce, another algorithm, and a message that is not JSON', () => {
      img('https://example.com/a.png')
      install()
      down({ ...question(), v: 2 })
      down({ ...question(), v: '1' })
      down({ v: 1, type: IMAGE_OWNER_QUESTION_TYPE, alg: 'sha256' })
      down({ ...question(), nonce: NONCE.toUpperCase() })
      down({ ...question(), nonce: NONCE.slice(1) })
      down({ ...question(), nonce: 42 })
      down({ ...question(), alg: 'sha1' })
      down({ ...question(), alg: undefined })
      down({ type: IMAGE_OWNER_QUESTION_TYPE, nonce: NONCE, alg: 'sha256' })
      expect(() => bridge.onmessage!({ data: '{not json' })).not.toThrow()
      expect(() => bridge.onmessage!({ data: 'null' })).not.toThrow()
      expect(posted).toEqual([])
      down(question())
      expect(posted).toHaveLength(1)
    })

    it('ignores an ask with a mistyped field rather than answering it', async () => {
      img('https://example.com/a.png', { loaded: { width: 10, height: 10 } })
      install()
      down(ask(VECTOR, { bounds: 'big' }))
      down(ask(VECTOR, { bounds: { maxSide: 1000 } }))
      down(ask(VECTOR, { quality: 4 }))
      down(ask(VECTOR, { quality: '0.4' }))
      down(ask(VECTOR, { maxBytes: -1 }))
      down(ask(VECTOR, { hash: VECTOR.toUpperCase() }))
      down(ask(VECTOR, { hash: VECTOR.slice(2) }))
      down({ ...ask(VECTOR), v: 2 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(posted).toEqual([])
    })

    it('does no work at install: no hashing on a document of 500 images until a message arrives', () => {
      for (let i = 0; i < 500; i++) img(`https://example.com/i/${i}.png`)
      const hash = vi.fn((nonce: string, url: string) => imageOwnerHash(nonce, url))
      install({ hash })
      for (let i = 0; i < 500; i++) img(`https://example.com/j/${i}.png`)
      expect(hash).not.toHaveBeenCalled()
      down(question())
      expect(hash).toHaveBeenCalledTimes(1000)
    })

    it('listens with addEventListener where the bridge has one, and chains the single onmessage slot where it has not', () => {
      img('https://example.com/a.png')
      const listeners: Array<(event: { data: string }) => void> = []
      const modern: ImageOwnerBridge = {
        postMessage: (message) => void posted.push(message),
        addEventListener: (_type, listener) => void listeners.push(listener)
      }
      installImageOwner(modern, document, { token: TOKEN })
      expect(listeners).toHaveLength(1)
      listeners[0]!({ data: JSON.stringify(question()) })
      expect(answers()).toHaveLength(1)

      posted = []
      const heard: string[] = []
      bridge.onmessage = (event) => void heard.push(event.data)
      install()
      down(question())
      expect(heard).toHaveLength(1)
      expect(answers()).toHaveLength(1)
    })
  })
})

describe('the frame-owner thumbnailer (zen:image-thumbnail)', () => {
  it('thumbnails the matching image from its own <img>, no request made: Chrome’s downscale within the Lens bounds, a JPEG at the asked quality', async () => {
    img('https://example.com/other.png', { loaded: { width: 50, height: 50 } })
    const target = img('https://example.com/a.png', { loaded: { width: 1200, height: 900 } })
    img('https://example.com/third.png', { loaded: { width: 50, height: 50 } })
    install()
    down(question())
    expect(answers()[0]!.hashes[1]).toBe(VECTOR)
    down(ask(VECTOR))
    const result = await thumbnail()
    expect(result).toEqual({
      ok: true,
      thumbnail: {
        base64: Buffer.from(JPEG).toString('base64'),
        contentType: 'image/jpeg',
        width: 1000,
        height: 750,
        originalWidth: 1200,
        originalHeight: 900
      }
    })
    expect(thumbnails()[0]).toMatchObject({ v: 1, nonce: NONCE, token: TOKEN })
    expect(fetches).toEqual([])
    expect(painted).toHaveLength(1)
    expect(painted[0]!.size).toEqual({ width: 1000, height: 750 })
    expect(painted[0]!.drawn).toBe(target)
    expect(painted[0]!.encode).toEqual({ type: 'image/jpeg', quality: 0.4 })
  })

  it('applies the bounds the ask carries – the generic engine’s – and reports the natural size', async () => {
    img('https://example.com/a.png', { loaded: { width: 1200, height: 900 } })
    install()
    down(ask(VECTOR, { bounds: GENERIC_IMAGE_THUMBNAIL, quality: 0.9 }))
    const result = await thumbnail()
    expect(result).toMatchObject({
      ok: true,
      thumbnail: {
        ...imageThumbnailSize(1200, 900, GENERIC_IMAGE_THUMBNAIL),
        originalWidth: 1200,
        originalHeight: 900
      }
    })
    expect(painted[0]!.size).toEqual({ width: 600, height: 450 })
    expect(painted[0]!.encode).toEqual({ type: 'image/jpeg', quality: 0.9 })
  })

  it('answers gone when no image of its matches the hash at ask time – one removed since the question included', async () => {
    const target = img('https://example.com/a.png', { loaded: { width: 10, height: 10 } })
    install()
    down(question())
    expect(answers()[0]!.hashes).toEqual([VECTOR])
    target.remove()
    down(ask(VECTOR))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'gone' })
    posted = []
    down(ask(hashOf('https://example.com/never.png')))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'gone' })
    // Stateless: an ask needs no earlier question.
    posted = []
    img('https://example.com/a.png', { loaded: { width: 10, height: 10 } })
    down(ask(VECTOR, {}, NONCE_2))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'gone' })
    posted = []
    down(ask(hashOf('https://example.com/a.png', NONCE_2), {}, NONCE_2))
    expect(await thumbnail()).toMatchObject({ ok: true })
  })

  it('falls to its own fetch when the canvas taints, and answers opaque when that is refused too', async () => {
    img('https://cdn.example/a.png', { loaded: { width: 800, height: 600 } })
    encode = 'taint'
    install()
    down(ask(hashOf('https://cdn.example/a.png')))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'opaque' })
    // With the page's cookies first, then without: #555's read, in the owner's frame.
    expect(fetches.map((f) => [f.url, f.init.credentials])).toEqual([
      ['https://cdn.example/a.png', 'include'],
      ['https://cdn.example/a.png', 'omit']
    ])
  })

  it('thumbnails from its own fetch when the canvas taints but the fetch is allowed', async () => {
    const target = img('https://cdn.example/a.png', { loaded: { width: 800, height: 600 } })
    // The element taints (drawn cross-origin); the bitmap of bytes the frame read does not.
    encode = (drawn) => (drawn === target ? 'taint' : 'jpeg')
    fetched = () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } })
      )
    bitmap = { width: 800, height: 600 }
    install()
    down(ask(hashOf('https://cdn.example/a.png')))
    expect(await thumbnail()).toMatchObject({
      ok: true,
      thumbnail: { width: 800, height: 600, originalWidth: 800, originalHeight: 600 }
    })
    expect(fetches).toHaveLength(1)
    expect(painted).toHaveLength(2)
  })

  it('fetches for an image without a natural size (not loaded, or broken) and for an <input type=image>, and reports the read’s own refusals', async () => {
    img('https://example.com/a.png')
    fetched = () => Promise.reject(new TypeError('Failed to fetch'))
    install()
    down(ask(VECTOR))
    // Not tainted – never drawn – so a refused fetch is a fetch failure, not opacity.
    expect(await thumbnail()).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(painted).toEqual([])

    posted = []
    fetches.length = 0
    const input = document.createElement('input')
    input.setAttribute('type', 'image')
    input.setAttribute('src', 'https://example.com/go.png')
    document.body.appendChild(input)
    fetched = () =>
      Promise.resolve(
        new Response(new Uint8Array(10), {
          headers: { 'content-type': 'image/png', 'content-length': '10' }
        })
      )
    down(ask(hashOf(input.src)))
    expect(await thumbnail()).toMatchObject({ ok: true })
    expect(fetches.map((f) => f.url)).toEqual([input.src])
  })

  it('reads a data: image in place past no cap, and refuses one above the asked maxBytes as too large', async () => {
    const data = `data:image/png;base64,${Buffer.alloc(300).toString('base64')}`
    img(data)
    install()
    down(ask(hashOf(data), { maxBytes: 100 }))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'too-large' })
    posted = []
    down(ask(hashOf(data), { maxBytes: 400 }))
    expect(await thumbnail()).toMatchObject({ ok: true, thumbnail: { width: 1000, height: 500 } })
    expect(fetches).toEqual([])
  })

  it('answers no-canvas where the world gives no 2D context', async () => {
    img('https://example.com/a.png', { loaded: { width: 10, height: 10 } })
    canvasProto.getContext = () => null
    install()
    down(ask(VECTOR))
    expect(await thumbnail()).toEqual({ ok: false, reason: 'no-canvas' })
    expect(fetches).toEqual([])
  })

  it('answers decode-failed when the bytes decode to nothing, and never throws into the page', async () => {
    img('https://example.com/a.png')
    fetched = () =>
      Promise.resolve(new Response(new Uint8Array(3), { headers: { 'content-type': 'image/png' } }))
    bitmap = null
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        naturalWidth = 0
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.())
        }
      }
    )
    install()
    expect(() => down(ask(VECTOR))).not.toThrow()
    expect(await thumbnail()).toEqual({ ok: false, reason: 'decode-failed' })
  })

  it('uses the built-ins captured at install, not the page’s later patches', async () => {
    const target = img('https://example.com/a.png', { loaded: { width: 100, height: 50 } })
    install()
    const data = JSON.stringify(ask(VECTOR))
    // The page patches what the thumbnail relies on after document start.
    const stringify = JSON.stringify
    const parse = JSON.parse
    vi.spyOn(JSON, 'stringify').mockImplementation(() => '{"forged":true}')
    vi.spyOn(JSON, 'parse').mockImplementation(() => ({ forged: true }))
    canvasProto.toBlob = () => {
      throw new Error('patched')
    }
    canvasProto.getContext = () => null
    vi.stubGlobal('fetch', () => Promise.reject(new Error('patched')))
    bridge.onmessage!({ data })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    vi.mocked(JSON.stringify).mockRestore()
    vi.mocked(JSON.parse).mockRestore()
    const reply = JSON.parse(posted[0]!) as ImageThumbnailAnswer
    expect(reply.result).toMatchObject({ ok: true, thumbnail: { width: 100, height: 50 } })
    expect(painted[0]!.drawn).toBe(target)
    expect(JSON.stringify({ a: 1 })).toBe(stringify({ a: 1 }))
    expect(JSON.parse('{"a":1}')).toEqual(parse('{"a":1}'))
  })
})

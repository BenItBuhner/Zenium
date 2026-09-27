import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GENERIC_IMAGE_THUMBNAIL,
  IMAGE_THUMBNAIL_JPEG_QUALITY,
  IMAGE_UPLOAD_MAX_BYTES,
  LENS_IMAGE_THUMBNAIL,
  bakeImagePost,
  decodeBase64,
  encodeBase64,
  encodeImageThumbnail,
  expandImagePost,
  imageBase64Bound,
  imageFetchScript,
  imagePostBoundary,
  imageSearchSource,
  imageThumbnailSize,
  imageUploadFormDoc,
  isImageFetchFailure,
  parseImageFetchResult,
  parseImagePostParams,
  readImageThumbnail,
  urlencodeImagePost,
  type ImageFetchScriptOptions,
  type ImagePost,
  type ImageReadOptions,
  type ImageReadWorld,
  type ImageThumbnail
} from '../imageUpload'
import { DEFAULT_SEARCH_ENGINES } from '../search'

const google = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'google')!.imageSearch!.post!
const bing = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'bing')!.imageSearch!.post!

/** A 3-byte "JPEG": the bytes 0xFF 0xD8 0xFF, base64. */
const THUMB: ImageThumbnail = {
  base64: '/9j/',
  contentType: 'image/jpeg',
  width: 999,
  height: 562,
  originalWidth: 1920,
  originalHeight: 1080
}
const CONTEXT = {
  thumbnail: THUMB,
  imageUrl: 'https://pics.example/a b.png?v=2&s=l',
  source: 'Zenium 1.2.3 Linux'
}

describe('the image search upload (CT-32, Chrome’s image_url_post_params)', () => {
  describe('the thumbnail bounds (Chrome’s downscale, the engine’s numbers)', () => {
    it('are Chrome’s: Lens within 1000 px, any other engine within 600, the 300×300 trigger on both, a JPEG at 40, a 20 MiB cap on the encoded image', () => {
      // core_tab_helper.cc: kImageSearchThumbnailMinSize = 300 * 300, kImageSearchThumbnailMaxWidth
      // / Height = 600, kEncodingQualityJpeg = 40; lens_constants.h: kMaxPixelsForImageSearch = 1000.
      expect(LENS_IMAGE_THUMBNAIL).toEqual({ maxSide: 1000, minArea: 90_000 })
      expect(GENERIC_IMAGE_THUMBNAIL).toEqual({ maxSide: 600, minArea: 90_000 })
      expect(IMAGE_THUMBNAIL_JPEG_QUALITY).toBe(0.4)
      expect(IMAGE_UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024)
      // The engines carry them: Google's row is Chrome's Lens path, Bing's the generic one.
      expect(google.thumbnail).toEqual(LENS_IMAGE_THUMBNAIL)
      expect(bing.thumbnail).toEqual(GENERIC_IMAGE_THUMBNAIL)
    })

    // Chrome's DownscaleAndEncodeBitmap in single precision, truncated: 1920×1080 comes to
    // 999×562 on the Lens path (1920 × float(1000 / 1920) rounds to 999.99994f), Chrome's own
    // figure; an image at or under the trigger area keeps its size whatever its sides.
    it.each([
      [1200, 900, 1000, 750],
      [900, 1200, 750, 1000],
      [1920, 1080, 999, 562],
      [1080, 1920, 562, 999],
      [1600, 800, 1000, 500],
      [1000, 600, 1000, 600],
      [900, 500, 900, 500],
      [1001, 1000, 1000, 999],
      [3000, 3000, 1000, 1000],
      [1000, 3000, 333, 1000],
      [240, 160, 240, 160],
      [300, 300, 300, 300],
      [2000, 40, 2000, 40],
      [1600.7, 900.2, 1000, 562],
      [1, 1, 1, 1],
      [100000, 1, 1000, 1]
    ])('brings %d×%d to %d×%d for Lens', (w, h, tw, th) => {
      expect(imageThumbnailSize(w, h, LENS_IMAGE_THUMBNAIL)).toEqual({ width: tw, height: th })
    })

    it.each([
      [1200, 900, 600, 450],
      [1920, 1080, 600, 337],
      [1000, 600, 600, 360],
      [900, 500, 600, 333],
      [1000, 3000, 199, 600],
      [700, 100, 700, 100],
      [301, 300, 301, 300],
      [600, 600, 600, 600],
      [601, 601, 600, 600],
      [4000, 3, 4000, 3]
    ])('brings %d×%d to %d×%d for another engine', (w, h, tw, th) => {
      expect(imageThumbnailSize(w, h, GENERIC_IMAGE_THUMBNAIL)).toEqual({
        width: tw,
        height: th
      })
    })

    it('takes a stored engine’s own bounds', () => {
      expect(imageThumbnailSize(1000, 500, { maxSide: 100, minArea: 0 })).toEqual({
        width: 100,
        height: 50
      })
      expect(imageThumbnailSize(1000, 500, { maxSide: 100, minArea: 500_000 })).toEqual({
        width: 1000,
        height: 500
      })
    })
  })

  describe('the params (Chrome’s name={placeholder},… form)', () => {
    it('parses the pairs, trimming, skipping a malformed one', () => {
      expect(parseImagePostParams('a={x}, b = {y} ,,=v,c,d=')).toEqual([
        { name: 'a', value: '{x}' },
        { name: 'b', value: '{y}' },
        { name: 'd', value: '' }
      ])
    })

    it('expands Google Lens’s params to Chrome’s fields: the thumbnail a file part, the address, the source, the sizes', () => {
      expect(expandImagePost(google, CONTEXT)).toEqual({
        encoding: 'multipart',
        fields: [
          { name: 'encoded_image', file: { base64: '/9j/', contentType: 'image/jpeg' } },
          { name: 'image_url', value: 'https://pics.example/a b.png?v=2&s=l' },
          { name: 'sbisrc', value: 'Zenium 1.2.3 Linux' },
          { name: 'original_width', value: '1920' },
          { name: 'original_height', value: '1080' },
          { name: 'processed_image_dimensions', value: '999,562' }
        ]
      })
    })

    it('expands Bing’s params to the one urlencoded field, the thumbnail base64', () => {
      expect(expandImagePost(bing, CONTEXT)).toEqual({
        encoding: 'urlencoded',
        fields: [{ name: 'imageBin', value: '/9j/' }]
      })
    })

    it('drops the image_url field for a data:/blob: image (no address), and a placeholder it does not know', () => {
      const post = expandImagePost(
        { ...google, params: `${google.params},later={imageHash},fixed=1` },
        { ...CONTEXT, imageUrl: '' }
      )
      expect(post.fields.map((f) => f.name)).toEqual([
        'encoded_image',
        'sbisrc',
        'original_width',
        'original_height',
        'processed_image_dimensions',
        'fixed'
      ])
      expect(post.fields.at(-1)).toEqual({ name: 'fixed', value: '1' })
    })

    it('takes Chrome’s google: prefix on a placeholder (prepopulated_engines.json’s spelling), so no unexpanded {google:…} ever travels literally', () => {
      const chromes =
        'encoded_image={google:imageThumbnail},image_url={google:imageURL},sbisrc={google:imageSearchSource},original_width={google:imageOriginalWidth},original_height={google:imageOriginalHeight},processed_image_dimensions={google:processedImageDimensions},later={google:imageHash}'
      const post = expandImagePost({ ...google, params: chromes }, CONTEXT)
      expect(post).toEqual(expandImagePost(google, CONTEXT))
      expect(JSON.stringify(post)).not.toContain('google:')
      expect(
        expandImagePost({ ...bing, params: 'imageBin={google:imageThumbnailBase64}' }, CONTEXT)
      ).toEqual(expandImagePost(bing, CONTEXT))
    })

    it('types the file part as the answer says (a JPEG from the script; no filename, as Chrome’s part has none)', () => {
      const post = expandImagePost(google, {
        ...CONTEXT,
        thumbnail: { ...THUMB, contentType: 'image/png' }
      })
      expect(post.fields[0]).toEqual({
        name: 'encoded_image',
        file: { base64: '/9j/', contentType: 'image/png' }
      })
      expect(JSON.stringify(expandImagePost(google, CONTEXT))).not.toContain('filename')
    })

    it('carries the thumbnail base64 for {imageThumbnail} in an urlencoded body (no file part in one)', () => {
      expect(
        expandImagePost(
          { ...google, encoding: 'urlencoded', params: 'img={imageThumbnail}' },
          CONTEXT
        )
      ).toEqual({ encoding: 'urlencoded', fields: [{ name: 'img', value: '/9j/' }] })
    })

    it('names Zenium as Chrome names itself for {imageSearchSource}: product, version, OS', () => {
      expect(imageSearchSource('0.4.89', 'linux')).toBe('Zenium 0.4.89 Linux')
      expect(imageSearchSource('0.4.89', 'win32')).toBe('Zenium 0.4.89 Windows')
      expect(imageSearchSource('0.4.89', 'darwin')).toBe('Zenium 0.4.89 Mac OS X')
      expect(imageSearchSource('0.4.89', 'android')).toBe('Zenium 0.4.89 Android')
    })
  })

  describe('the body', () => {
    const post = expandImagePost(google, CONTEXT)

    it('bakes the multipart body as Chrome’s UploadRawData one, byte for byte with a fixed boundary (net::AddMultipartValueForUpload: the file part named and typed, no filename)', () => {
      const { contentType, bytes } = bakeImagePost(post, 'ZenBoundary')
      expect(contentType).toBe('multipart/form-data; boundary=ZenBoundary')
      const text = new TextDecoder('latin1').decode(bytes)
      expect(text).toBe(
        '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="encoded_image"\r\n' +
          'Content-Type: image/jpeg\r\n' +
          '\r\n' +
          '\u00ff\u00d8\u00ff\r\n' +
          '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="image_url"\r\n' +
          '\r\n' +
          'https://pics.example/a b.png?v=2&s=l\r\n' +
          '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="sbisrc"\r\n' +
          '\r\n' +
          'Zenium 1.2.3 Linux\r\n' +
          '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="original_width"\r\n' +
          '\r\n' +
          '1920\r\n' +
          '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="original_height"\r\n' +
          '\r\n' +
          '1080\r\n' +
          '--ZenBoundary\r\n' +
          'Content-Disposition: form-data; name="processed_image_dimensions"\r\n' +
          '\r\n' +
          '999,562\r\n' +
          '--ZenBoundary--\r\n'
      )
      expect(text).not.toContain('filename')
      // The file part carries the decoded bytes, not the base64.
      expect(
        Array.from(bytes.subarray(text.indexOf('\u00ff'), text.indexOf('\u00ff') + 3))
      ).toEqual([0xff, 0xd8, 0xff])
    })

    it('escapes a quote or a line break in a part’s name as the multipart/form-data encoding does', () => {
      const odd: ImagePost = {
        encoding: 'multipart',
        fields: [{ name: 'a"b\r\nc', value: 'v' }]
      }
      const text = new TextDecoder().decode(bakeImagePost(odd, 'B').bytes)
      expect(text).toContain('name="a%22b%0D%0Ac"')
    })

    it('makes a boundary of Chrome’s shape: a fixed prefix and sixteen random alphanumerics', () => {
      const boundary = imagePostBoundary(() => 0)
      expect(boundary).toBe('----ZeniumFormBoundaryAAAAAAAAAAAAAAAA')
      expect(imagePostBoundary()).toMatch(/^----ZeniumFormBoundary[A-Za-z0-9]{16}$/)
      expect(imagePostBoundary()).not.toBe(imagePostBoundary())
    })

    it('bakes the urlencoded body as application/x-www-form-urlencoded (WHATWG: spaces as +, the rest percent-encoded)', () => {
      const { contentType, bytes } = bakeImagePost(expandImagePost(bing, CONTEXT))
      expect(contentType).toBe('application/x-www-form-urlencoded')
      expect(new TextDecoder().decode(bytes)).toBe('imageBin=%2F9j%2F')
      expect(
        urlencodeImagePost({
          encoding: 'urlencoded',
          fields: [
            { name: 'q', value: 'a b&c=d' },
            { name: 'f', file: { base64: 'AAA=', contentType: 'image/jpeg' } }
          ]
        })
      ).toBe('q=a+b%26c%3Dd&f=AAA%3D')
    })

    it('decodes base64 without a host’s Buffer, padding or none, ignoring whitespace', () => {
      expect(Array.from(decodeBase64('/9j/'))).toEqual([0xff, 0xd8, 0xff])
      expect(Array.from(decodeBase64('AQID'))).toEqual([1, 2, 3])
      expect(Array.from(decodeBase64('AQI='))).toEqual([1, 2])
      expect(Array.from(decodeBase64('AQ'))).toEqual([1])
      expect(Array.from(decodeBase64('AQ\nID '))).toEqual([1, 2, 3])
      expect(Array.from(decodeBase64(''))).toEqual([])
      const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 0xff)
      expect(Array.from(decodeBase64(Buffer.from(bytes).toString('base64')))).toEqual(
        Array.from(bytes)
      )
    })
  })

  describe('the form document (the phone’s multipart)', () => {
    it('is a self-submitting multipart form: the action escaped, the fields embedded, the file set through a DataTransfer under a name of the form path’s own (a File needs one; the phone’s limit)', () => {
      const doc = imageUploadFormDoc(
        'https://lens.google.com/v3/upload?a=1&b="2"',
        expandImagePost(google, CONTEXT)
      )
      expect(doc.startsWith('<!doctype html>')).toBe(true)
      expect(doc).toContain(
        '<form id="f" method="post" action="https://lens.google.com/v3/upload?a=1&amp;b=&quot;2&quot;" enctype="multipart/form-data"></form>'
      )
      expect(doc).toContain(
        '"name":"encoded_image","file":{"base64":"/9j/","contentType":"image/jpeg"}'
      )
      expect(doc).toContain('"name":"image_url","value":"https://pics.example/a b.png?v=2&s=l"')
      expect(doc).toContain('new DataTransfer()')
      expect(doc).toContain(
        'new File([bytes(d.file.base64)],fname(d.file.contentType),{type:d.file.contentType})'
      )
      expect(doc).toContain('return "image."+(s==="jpeg"?"jpg":s)')
      expect(doc).toContain('input.files=dt.files')
      expect(doc).toContain('f.submit()')
      expect(doc).toContain('<meta charset="utf-8">')
    })

    it('takes an urlencoded engine too, and keeps a value from closing the script', () => {
      const doc = imageUploadFormDoc('https://b.example/up', {
        encoding: 'urlencoded',
        fields: [{ name: 'q', value: '</script><b>' }]
      })
      expect(doc).toContain('enctype="application/x-www-form-urlencoded"')
      expect(doc).not.toContain('</script><b>')
      expect(doc).toContain('\\u003c/script>\\u003cb>')
    })
  })

  describe('the page script’s answer', () => {
    it('reads a whole thumbnail back, the content type lower-cased, an odd one read as JPEG', () => {
      expect(parseImageFetchResult({ ok: true, thumbnail: THUMB })).toEqual({
        ok: true,
        thumbnail: THUMB
      })
      expect(
        parseImageFetchResult({ ok: true, thumbnail: { ...THUMB, contentType: 'Image/PNG' } })
      ).toMatchObject({ ok: true, thumbnail: { contentType: 'image/png' } })
      expect(
        parseImageFetchResult({ ok: true, thumbnail: { ...THUMB, contentType: 'text/html' } })
      ).toMatchObject({ ok: true, thumbnail: { contentType: 'image/jpeg' } })
    })

    it('reads the failures, an unknown reason as a decode failure, and anything else as nothing', () => {
      expect(parseImageFetchResult({ ok: false, reason: 'too-large' })).toEqual({
        ok: false,
        reason: 'too-large'
      })
      expect(parseImageFetchResult({ ok: false, reason: 'fetch-failed' })).toEqual({
        ok: false,
        reason: 'fetch-failed'
      })
      expect(parseImageFetchResult({ ok: false, reason: 'later' })).toEqual({
        ok: false,
        reason: 'decode-failed'
      })
      for (const raw of [
        null,
        true,
        'ok',
        {},
        { ok: true },
        { ok: true, thumbnail: { ...THUMB, base64: 'not base64!' } },
        { ok: true, thumbnail: { ...THUMB, width: 0 } },
        { ok: true, thumbnail: { ...THUMB, originalHeight: 1.5 } },
        { ok: true, thumbnail: { ...THUMB, height: '450' } }
      ])
        expect(parseImageFetchResult(raw), JSON.stringify(raw)).toBeNull()
    })

    it('reads no thumbnail longer than the cap’s bytes can make (a page handing back a body of any size to POST)', () => {
      // Four characters per three bytes, padded: 20 MiB of thumbnail is this much base64, at most.
      expect(imageBase64Bound(IMAGE_UPLOAD_MAX_BYTES)).toBe(27962028)
      expect(imageBase64Bound(3)).toBe(4)
      expect(imageBase64Bound(4)).toBe(8)
      expect(imageBase64Bound(0)).toBe(0)
      const within = { ok: true, thumbnail: { ...THUMB, base64: 'AAAAAAAA' } }
      expect(parseImageFetchResult(within, 6)).toMatchObject({ ok: true })
      expect(parseImageFetchResult(within, 3)).toBeNull()
      expect(
        parseImageFetchResult({
          ok: true,
          thumbnail: { ...THUMB, base64: 'A'.repeat(imageBase64Bound(IMAGE_UPLOAD_MAX_BYTES) + 4) }
        })
      ).toBeNull()
    })
  })

  describe('the page script', () => {
    it('is one expression settling to the answer: the source, a fetch with the page’s credentials, the engine’s bounds, the cap, a canvas JPEG', () => {
      const script = imageFetchScript('https://pics.example/a.png', LENS_IMAGE_THUMBNAIL)
      expect(script.startsWith('(async () => {')).toBe(true)
      expect(script.trimEnd().endsWith('})()')).toBe(true)
      expect(script).toContain(`const src = "https://pics.example/a.png";`)
      expect(script).toContain("fetch(src, { credentials, cache: 'force-cache' })")
      // The page's credentials first; a host that allows any origin refuses a credentialed
      // read, so the same fetch once more without them.
      expect(script).toContain("got = await read('include');")
      expect(script).toContain(
        "try { got = await read('omit'); } catch (e2) { return fail('fetch-failed'); }"
      )
      expect(script).toContain(
        'const maxSide = 1000, minArea = 90000, quality = 0.4, maxBytes = 20971520;'
      )
      expect(script).toContain("fail('too-large')")
      expect(script).toContain("fail('fetch-failed')")
      expect(script).toContain("fail('decode-failed')")
      expect(script).toContain('createImageBitmap(blob)')
      // The downscale on an `OffscreenCanvas` – no DOM node – where the engine has one; a
      // document canvas only where it does not.
      expect(script).toContain("if (typeof OffscreenCanvas === 'function') {")
      expect(script).toContain('new OffscreenCanvas(width, height)')
      expect(script).toContain("canvas.convertToBlob({ type: 'image/jpeg', quality })")
      expect(script.indexOf('new OffscreenCanvas(')).toBeLessThan(
        script.indexOf("document.createElement('canvas')")
      )
      expect(script).toContain("canvas.toBlob(resolve, 'image/jpeg', quality)")
      // Chrome's downscale rule, in Chrome's single precision: an image above the minimum
      // area is scaled to the longest side, width first, then height; the result truncated.
      expect(script).toContain('if (width * height > minArea) {')
      expect(script).toContain(
        'if (width > maxSide) { const s = Math.fround(maxSide / width); width = Math.fround(width * s); height = Math.fround(height * s); }'
      )
      expect(script).toContain(
        'if (height > maxSide) { const s = Math.fround(maxSide / height); width = Math.fround(width * s); height = Math.fround(height * s); }'
      )
      expect(script).toContain(
        'width = Math.max(1, Math.trunc(width)); height = Math.max(1, Math.trunc(height));'
      )
      // Every image re-encoded – none travels as fetched – laid on white, as a JPEG has no alpha.
      expect(script).not.toContain("type === 'image/jpeg' || type === 'image/png'")
      expect(script).toContain("context.fillStyle = '#fff';")
      expect(script).toContain('context.fillRect(0, 0, width, height);')
      expect(script).toContain('context.drawImage(bitmap, 0, 0, width, height);')
      // The answer's shape is the one the core reads back.
      expect(script).toContain(
        "return { ok: true, thumbnail: { base64: toBase64(await jpeg.arrayBuffer()), contentType: 'image/jpeg', width, height, originalWidth, originalHeight } };"
      )
    })

    it('takes the generic engine’s bounds, or a stored engine’s own, and embeds a data: source whole', () => {
      expect(imageFetchScript('https://a.example/i.png', GENERIC_IMAGE_THUMBNAIL)).toContain(
        'const maxSide = 600, minArea = 90000, quality = 0.4, maxBytes = 20971520;'
      )
      const src = 'data:image/png;base64,iVBORw0KGgo="\'</script>'
      const script = imageFetchScript(src, { maxSide: 100, minArea: 0, maxBytes: 1024 })
      expect(script).toContain(`const src = ${JSON.stringify(src)};`)
      expect(script).toContain('const maxSide = 100, minArea = 0, quality = 0.4, maxBytes = 1024;')
    })

    it('evaluates as an expression (no statement list to wrap)', () => {
      // The Android host wraps a statement list into a function; an expression goes as it is.
      expect(
        () =>
          new Function(
            `return ${imageFetchScript('https://a.example/i.png', LENS_IMAGE_THUMBNAIL)}`
          )
      ).not.toThrow()
    })

    it('decodes a data: source in place and streams a fetched body to the cap (the text of it)', () => {
      const script = imageFetchScript('data:image/png;base64,iVBORw0KGgo=', LENS_IMAGE_THUMBNAIL)
      // No fetch of a data: address: the page's CSP has no say, its report-uri hears nothing.
      expect(script).toContain('if (/^data:/i.test(src)) got = readData();')
      expect(script).toContain('binary = atob(clean);')
      expect(script).toContain("if (clean.length * 0.75 > maxBytes) return fail('too-large');")
      expect(script).toContain('new Blob([bytes], { type })')
      // The fetched body counted as it streams, dropped at the cap – a response without a
      // Content-Length is judged before it is whole.
      expect(script).toContain('const reader = response.body.getReader();')
      expect(script).toContain(
        "if (size > maxBytes) { reader.cancel().catch(() => {}); return fail('too-large'); }"
      )
    })
  })

  /**
   * The script run in this process with the engine's decode and canvas stood in for – what the
   * read stage produced is what `createImageBitmap` receives, so the bytes and the type a
   * source yields are read off there.
   */
  describe('the page script, run', () => {
    afterEach(() => vi.unstubAllGlobals())

    interface World {
      /** The natural size the decode reports. */
      bitmap?: { width: number; height: number }
      /** The page's `fetch`; without one every fetch rejects and is counted. */
      fetch?: (input: string, init: RequestInit) => Promise<Response>
    }
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff])
    /** What the stood-in canvas saw: its size, the fill laid first, the draw's rectangle. */
    interface Painted {
      canvas: { width: number; height: number }
      fill: { style: string; rect: number[] } | null
      draw: number[] | null
      encode: { type: string; quality: number } | null
    }
    const run = async (
      src: string,
      options: ImageFetchScriptOptions = LENS_IMAGE_THUMBNAIL,
      world: World = {}
    ): Promise<{ result: unknown; blobs: Blob[]; fetches: string[]; painted: Painted[] }> => {
      const blobs: Blob[] = []
      const fetches: string[] = []
      const painted: Painted[] = []
      const size = world.bitmap ?? { width: 1600, height: 800 }
      vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        blobs.push(blob)
        return { ...size, close: () => undefined }
      })
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          private readonly seen: Painted
          constructor(
            public width: number,
            public height: number
          ) {
            this.seen = { canvas: { width, height }, fill: null, draw: null, encode: null }
            painted.push(this.seen)
          }
          getContext(): {
            fillStyle: string
            fillRect(...rect: number[]): void
            drawImage(_bitmap: unknown, ...rect: number[]): void
          } {
            const seen = this.seen
            return {
              fillStyle: '',
              fillRect(...rect) {
                seen.fill = { style: this.fillStyle, rect }
              },
              drawImage(_bitmap, ...rect) {
                seen.draw = rect
              }
            }
          }
          convertToBlob(encode: { type: string; quality: number }): Promise<Blob> {
            this.seen.encode = encode
            return Promise.resolve(new Blob([JPEG], { type: 'image/jpeg' }))
          }
        }
      )
      vi.stubGlobal(
        'fetch',
        world.fetch ??
          ((input: string) => {
            fetches.push(String(input))
            return Promise.reject(new Error('no network in the test'))
          })
      )
      const result = await (new Function(
        `return ${imageFetchScript(src, options)}`
      )() as Promise<unknown>)
      return { result, blobs, fetches, painted }
    }
    const bytesOf = async (blob: Blob): Promise<number[]> => [
      ...new Uint8Array(await blob.arrayBuffer())
    ]

    it('reads a base64 data: source without a fetch: the bytes and the type as written, the thumbnail from them within the Lens bounds', async () => {
      const { result, blobs, fetches, painted } = await run('data:image/png;base64,AQIDBA==')
      expect(fetches).toEqual([])
      expect(blobs).toHaveLength(1)
      expect(blobs[0]!.type).toBe('image/png')
      await expect(bytesOf(blobs[0]!)).resolves.toEqual([1, 2, 3, 4])
      expect(result).toEqual({
        ok: true,
        thumbnail: {
          base64: '/9j/',
          contentType: 'image/jpeg',
          width: 1000,
          height: 500,
          originalWidth: 1600,
          originalHeight: 800
        }
      })
      // The canvas the thumbnail's size, white laid under the whole of it, the image drawn
      // over it whole, encoded as a JPEG at Chrome's quality.
      expect(painted).toEqual([
        {
          canvas: { width: 1000, height: 500 },
          fill: { style: '#fff', rect: [0, 0, 1000, 500] },
          draw: [0, 0, 1000, 500],
          encode: { type: 'image/jpeg', quality: 0.4 }
        }
      ])
    })

    it('brings the same image within the generic engine’s bounds instead when those are the engine’s', async () => {
      const { result, painted } = await run(
        'data:image/png;base64,AQIDBA==',
        GENERIC_IMAGE_THUMBNAIL
      )
      expect(result).toMatchObject({
        ok: true,
        thumbnail: { width: 600, height: 300, originalWidth: 1600, originalHeight: 800 }
      })
      expect(painted[0]!.canvas).toEqual({ width: 600, height: 300 })
    })

    it('reads a percent-encoded data: source too (an inline SVG), and a base64 one with whitespace', async () => {
      const svg = await run('data:image/svg+xml,%3Csvg%3E%20%3C/svg%3E')
      expect(svg.blobs[0]!.type).toBe('image/svg+xml')
      await expect(svg.blobs[0]!.text()).resolves.toBe('<svg> </svg>')
      const spaced = await run('data:image/gif;base64,AQID\nBA==')
      await expect(bytesOf(spaced.blobs[0]!)).resolves.toEqual([1, 2, 3, 4])
      expect(spaced.fetches).toEqual([])
    })

    it('refuses a data: source above the cap before decoding it, and one that is no data at all', async () => {
      const big = await run(`data:image/png;base64,${'A'.repeat(16)}`, {
        ...LENS_IMAGE_THUMBNAIL,
        maxBytes: 10
      })
      expect(big.result).toEqual({ ok: false, reason: 'too-large' })
      expect(big.blobs).toEqual([])
      const none = await run('data:image/png;base64')
      expect(none.result).toEqual({ ok: false, reason: 'fetch-failed' })
      const rotten = await run('data:image/png;base64,@@@@')
      expect(rotten.result).toEqual({ ok: false, reason: 'fetch-failed' })
    })

    it('re-encodes a small JPEG too, at its own size: nothing travels as read (Chrome encodes every thumbnail from the decoded bitmap)', async () => {
      const { result, painted } = await run('data:image/jpeg;base64,AQID', LENS_IMAGE_THUMBNAIL, {
        bitmap: { width: 100, height: 50 }
      })
      expect(result).toEqual({
        ok: true,
        thumbnail: {
          // The stood-in canvas's bytes, not the source's `AQID`.
          base64: '/9j/',
          contentType: 'image/jpeg',
          width: 100,
          height: 50,
          originalWidth: 100,
          originalHeight: 50
        }
      })
      expect(painted[0]!.encode).toEqual({ type: 'image/jpeg', quality: 0.4 })
    })

    /** A response streaming `chunks` of `chunk` bytes each, no Content-Length; `cancelled` says if the read was given up. */
    const streaming = (
      chunks: number,
      chunk: number,
      type: string
    ): { response: Response; state: { pulled: number; cancelled: boolean } } => {
      const state = { pulled: 0, cancelled: false }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (state.pulled >= chunks) {
            controller.close()
            return
          }
          state.pulled++
          controller.enqueue(new Uint8Array(chunk).fill(state.pulled))
        },
        cancel() {
          state.cancelled = true
        }
      })
      return { response: new Response(body, { headers: { 'content-type': type } }), state }
    }

    it('fetches an http(s) source with the page’s credentials and reads a body without a Content-Length as it streams', async () => {
      const inits: RequestInit[] = []
      const { response } = streaming(3, 10, 'Image/PNG; charset=binary')
      const { result, blobs } = await run('https://pics.example/a.png', LENS_IMAGE_THUMBNAIL, {
        fetch: (_input, init) => {
          inits.push(init)
          return Promise.resolve(response)
        }
      })
      expect(inits.map((i) => i.credentials)).toEqual(['include'])
      expect(blobs[0]!.size).toBe(30)
      expect(blobs[0]!.type).toBe('image/png')
      expect(result).toMatchObject({ ok: true })
    })

    it('gives a body without a Content-Length up at the cap, the stream cancelled, before it is whole', async () => {
      const { response, state } = streaming(1000, 1000, 'image/png')
      const { result, blobs } = await run(
        'https://pics.example/big.png',
        { ...LENS_IMAGE_THUMBNAIL, maxBytes: 2500 },
        {
          fetch: () => Promise.resolve(response)
        }
      )
      expect(result).toEqual({ ok: false, reason: 'too-large' })
      expect(blobs).toEqual([])
      expect(state.cancelled).toBe(true)
      // Three chunks crossed the cap; the other 997 were never asked for.
      expect(state.pulled).toBeLessThanOrEqual(4)
    })

    it('refuses a Content-Length above the cap unread, and tries once more without credentials when the first read is refused', async () => {
      const inits: RequestInit[] = []
      const { result } = await run(
        'https://cdn.example/a.png',
        { ...LENS_IMAGE_THUMBNAIL, maxBytes: 100 },
        {
          fetch: (_input, init) => {
            inits.push(init)
            if (init.credentials === 'include')
              return Promise.reject(new TypeError('Failed to fetch'))
            return Promise.resolve(
              new Response(new Uint8Array(10), {
                headers: { 'content-type': 'image/png', 'content-length': '5000' }
              })
            )
          }
        }
      )
      expect(inits.map((i) => i.credentials)).toEqual(['include', 'omit'])
      expect(result).toEqual({ ok: false, reason: 'too-large' })
    })
  })

  describe('the read as a function (the frame-owner’s path)', () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff])
    interface Painted {
      canvas: { width: number; height: number }
      fill: { style: string; rect: number[] } | null
      draw: number[] | null
      encode: { type: string; quality: number } | null
    }
    interface Stood {
      bitmap?: { width: number; height: number } | null
      fetch?: (input: string, init: RequestInit) => Promise<Response>
      /** What `toJpeg` does: the stood-in JPEG (default), a `SecurityError` (`'taint'`), or nothing (`'decline'`). */
      encode?: 'jpeg' | 'taint' | 'decline'
      /** No 2D surface at all. */
      noCanvas?: boolean
      /** A detached image that loads at the size, or errors. */
      image?: { width: number; height: number } | 'error'
    }
    interface Seen {
      blobs: Blob[]
      fetches: string[]
      inits: RequestInit[]
      painted: Painted[]
      images: number
      revoked: string[]
    }
    /** A world of stand-ins that record what the read asked of them, the page-script test's twins. */
    const worldOf = (stood: Stood = {}): { world: ImageReadWorld; seen: Seen } => {
      const seen: Seen = { blobs: [], fetches: [], inits: [], painted: [], images: 0, revoked: [] }
      const size = stood.bitmap === undefined ? { width: 1600, height: 800 } : stood.bitmap
      const world: ImageReadWorld = {
        fetch: (input, init) => {
          seen.fetches.push(input)
          seen.inits.push(init)
          return stood.fetch
            ? stood.fetch(input, init)
            : Promise.reject(new Error('no network in the test'))
        },
        responseBlob: (response) => response.blob(),
        responseBody: (response) => response.body,
        arrayBuffer: (blob) => blob.arrayBuffer(),
        newBlob: (parts, type) => new Blob(parts, { type }),
        createImageBitmap: size
          ? async (blob) => {
              seen.blobs.push(blob)
              return { ...size, close: () => undefined } as unknown as ImageBitmap
            }
          : null,
        newImage: () => {
          seen.images++
          const image = { naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement & {
            onload: (() => void) | null
            onerror: (() => void) | null
          }
          Object.defineProperty(image, 'src', {
            set() {
              queueMicrotask(() => {
                if (stood.image && stood.image !== 'error') {
                  Object.assign(image, {
                    naturalWidth: stood.image.width,
                    naturalHeight: stood.image.height
                  })
                  image.onload?.()
                } else image.onerror?.()
              })
            }
          })
          return image
        },
        createObjectURL: () => 'blob:test/1',
        revokeObjectURL: (url) => void seen.revoked.push(url),
        canvas: (width, height) => {
          if (stood.noCanvas) return null
          const painted: Painted = {
            canvas: { width, height },
            fill: null,
            draw: null,
            encode: null
          }
          seen.painted.push(painted)
          const context = {
            fillStyle: '' as string | CanvasGradient | CanvasPattern,
            fillRect(...rect: number[]) {
              painted.fill = { style: String(context.fillStyle), rect }
            },
            drawImage(_source: unknown, ...rect: number[]) {
              painted.draw = rect
            }
          }
          return {
            context,
            toJpeg: (quality) => {
              painted.encode = { type: 'image/jpeg', quality }
              if (stood.encode === 'taint') {
                const error = new Error('tainted')
                error.name = 'SecurityError'
                throw error
              }
              if (stood.encode === 'decline') return Promise.resolve(null)
              return Promise.resolve(new Blob([JPEG], { type: 'image/jpeg' }))
            }
          }
        },
        // Node's `atob` refuses what the browser's refuses (`@@@@`), where `Buffer` would not.
        atob: (text) => atob(text)
      }
      return { world, seen }
    }
    const OPTIONS: ImageReadOptions = {
      ...LENS_IMAGE_THUMBNAIL,
      quality: IMAGE_THUMBNAIL_JPEG_QUALITY,
      maxBytes: IMAGE_UPLOAD_MAX_BYTES
    }
    const bytesOf = async (blob: Blob): Promise<number[]> => [
      ...new Uint8Array(await blob.arrayBuffer())
    ]

    it('reads a base64 data: source in place and paints the string’s thumbnail: the same size, the same fill, the same JPEG at the same quality', async () => {
      const { world, seen } = worldOf()
      const result = await readImageThumbnail('data:image/png;base64,AQIDBA==', OPTIONS, world)
      expect(seen.fetches).toEqual([])
      expect(seen.blobs).toHaveLength(1)
      expect(seen.blobs[0]!.type).toBe('image/png')
      await expect(bytesOf(seen.blobs[0]!)).resolves.toEqual([1, 2, 3, 4])
      expect(result).toEqual({
        ok: true,
        thumbnail: {
          base64: '/9j/',
          contentType: 'image/jpeg',
          width: 1000,
          height: 500,
          originalWidth: 1600,
          originalHeight: 800
        }
      })
      expect(seen.painted).toEqual([
        {
          canvas: { width: 1000, height: 500 },
          fill: { style: '#fff', rect: [0, 0, 1000, 500] },
          draw: [0, 0, 1000, 500],
          encode: { type: 'image/jpeg', quality: 0.4 }
        }
      ])
      const generic = await readImageThumbnail(
        'data:image/png;base64,AQIDBA==',
        { ...OPTIONS, ...GENERIC_IMAGE_THUMBNAIL },
        worldOf().world
      )
      expect(generic).toMatchObject({ ok: true, thumbnail: { width: 600, height: 300 } })
    })

    it('reads a percent-encoded data: source, refuses one above the cap before decoding it and one that is no data at all', async () => {
      const svg = worldOf()
      await readImageThumbnail('data:image/svg+xml,%3Csvg%3E%20%3C/svg%3E', OPTIONS, svg.world)
      expect(svg.seen.blobs[0]!.type).toBe('image/svg+xml')
      await expect(svg.seen.blobs[0]!.text()).resolves.toBe('<svg> </svg>')
      const big = worldOf()
      expect(
        await readImageThumbnail(
          `data:image/png;base64,${'A'.repeat(16)}`,
          { ...OPTIONS, maxBytes: 10 },
          big.world
        )
      ).toEqual({ ok: false, reason: 'too-large' })
      expect(big.seen.blobs).toEqual([])
      expect(await readImageThumbnail('data:image/png;base64', OPTIONS, worldOf().world)).toEqual({
        ok: false,
        reason: 'fetch-failed'
      })
      expect(
        await readImageThumbnail('data:image/png;base64,@@@@', OPTIONS, worldOf().world)
      ).toEqual({ ok: false, reason: 'fetch-failed' })
    })

    it('fetches an http(s) source with the page’s credentials from the world’s fetch, streams the body against the cap and tries once more without credentials when refused', async () => {
      const streamed = worldOf({
        fetch: () =>
          Promise.resolve(
            new Response(new Uint8Array(30).fill(7), {
              headers: { 'content-type': 'Image/PNG; charset=binary' }
            })
          )
      })
      const result = await readImageThumbnail('https://pics.example/a.png', OPTIONS, streamed.world)
      expect(streamed.seen.inits.map((i) => i.credentials)).toEqual(['include'])
      expect(streamed.seen.inits[0]!.cache).toBe('force-cache')
      expect(streamed.seen.blobs[0]!.size).toBe(30)
      expect(streamed.seen.blobs[0]!.type).toBe('image/png')
      expect(result).toMatchObject({ ok: true })

      let cancelled = false
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1000).fill(1))
        },
        cancel() {
          cancelled = true
        }
      })
      const capped = worldOf({
        fetch: () =>
          Promise.resolve(new Response(endless, { headers: { 'content-type': 'image/png' } }))
      })
      expect(
        await readImageThumbnail(
          'https://pics.example/big.png',
          { ...OPTIONS, maxBytes: 2500 },
          capped.world
        )
      ).toEqual({ ok: false, reason: 'too-large' })
      expect(capped.seen.blobs).toEqual([])
      expect(cancelled).toBe(true)

      const retried = worldOf({
        fetch: (_input, init) =>
          init.credentials === 'include'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(
                new Response(new Uint8Array(10), {
                  headers: { 'content-type': 'image/png', 'content-length': '5000' }
                })
              )
      })
      expect(
        await readImageThumbnail(
          'https://cdn.example/a.png',
          { ...OPTIONS, maxBytes: 100 },
          retried.world
        )
      ).toEqual({ ok: false, reason: 'too-large' })
      expect(retried.seen.inits.map((i) => i.credentials)).toEqual(['include', 'omit'])

      const refused = worldOf({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) })
      expect(await readImageThumbnail('https://cdn.example/a.png', OPTIONS, refused.world)).toEqual(
        { ok: false, reason: 'fetch-failed' }
      )
      expect(refused.seen.inits.map((i) => i.credentials)).toEqual(['include', 'omit'])
      const notFound = worldOf({ fetch: () => Promise.resolve(new Response('', { status: 404 })) })
      expect(
        await readImageThumbnail('https://cdn.example/a.png', OPTIONS, notFound.world)
      ).toEqual({ ok: false, reason: 'fetch-failed' })
    })

    it('decodes with a detached image where the bitmap path declines, releases its object URL, and reports a decode failure when neither decodes', async () => {
      const element = worldOf({ bitmap: null, image: { width: 120, height: 60 } })
      const result = await readImageThumbnail(
        'data:image/svg+xml,%3Csvg/%3E',
        OPTIONS,
        element.world
      )
      expect(element.seen.images).toBe(1)
      expect(element.seen.revoked).toEqual(['blob:test/1'])
      expect(result).toMatchObject({
        ok: true,
        thumbnail: { width: 120, height: 60, originalWidth: 120, originalHeight: 60 }
      })
      const neither = worldOf({ bitmap: null, image: 'error' })
      expect(
        await readImageThumbnail('data:image/svg+xml,%3Csvg/%3E', OPTIONS, neither.world)
      ).toEqual({ ok: false, reason: 'decode-failed' })
      expect(neither.seen.revoked).toEqual(['blob:test/1'])
      // A bitmap without a size is no image.
      const empty = worldOf({ bitmap: { width: 0, height: 0 } })
      expect(await readImageThumbnail('data:image/png;base64,AQID', OPTIONS, empty.world)).toEqual({
        ok: false,
        reason: 'decode-failed'
      })
    })

    it('reports no-canvas where the world gives no 2D surface, and a declined encode as a decode failure', async () => {
      expect(
        await readImageThumbnail(
          'data:image/png;base64,AQID',
          OPTIONS,
          worldOf({ noCanvas: true }).world
        )
      ).toEqual({ ok: false, reason: 'no-canvas' })
      expect(
        await readImageThumbnail(
          'data:image/png;base64,AQID',
          OPTIONS,
          worldOf({ encode: 'decline' }).world
        )
      ).toEqual({ ok: false, reason: 'decode-failed' })
    })

    it('encodes an element the frame holds without a request, reports a tainted surface as such, and a surface of bytes the frame read never as tainted', async () => {
      const image = { source: {} as CanvasImageSource, width: 1200, height: 900 }
      const drawn = worldOf()
      expect(await encodeImageThumbnail(image, OPTIONS, drawn.world)).toEqual({
        ok: true,
        thumbnail: {
          base64: '/9j/',
          contentType: 'image/jpeg',
          width: 1000,
          height: 750,
          originalWidth: 1200,
          originalHeight: 900
        }
      })
      expect(drawn.seen.fetches).toEqual([])
      expect(drawn.seen.painted[0]!.encode).toEqual({ type: 'image/jpeg', quality: 0.4 })
      expect(
        await encodeImageThumbnail(image, OPTIONS, worldOf({ encode: 'taint' }).world)
      ).toEqual({ ok: false, reason: 'tainted' })
      expect(await encodeImageThumbnail({ ...image, width: 0 }, OPTIONS, worldOf().world)).toEqual({
        ok: false,
        reason: 'decode-failed'
      })
      expect(await encodeImageThumbnail(image, OPTIONS, worldOf({ noCanvas: true }).world)).toEqual(
        { ok: false, reason: 'no-canvas' }
      )
      // The whole read's surface holds bytes the frame itself read: `tainted` is not a word it says.
      expect(
        await readImageThumbnail(
          'data:image/png;base64,AQID',
          OPTIONS,
          worldOf({ encode: 'taint' }).world
        )
      ).toEqual({ ok: false, reason: 'decode-failed' })
    })

    it('encodes base64 as the platform does, and back through decodeBase64', () => {
      for (const bytes of [
        [],
        [1],
        [1, 2],
        [1, 2, 3],
        [0xff, 0xd8, 0xff],
        [0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70],
        Array.from({ length: 1000 }, (_, i) => (i * 31) & 0xff)
      ]) {
        const encoded = encodeBase64(new Uint8Array(bytes))
        expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
        expect(Array.from(decodeBase64(encoded))).toEqual(bytes)
      }
    })

    it('reads the protocol’s refusals back – the owner frame’s and the host’s – and still an unknown one as a decode failure', () => {
      for (const reason of [
        'opaque',
        'gone',
        'no-canvas',
        'no-owner',
        'timeout',
        'unsupported'
      ] as const) {
        expect(parseImageFetchResult({ ok: false, reason })).toEqual({ ok: false, reason })
        expect(isImageFetchFailure(reason)).toBe(true)
      }
      expect(parseImageFetchResult({ ok: false, reason: 'tainted' })).toEqual({
        ok: false,
        reason: 'decode-failed'
      })
      expect(isImageFetchFailure('tainted')).toBe(false)
      expect(isImageFetchFailure(undefined)).toBe(false)
    })
  })
})

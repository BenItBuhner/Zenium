import type { ImageSearchPost, ImageThumbnailBounds, Platform } from './types'

/**
 * The image-search row's upload (CT-32, Chrome's `image_url_post_params`): the pure half of
 * "Search Image with <engine>" when the engine takes the image's bytes. The page script reads
 * the image where the page can (`imageFetchScript`: a fetch with the page's cookies and
 * referrer, or a `data:`/`blob:` image in place) and downscales it to Chrome's thumbnail on a
 * canvas; the engine's params expand to the body's fields (`expandImagePost`); a host bakes
 * the body – a multipart with a boundary or an urlencoded string – or, where it can only
 * navigate by form, a self-submitting form document (`imageUploadFormDoc`).
 */

/**
 * Chrome's thumbnail bounds for the two paths its image row takes, an engine definition's to
 * carry (`ImageSearchPost.thumbnail`), read off Chromium main
 * (`chrome/browser/ui/tab_contents/core_tab_helper.cc` at 814c31728f36, 2026-09-14):
 * `CoreTabHelper::SearchWithLens` → `SearchByImageImpl(…, kImageSearchThumbnailMinSize,
 * lens::kMaxPixelsForImageSearch, lens::kMaxPixelsForImageSearch, …)` behind Google's row
 * (`render_view_context_menu.cc` `ExecSearchLensForImage`) and `CoreTabHelper::SearchByImage`
 * → `SearchByImageImpl(…, kImageSearchThumbnailMinSize, kImageSearchThumbnailMaxWidth,
 * kImageSearchThumbnailMaxHeight, …)` behind any other engine's (`ExecSearchWebForImage`);
 * `constexpr int kImageSearchThumbnailMinSize = 300 * 300;`, `kImageSearchThumbnailMaxWidth =
 * 600;`, `kImageSearchThumbnailMaxHeight = 600;` there, `inline constexpr int
 * kMaxPixelsForImageSearch = 1000;` in `components/lens/lens_constants.h` (whose
 * `kMaxAreaForImageSearch` = 1 000 000 belongs to the region-search overload's
 * `NeedsDownscale`; the fit within 1000 × 1000 keeps a downscaled Lens thumbnail at or under
 * it all the same). A stored engine without bounds of its own gets `GENERIC_IMAGE_THUMBNAIL`.
 */
export const LENS_IMAGE_THUMBNAIL: ImageThumbnailBounds = { maxSide: 1000, minArea: 300 * 300 }
export const GENERIC_IMAGE_THUMBNAIL: ImageThumbnailBounds = { maxSide: 600, minArea: 300 * 300 }
/**
 * The thumbnail's JPEG quality: Chrome's `kEncodingQualityJpeg` = 40 (`core_tab_helper.cc`),
 * as a canvas takes it. Chrome re-encodes every thumbnail from the decoded bitmap – never the
 * original bytes – a JPEG at 40 when the bitmap is opaque, a WebP at `kEncodingQualityWebp` =
 * 45 when it has transparency; Zenium encodes a JPEG always (the root's ruling), transparency
 * laid on white.
 */
export const IMAGE_THUMBNAIL_JPEG_QUALITY = 0.4
/**
 * An image above this many encoded bytes is refused before it is decoded ("This image is too
 * large to search"). Zenium's own bound: Chrome reads the bitmap its renderer already decoded
 * and has no cap of its own at this seat.
 */
export const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** The longest base64 that `maxBytes` of thumbnail can make (four characters per three bytes, padded). */
export function imageBase64Bound(maxBytes: number): number {
  return Math.ceil(Math.max(0, maxBytes) / 3) * 4
}

/**
 * `{imageSearchSource}`: Chrome sends its product, version, "(Official)" on an official build,
 * OS and channel (`TemplateURLRef::GetGoogleImageSearchSource`, e.g. "Chrome 152.0.7300.0
 * (Official) Linux"); Zenium names itself the same way, its OS spelled as Chrome's
 * `version_info::GetOSType` spells it.
 */
export function imageSearchSource(version: string, os: Platform): string {
  const name = { linux: 'Linux', win32: 'Windows', darwin: 'Mac OS X', android: 'Android' }[os]
  return `Zenium ${version} ${name}`
}

/** The page script's answer: the thumbnail, or why there is none. */
export type ImageFetchResult =
  { ok: true; thumbnail: ImageThumbnail } | { ok: false; reason: ImageFetchFailure }

export type ImageFetchFailure = 'too-large' | 'fetch-failed' | 'decode-failed'

export interface ImageThumbnail {
  /** The thumbnail's encoded bytes, base64 (how they cross from the page and over the bridge). */
  base64: string
  /** `image/jpeg`: the thumbnail is re-encoded whatever the image was (the field rides so a host can check it). */
  contentType: string
  /** The thumbnail's size. */
  width: number
  height: number
  /** The image's natural size (Chrome's `original_width` / `original_height`). */
  originalWidth: number
  originalHeight: number
}

/**
 * Chrome's downscale (`CoreTabHelper::DownscaleAndEncodeBitmap`): an image whose area is at
 * most `minArea` pixels keeps its size; a larger one has its width, then its height, brought
 * to `maxSide` where it exceeds it, the other side scaled with it – single-precision
 * arithmetic truncated to whole pixels, as Chrome's `gfx::SizeF::Scale` and `static_cast<int>`
 * do, so the sizes match Chrome's to the pixel (1200 × 900 → 1000 × 750 for Lens, 600 × 450
 * for another engine) – and never below one pixel. The page script carries the same lines.
 */
export function imageThumbnailSize(
  width: number,
  height: number,
  bounds: ImageThumbnailBounds
): { width: number; height: number } {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  if (w * h <= bounds.minArea) return { width: w, height: h }
  let sw = w
  let sh = h
  if (sw > bounds.maxSide) {
    const scale = Math.fround(bounds.maxSide / sw)
    sw = Math.fround(sw * scale)
    sh = Math.fround(sh * scale)
  }
  if (sh > bounds.maxSide) {
    const scale = Math.fround(bounds.maxSide / sh)
    sw = Math.fround(sw * scale)
    sh = Math.fround(sh * scale)
  }
  return { width: Math.max(1, Math.trunc(sw)), height: Math.max(1, Math.trunc(sh)) }
}

/**
 * The page script's answer read back from the host (JSON on the phone's bridge): the shape
 * checked, anything else null – a thumbnail longer than the cap's bytes can make
 * (`imageBase64Bound`) included, since no thumbnail of the script's is; the answer is not
 * trusted for its size any more than for its shape.
 */
export function parseImageFetchResult(
  raw: unknown,
  maxBytes = IMAGE_UPLOAD_MAX_BYTES
): ImageFetchResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.ok === false) {
    return r.reason === 'too-large' || r.reason === 'fetch-failed' || r.reason === 'decode-failed'
      ? { ok: false, reason: r.reason }
      : { ok: false, reason: 'decode-failed' }
  }
  if (r.ok !== true) return null
  const t = r.thumbnail
  if (!t || typeof t !== 'object') return null
  const th = t as Record<string, unknown>
  if (typeof th.base64 !== 'string' || th.base64.length > imageBase64Bound(maxBytes)) return null
  if (!/^[A-Za-z0-9+/]+=*$/.test(th.base64)) return null
  const dims = [th.width, th.height, th.originalWidth, th.originalHeight]
  if (!dims.every((d) => typeof d === 'number' && Number.isInteger(d) && d > 0)) return null
  const contentType =
    typeof th.contentType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(th.contentType)
      ? th.contentType.toLowerCase()
      : 'image/jpeg'
  return {
    ok: true,
    thumbnail: {
      base64: th.base64,
      contentType,
      width: th.width as number,
      height: th.height as number,
      originalWidth: th.originalWidth as number,
      originalHeight: th.originalHeight as number
    }
  }
}

// ---------------------------------------------------------------------------
// The engine's params → the body's fields
// ---------------------------------------------------------------------------

/**
 * One field of the upload's body: a text value, or the thumbnail as a file part – a name and a
 * type, no filename, as Chrome's part (`net::AddMultipartValueForUpload`: `Content-Disposition:
 * form-data; name="…"` and a `Content-Type`).
 */
export type ImagePostField =
  { name: string; value: string } | { name: string; file: { base64: string; contentType: string } }

/** The upload a host navigates a new tab with: the body's fields and their encoding. */
export interface ImagePost {
  encoding: ImageSearchPost['encoding']
  fields: ImagePostField[]
}

export interface ImagePostContext {
  thumbnail: ImageThumbnail
  /** The image's http(s) address (`{imageURL}`); `''` for a `data:`/`blob:` image, whose field is left out. */
  imageUrl: string
  /** `{imageSearchSource}`, `imageSearchSource(version, os)`. */
  source: string
}

/** Chrome's `image_url_post_params` form parsed: `name=value` pairs separated by commas, a malformed pair skipped. */
export function parseImagePostParams(params: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  for (const pair of params.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (!name) continue
    out.push({ name, value: pair.slice(eq + 1).trim() })
  }
  return out
}

/**
 * The engine's params expanded for one image: a `{placeholder}` value resolves as the doc on
 * `ImageSearchPost` says, a value without braces travels as written, a placeholder that
 * resolves to nothing (`{imageURL}` for a `data:` image) or one this build does not know
 * drops its field. A placeholder may carry Chrome's `google:` prefix as
 * `prepopulated_engines.json` spells it (`{google:imageThumbnail}`), so Chrome's own
 * `image_url_post_params` string pasted into a stored engine works as written and no
 * unexpanded `{google:…}` ever travels literally. `{imageThumbnail}` is the file part of a
 * multipart body; an urlencoded body, all text, carries the same bytes base64.
 */
export function expandImagePost(post: ImageSearchPost, ctx: ImagePostContext): ImagePost {
  const { thumbnail } = ctx
  const fields: ImagePostField[] = []
  for (const { name, value } of parseImagePostParams(post.params)) {
    const m = /^\{(?:google:)?([A-Za-z0-9]+)\}$/.exec(value)
    if (!m) {
      fields.push({ name, value })
      continue
    }
    switch (m[1]) {
      case 'imageThumbnail':
        if (post.encoding === 'multipart') {
          fields.push({
            name,
            file: { base64: thumbnail.base64, contentType: thumbnail.contentType }
          })
        } else fields.push({ name, value: thumbnail.base64 })
        break
      case 'imageThumbnailBase64':
        fields.push({ name, value: thumbnail.base64 })
        break
      case 'imageURL':
        if (ctx.imageUrl) fields.push({ name, value: ctx.imageUrl })
        break
      case 'imageOriginalWidth':
        fields.push({ name, value: String(thumbnail.originalWidth) })
        break
      case 'imageOriginalHeight':
        fields.push({ name, value: String(thumbnail.originalHeight) })
        break
      case 'processedImageDimensions':
        fields.push({ name, value: `${thumbnail.width},${thumbnail.height}` })
        break
      case 'imageSearchSource':
        if (ctx.source) fields.push({ name, value: ctx.source })
        break
      default:
        break
    }
  }
  return { encoding: post.encoding, fields }
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** A baked body: what a host hands its `loadURL` with post data, or `postUrl`. */
export interface ImagePostBody {
  contentType: string
  bytes: Uint8Array
}

/**
 * A multipart boundary the way Chrome makes one (`net::GenerateMimeMultipartBoundary`: a fixed
 * prefix and random alphanumerics); the caller may fix the random source for a pinned body.
 */
export function imagePostBoundary(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let tail = ''
  for (let i = 0; i < 16; i++)
    tail += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  return `----ZeniumFormBoundary${tail}`
}

/**
 * The body's bytes and content type: `multipart/form-data` framed as Chrome's `UploadRawData`
 * body is (`net::AddMultipartValueForUpload`: `--boundary`, a `Content-Disposition` naming the
 * part – no filename, on the file part either – a `Content-Type` on the file part, the value,
 * CRLFs, `--boundary--` at the end), or `application/x-www-form-urlencoded`
 * (`urlencodeImagePost`).
 */
export function bakeImagePost(post: ImagePost, boundary = imagePostBoundary()): ImagePostBody {
  if (post.encoding === 'urlencoded') {
    return {
      contentType: 'application/x-www-form-urlencoded',
      bytes: new TextEncoder().encode(urlencodeImagePost(post))
    }
  }
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const field of post.fields) {
    if ('file' in field) {
      parts.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${multipartName(field.name)}"\r\nContent-Type: ${field.file.contentType}\r\n\r\n`
        )
      )
      parts.push(decodeBase64(field.file.base64))
      parts.push(encoder.encode('\r\n'))
    } else {
      parts.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${multipartName(field.name)}"\r\n\r\n${field.value}\r\n`
        )
      )
    }
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes: concat(parts) }
}

/** The urlencoded body, WHATWG's `application/x-www-form-urlencoded` (a file part's value is its base64). */
export function urlencodeImagePost(post: ImagePost): string {
  const params = new URLSearchParams()
  for (const field of post.fields)
    params.append(field.name, 'file' in field ? field.file.base64 : field.value)
  return params.toString()
}

/** A part's name in its `Content-Disposition` (the multipart/form-data encoding's escapes). */
function multipartName(name: string): string {
  return name.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 to bytes, without a host's `Buffer` or `atob` (the core runs on both hosts' runtimes). */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

// ---------------------------------------------------------------------------
// The form document (a host that can only navigate by form: the phone's WebView for multipart)
// ---------------------------------------------------------------------------

/**
 * A document that POSTs the upload as it loads: a `<form>` with the engine's action and
 * encoding, its text fields hidden inputs and the thumbnail a `File` set on a file input
 * through a `DataTransfer` (Chromium lets a script set `input.files` that way), submitted from
 * an inline script – before the document's load event, so the submission replaces the form
 * document's own history entry rather than stacking on it. The phone's `WebView.postUrl` takes
 * an urlencoded body alone; this is its multipart. A `File` has a name (`image.jpg` for the
 * JPEG), and the WebView's form encoder writes a file input's part with `filename=` – where
 * Chrome's part and the desktop's baked body carry none. A file input cannot be scripted any
 * other way and the WebView has no raw multipart navigation, so the filename is the phone's
 * limit, not a choice.
 */
export function imageUploadFormDoc(action: string, post: ImagePost): string {
  const enctype =
    post.encoding === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded'
  const payload = JSON.stringify(post.fields)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Searching image…</title></head><body>' +
    `<form id="f" method="post" action="${escapeAttribute(action)}" enctype="${enctype}"></form>` +
    '<script>(function(){' +
    `var fields=${payload};` +
    'var f=document.getElementById("f");' +
    'function bytes(b64){var s=atob(b64),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a}' +
    'function fname(t){var s=String(t||"").split("/")[1]||"bin";return "image."+(s==="jpeg"?"jpg":s)}' +
    'for(var i=0;i<fields.length;i++){var d=fields[i],input=document.createElement("input");input.name=d.name;' +
    'if(d.file){input.type="file";var dt=new DataTransfer();dt.items.add(new File([bytes(d.file.base64)],fname(d.file.contentType),{type:d.file.contentType}));input.files=dt.files}' +
    'else{input.type="hidden";input.value=d.value}' +
    'f.appendChild(input)}' +
    'f.submit()' +
    '})()</script></body></html>'
  )
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// The page script
// ---------------------------------------------------------------------------

/**
 * An image's encoded bytes as a host's renderer holds them (`TabView.readImageResource`: the
 * response the page's own request got), base64 with the type the renderer recorded (`''` when
 * it recorded none). The core hands them to the page script as a `data:` address, so one
 * downscale – the page's canvas – serves every path.
 */
export interface ImageResource {
  base64: string
  mimeType: string
}

/** The `data:` address the page script reads a renderer-held image from (decoded in the script, no request made). */
export function imageResourceDataUrl(resource: ImageResource): string {
  const type = /^image\/[a-z0-9.+-]+$/i.test(resource.mimeType)
    ? resource.mimeType.toLowerCase()
    : 'application/octet-stream'
  return `data:${type};base64,${resource.base64}`
}

/** What the page script is told: the engine's bounds (`ImageSearchPost.thumbnail`) and the cap. */
export interface ImageFetchScriptOptions extends ImageThumbnailBounds {
  /** The encoded image's byte cap (`IMAGE_UPLOAD_MAX_BYTES` unless a test asks for a smaller one). */
  maxBytes?: number
}

/**
 * The script the host runs in the clicked frame of the page: an expression that settles to an
 * `ImageFetchResult`. It runs in the frame's document – the image's cookies and referrer are
 * the page's own – but, wherever the host has one, in a world of the browser's
 * (`TabView.executeJavaScriptInPrivateWorld`, `shared/privateWorld.ts`), so every built-in it
 * touches is the engine's and the page's patches to `fetch`, `Response`, `Blob`,
 * `createImageBitmap`, the canvas or `btoa` neither see it nor pick its bytes; it reaches for
 * no page global, makes no DOM node it can avoid (`OffscreenCanvas` for the downscale; a
 * detached `Image` only where the bitmap path declines a format) and leaves nothing behind.
 * An http(s) or `blob:` image is fetched with `credentials: 'include'` (the page's referrer
 * policy applies), and once more with `credentials: 'omit'` when that is refused (a
 * cross-origin host that allows any origin, `Access-Control-Allow-Origin: *`, refuses a
 * credentialed read); the body is counted as it streams and dropped at the cap, so a response
 * without a `Content-Length` is judged before it is whole. A `data:` image – the renderer's
 * copy the desktop hands back, or the page's own – is decoded in the script (base64 →
 * `Blob`), no request made: a page CSP whose `connect-src` leaves `data:` out would refuse a
 * fetch of it, and a read the page never sees reports no violation. The decoded image is
 * brought within the engine's bounds by Chrome's rule (`imageThumbnailSize`) and drawn – on
 * white, at that size, whatever its own size and format – into a JPEG at Chrome's quality
 * (`IMAGE_THUMBNAIL_JPEG_QUALITY`): every thumbnail is re-encoded from the decoded pixels, as
 * Chrome's is, never the original bytes. A cross-origin image whose host sends no CORS header
 * cannot be read from the page (the same rule that taints a canvas) and reports
 * `fetch-failed` – and the refused fetch evicts the renderer's copy of the image, which is why
 * the desktop reads that copy first (`TabView.readImageResource`, handed back to this script
 * as a `data:` address) and asks the page to fetch only after; the row falls back to the
 * address form when neither read it.
 */
export function imageFetchScript(src: string, options: ImageFetchScriptOptions): string {
  const { maxSide, minArea } = options
  const quality = IMAGE_THUMBNAIL_JPEG_QUALITY
  const maxBytes = options.maxBytes ?? IMAGE_UPLOAD_MAX_BYTES
  return `(async () => {
  const src = ${JSON.stringify(src)};
  const maxSide = ${maxSide}, minArea = ${minArea}, quality = ${quality}, maxBytes = ${maxBytes};
  const fail = (reason) => ({ ok: false, reason });
  const mimeOf = (header) => (header || '').split(';')[0].trim().toLowerCase();
  const readData = () => {
    const comma = src.indexOf(',');
    if (comma < 0) return fail('fetch-failed');
    const meta = src.slice(5, comma), payload = src.slice(comma + 1);
    const base64 = /;\\s*base64$/i.test(meta);
    const type = mimeOf(base64 ? meta.replace(/;\\s*base64$/i, '') : meta);
    let bytes;
    if (base64) {
      const clean = payload.replace(/\\s+/g, '');
      if (clean.length * 0.75 > maxBytes) return fail('too-large');
      let binary;
      try { binary = atob(clean); } catch (e) { return fail('fetch-failed'); }
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      if (payload.length > maxBytes) return fail('too-large');
      const out = [];
      for (let i = 0; i < payload.length; i++) {
        const escaped = payload.charCodeAt(i) === 37 ? payload.slice(i + 1, i + 3) : '';
        if (/^[0-9A-Fa-f]{2}$/.test(escaped)) { out.push(parseInt(escaped, 16)); i += 2; }
        else out.push(payload.charCodeAt(i) & 0xff);
      }
      bytes = new Uint8Array(out);
    }
    return { ok: true, blob: new Blob([bytes], { type }) };
  };
  const read = async (credentials) => {
    const response = await fetch(src, { credentials, cache: 'force-cache' });
    if (!response.ok && response.status !== 0) return fail('fetch-failed');
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) return fail('too-large');
    const type = mimeOf(response.headers.get('content-type'));
    if (!response.body) {
      const whole = await response.blob();
      return whole.size > maxBytes ? fail('too-large') : { ok: true, blob: whole };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { reader.cancel().catch(() => {}); return fail('too-large'); }
      chunks.push(value);
    }
    return { ok: true, blob: new Blob(chunks, { type }) };
  };
  let got;
  if (/^data:/i.test(src)) got = readData();
  else {
    try {
      got = await read('include');
    } catch (e) {
      try { got = await read('omit'); } catch (e2) { return fail('fetch-failed'); }
    }
  }
  if (!got.ok) return got;
  const blob = got.blob;
  if (blob.size > maxBytes) return fail('too-large');
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return btoa(binary);
  };
  const decode = async () => {
    try { return await createImageBitmap(blob); } catch (e) { /* an SVG, or a format the bitmap path declines: the element decodes it */ }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      return image.naturalWidth ? image : null;
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const bitmap = await decode();
  if (!bitmap) return fail('decode-failed');
  const originalWidth = bitmap.naturalWidth || bitmap.width, originalHeight = bitmap.naturalHeight || bitmap.height;
  if (!originalWidth || !originalHeight) return fail('decode-failed');
  // Chrome's downscale (CoreTabHelper::DownscaleAndEncodeBitmap): above the trigger area, each
  // side over the bound brought to it, in single precision, truncated to whole pixels.
  let width = originalWidth, height = originalHeight;
  if (width * height > minArea) {
    if (width > maxSide) { const s = Math.fround(maxSide / width); width = Math.fround(width * s); height = Math.fround(height * s); }
    if (height > maxSide) { const s = Math.fround(maxSide / height); width = Math.fround(width * s); height = Math.fround(height * s); }
  }
  width = Math.max(1, Math.trunc(width)); height = Math.max(1, Math.trunc(height));
  const draw = (context) => {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
  };
  const paint = async () => {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      draw(context);
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    draw(context);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  };
  let jpeg = null;
  try { jpeg = await paint(); } catch (e) { jpeg = null; }
  if (bitmap.close) bitmap.close();
  if (!jpeg) return fail('decode-failed');
  return { ok: true, thumbnail: { base64: toBase64(await jpeg.arrayBuffer()), contentType: 'image/jpeg', width, height, originalWidth, originalHeight } };
})()`
}

/**
 * `zen://` internal pages. Zen has no new-tab page (the URL bar replaces it), so `zen://blank` is
 * an empty page that picks up the theme; `zen://error` renders navigation failures,
 * `zen://reader` shows Reader View articles and `zen://image` an image another app shared in.
 *
 * Pure HTML generation shared by every host: Electron serves these through a privileged protocol,
 * Android loads them straight into the tab's WebView. Reader articles and shared images live in
 * the core; hosts pass lookups so this module stays free of state.
 */
import type { OverlayKind } from './types'

export const ZEN_SCHEME = 'zen'

/** An image shared into the browser (`zen://image?id=…`); the bytes live in the core. */
export const IMAGE_URL_PREFIX = 'zen://image'

const ERROR_MESSAGES: Record<number, string> = {
  [-105]: "We can't connect to the server at this address. Check the address for typing errors.",
  [-106]: 'You appear to be offline. Check your network connection and try again.',
  [-102]: 'The connection was refused. The server may be down or not accepting connections.',
  [-118]: 'The connection timed out. The server took too long to respond.',
  [-7]: 'The connection timed out. The server took too long to respond.',
  [-100]: 'The connection was closed unexpectedly.',
  [-101]: 'The connection was reset.',
  [-109]: 'The address could not be reached.',
  [-200]: 'The certificate for this site is not trusted.',
  [-201]: 'The certificate for this site has expired or is not yet valid.',
  [-202]: 'The certificate authority for this site is invalid.',
  [-501]: 'The site tried to use an insecure response.',
  [-300]: 'The address is invalid.',
  [-310]: 'Too many redirects. The page is stuck in a redirect loop.',
  [-324]: 'The server sent an empty response.',
  [-6]: 'The file could not be found.',
  [-20]: 'This request was blocked.',
  [-21]: 'Network access was blocked.',
  [-3]: ''
}

/** Chromium `net::` error codes eligible for the https→http typed-input fallback. */
export const HTTP_FALLBACK_CODES = new Set([
  -102, -105, -107, -113, -118, -7, -100, -101, -109, -200, -201, -202, -203, -204, -205, -206,
  -207, -208, -210, -211, -212, -213, -324, -501
])

export function describeNetError(code: number, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { background: transparent; color: light-dark(#1e1e24, #f0f0f5); display: grid; place-items: center; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  p { margin: 0 0 20px; line-height: 1.5; opacity: .8; }
  code { font-family: ui-monospace, monospace; font-size: 13px; opacity: .7; word-break: break-all; }
  button { font: inherit; padding: 8px 18px; border-radius: 999px; border: 1px solid light-dark(#0002, #fff3); background: light-dark(#fff8, #ffffff14); color: inherit; cursor: pointer; }
  button:hover { background: light-dark(#fff, #ffffff22); }
`

export function blankPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>New Tab</title><style>${BASE_STYLE}</style></head><body></body></html>`
}

/** `net::ERR_BLOCKED_BY_CLIENT`: the request engine stopped the navigation itself. */
export const BLOCKED_BY_CLIENT_CODE = -20

export function errorPageHtml(url: URL): string {
  const code = Number(url.searchParams.get('code') ?? 0)
  const description = url.searchParams.get('description') ?? ''
  const target = url.searchParams.get('url') ?? ''
  if (code === BLOCKED_BY_CLIENT_CODE) return blockedPageHtml(target)
  const message = describeNetError(code, 'The page could not be loaded.')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Problem loading page</title><style>${BASE_STYLE}</style></head>
<body><div class="card">
  <h1>Hmm. We're having trouble finding that site.</h1>
  <p>${escapeHtml(message)}</p>
  <p><code>${escapeHtml(target)}</code><br><code>${escapeHtml(description)} (${code})</code></p>
  <button onclick="location.replace(${JSON.stringify(target)})">Try Again</button>
</div></body></html>`
}

/**
 * Shown when a filter list blocks a whole page (malware hosts, ad-only domains). The site can be
 * excepted in Settings → Privacy and security; the page itself only offers the way back.
 */
export function blockedPageHtml(target: string): string {
  let host = target
  try {
    host = new URL(target).hostname || target
  } catch {
    // Keep the raw target for URLs that do not parse.
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page blocked</title><style>${BASE_STYLE}</style></head>
<body><div class="card">
  <h1>Zenium blocked this page</h1>
  <p><strong>${escapeHtml(host)}</strong> is on one of your filter lists as an ad, tracking or malware host, so Zenium did not load it.</p>
  <p>To visit it anyway, add the site to the exceptions in Settings &rsaquo; Privacy and security.</p>
  <p><code>${escapeHtml(target)}</code></p>
  <button onclick="history.back()">Go back</button>
</div></body></html>`
}

export function readerMissingPageHtml(original: string | null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reader View</title><style>${BASE_STYLE}</style></head>
<body><div class="card">
  <h1>This article is no longer available</h1>
  <p>Reader View keeps articles only while the browser is open.</p>
  ${original ? `<button onclick="location.replace(${JSON.stringify(original)})">Open the original page</button>` : ''}
</div></body></html>`
}

/** The `zen://image` page: the shared picture, fitted to the viewport like Chrome's image view. */
export function imagePageHtml(dataUrl: string): string {
  if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*$/i.test(dataUrl))
    return imageMissingPageHtml()
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared image</title><style>${BASE_STYLE}
  body { display: grid; place-items: center; }
  img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
</style></head>
<body><img src="${dataUrl}" alt="Shared image"></body></html>`
}

export function imageMissingPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared image</title><style>${BASE_STYLE}</style></head>
<body><div class="card">
  <h1>This image is no longer available</h1>
  <p>Images shared into Zenium are kept only while the browser is open.</p>
</div></body></html>`
}

/** Resolves `zen://reader?id=…` to the article's HTML (null once the article is gone). */
export type ReaderPageLookup = (id: string) => string | null

/** Resolves `zen://image?id=…` to the image's `data:` URL (null once the image is gone). */
export type ImagePageLookup = (id: string) => string | null

/**
 * A `zen://` URL as a `URL` whose `hostname` is the page name. Parsed as `http://` because
 * engines before Chromium 130 (the Android WebView that hosts the core on older devices and on
 * the emulator) give a non-special scheme no host at all, which turned every error page into the
 * blank page.
 */
export function parseZenUrl(rawUrl: string): URL | null {
  if (!/^zen:\/\//i.test(rawUrl)) return null
  try {
    return new URL(`http://${rawUrl.slice('zen://'.length)}`)
  } catch {
    return null
  }
}

/** `zen://` addresses that are chrome surfaces rather than documents, and the overlay each opens. */
const OVERLAY_PAGES: Record<string, OverlayKind> = {
  history: 'history',
  settings: 'settings'
}

/**
 * The chrome overlay a `zen://` address stands for (`zen://history` → the history page), or
 * `null` for a real page. Navigating to one of these opens the overlay instead of loading.
 */
export function overlayForUrl(rawUrl: string): OverlayKind | null {
  const url = parseZenUrl(rawUrl)
  return url ? (OVERLAY_PAGES[url.hostname] ?? null) : null
}

/** HTML for any `zen://` URL (unknown hosts fall back to the blank page). */
export function zenPageHtml(
  rawUrl: string,
  reader?: ReaderPageLookup,
  image?: ImagePageLookup
): string {
  const url = parseZenUrl(rawUrl)
  if (!url) return blankPageHtml()
  switch (url.hostname) {
    case 'error':
      return errorPageHtml(url)
    case 'reader':
      return (
        reader?.(url.searchParams.get('id') ?? '') ??
        readerMissingPageHtml(url.searchParams.get('url'))
      )
    case 'image': {
      const data = image?.(url.searchParams.get('id') ?? '')
      return data ? imagePageHtml(data) : imageMissingPageHtml()
    }
    default:
      return blankPageHtml()
  }
}

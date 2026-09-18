/**
 * `zen://` internal pages. Zen has no new-tab page (the URL bar replaces it), so `zen://blank` is
 * an empty page that picks up the theme; `zen://error` renders navigation failures,
 * `zen://reader` shows Reader View articles and `zen://image` an image another app shared in.
 *
 * Pure HTML generation shared by every host: Electron serves these through a privileged protocol,
 * Android loads them straight into the tab's WebView. Reader articles and shared images live in
 * the core; hosts pass lookups so this module stays free of state.
 */
// The chrome's stylesheet as text (a Vite `?raw` import: nothing of the renderer runs here). The
// error page is a document inside the tab and cannot link the stylesheet, so it cuts the design
// language v2 token block, the v2 button and its own rules out of this text instead of carrying
// a copy of any value; `v2Tokens.test.ts` lists the page among the v2 surfaces.
import chromeStylesheet from '../renderer/src/assets/main.css?raw'
import { PHONE_MAX_WIDTH } from './formFactor'
import type { OverlayKind } from './types'
import { SAFE_BROWSING_THREAT_LABELS, type SafeBrowsingThreat } from './privacy'
import { INTERSTITIAL_MESSAGE_KEY, type InterstitialAction } from './interstitial'

export const ZEN_SCHEME = 'zen'

/** An image shared into the browser (`zen://image?id=…`); the bytes live in the core. */
export const IMAGE_URL_PREFIX = 'zen://image'

/** Headline of the error page for one family of failures (Chrome's own wording). */
const UNREACHABLE = "This site can't be reached"
const NOT_WORKING = "This page isn't working"
const NOT_PRIVATE = 'Your connection is not private'
const NO_INTERNET = 'No internet'

/** Chrome's phrasing for a failed load, with the site named where Chrome names it. */
interface NetErrorCopy {
  /** The Chromium `net::` name, shown as the small line at the end (`ERR_…`). */
  name: string
  title: string
  /** The one-line reason; `site` is the host of the failed URL or '' when it has none. */
  reason: (site: string) => string
}

const named =
  (withSite: (site: string) => string, without: string) =>
  (site: string): string =>
    site ? withSite(site) : without

/** Keep the names equal to `BY_NAME` in the Android host's `NetErrors.kt`, which reports failures by them. */
const NET_ERRORS: Record<number, NetErrorCopy> = {
  [-2]: {
    name: 'ERR_FAILED',
    title: UNREACHABLE,
    reason: named((s) => `${s} could not be loaded.`, 'The page could not be loaded.')
  },
  [-6]: {
    name: 'ERR_FILE_NOT_FOUND',
    title: 'File not found',
    reason: () => 'It may have been moved, edited or deleted.'
  },
  [-7]: {
    name: 'ERR_TIMED_OUT',
    title: UNREACHABLE,
    reason: named((s) => `${s} took too long to respond.`, 'The server took too long to respond.')
  },
  [-20]: {
    name: 'ERR_BLOCKED_BY_CLIENT',
    title: 'This page has been blocked',
    reason: () => 'Zenium blocked this request.'
  },
  [-21]: {
    name: 'ERR_NETWORK_ACCESS_DENIED',
    title: UNREACHABLE,
    reason: () => 'Network access was denied.'
  },
  [-100]: {
    name: 'ERR_CONNECTION_CLOSED',
    title: UNREACHABLE,
    reason: named(
      (s) => `${s} unexpectedly closed the connection.`,
      'The connection was closed unexpectedly.'
    )
  },
  [-101]: {
    name: 'ERR_CONNECTION_RESET',
    title: UNREACHABLE,
    reason: () => 'The connection was reset.'
  },
  [-102]: {
    name: 'ERR_CONNECTION_REFUSED',
    title: UNREACHABLE,
    reason: named((s) => `${s} refused to connect.`, 'The server refused to connect.')
  },
  [-105]: {
    name: 'ERR_NAME_NOT_RESOLVED',
    title: UNREACHABLE,
    reason: named(
      (s) => `${s}'s server IP address could not be found.`,
      "The server's IP address could not be found."
    )
  },
  [-106]: {
    name: 'ERR_INTERNET_DISCONNECTED',
    title: NO_INTERNET,
    reason: () => 'Your device is offline. Check Wi-Fi or mobile data, then reload.'
  },
  [-107]: {
    name: 'ERR_SSL_PROTOCOL_ERROR',
    title: "This site can't provide a secure connection",
    reason: named((s) => `${s} sent an invalid response.`, 'The server sent an invalid response.')
  },
  [-109]: {
    name: 'ERR_ADDRESS_UNREACHABLE',
    title: UNREACHABLE,
    reason: named((s) => `${s} is unreachable.`, 'The address is unreachable.')
  },
  [-113]: {
    name: 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
    title: "This site can't provide a secure connection",
    reason: named(
      (s) => `${s} uses an unsupported protocol.`,
      'The server uses an unsupported protocol.'
    )
  },
  [-118]: {
    name: 'ERR_CONNECTION_TIMED_OUT',
    title: UNREACHABLE,
    reason: named((s) => `${s} took too long to respond.`, 'The server took too long to respond.')
  },
  [-200]: {
    name: 'ERR_CERT_COMMON_NAME_INVALID',
    title: NOT_PRIVATE,
    reason: named(
      (s) => `The certificate ${s} sent is not trusted.`,
      'The certificate this site sent is not trusted.'
    )
  },
  [-201]: {
    name: 'ERR_CERT_DATE_INVALID',
    title: NOT_PRIVATE,
    reason: named(
      (s) => `The certificate ${s} sent has expired or is not yet valid.`,
      'The certificate this site sent has expired or is not yet valid.'
    )
  },
  [-202]: {
    name: 'ERR_CERT_AUTHORITY_INVALID',
    title: NOT_PRIVATE,
    reason: named(
      (s) => `The certificate ${s} sent was issued by an authority Zenium does not trust.`,
      'The certificate this site sent was issued by an authority Zenium does not trust.'
    )
  },
  [-207]: {
    name: 'ERR_CERT_INVALID',
    title: NOT_PRIVATE,
    reason: named(
      (s) => `The certificate ${s} sent is invalid.`,
      'The certificate this site sent is invalid.'
    )
  },
  [-300]: {
    name: 'ERR_INVALID_URL',
    title: UNREACHABLE,
    reason: () => 'The address is invalid.'
  },
  [-310]: {
    name: 'ERR_TOO_MANY_REDIRECTS',
    title: NOT_WORKING,
    reason: named(
      (s) => `${s} redirected you too many times.`,
      'The page redirected you too many times.'
    )
  },
  [-312]: {
    // Chromium never connects to a few reserved ports (1, 7, 25, …): `localhost:1` fails this way.
    name: 'ERR_UNSAFE_PORT',
    title: UNREACHABLE,
    reason: named(
      (s) => `${s} uses a port Zenium does not connect to.`,
      'The address uses a port Zenium does not connect to.'
    )
  },
  [-324]: {
    name: 'ERR_EMPTY_RESPONSE',
    title: NOT_WORKING,
    reason: named((s) => `${s} didn't send any data.`, "The server didn't send any data.")
  },
  [-501]: {
    name: 'ERR_INSECURE_RESPONSE',
    title: NOT_PRIVATE,
    reason: named((s) => `${s} sent an insecure response.`, 'The site sent an insecure response.')
  }
}

/** The hosts report a crashed renderer through this code (not a `net::` error); the description carries the reason. */
const CRASH_CODE = -1

/** Chromium `net::` error codes eligible for the https→http typed-input fallback. */
export const HTTP_FALLBACK_CODES = new Set([
  -102, -105, -107, -113, -118, -7, -100, -101, -109, -200, -201, -202, -203, -204, -205, -206,
  -207, -208, -210, -211, -212, -213, -324, -501
])

/** The one-line reason for a `net::` error code, without naming the site (the hosts' fallback description). */
export function describeNetError(code: number, fallback: string): string {
  return NET_ERRORS[code]?.reason('') ?? fallback
}

/** What the error page shows: everything is derived here so the rendering stays a template. */
export interface ErrorPageContent {
  title: string
  /** The host name of the failed URL ('' when the URL has none). */
  site: string
  reason: string
  /** The Chromium error name (`ERR_…`), or the host's own description when the code has no name. */
  code: string
  /** The failed URL the Reload control goes back to ('' when there is none). */
  target: string
}

/** The `net::ERR_…` name in a host description like `net::ERR_NAME_NOT_RESOLVED`, or null. */
function errorNameIn(description: string): string | null {
  const match = /^(?:net::)?(ERR_[A-Z0-9_]+)$/.exec(description.trim())
  return match ? match[1] : null
}

/** The host name of `url` for the page's copy (Chrome names the host, never the port); '' when unusable. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function errorPageContent(
  code: number,
  description: string,
  target: string
): ErrorPageContent {
  const site = siteOf(target)
  if (code === CRASH_CODE) {
    return {
      title: 'Aw, Snap!',
      site,
      reason: 'Something went wrong while displaying this page.',
      code: description,
      target
    }
  }
  const copy = NET_ERRORS[code]
  // The host's description is the exact Chromium name when it has one (`net::ERR_…`); a code
  // without a table entry keeps whatever prose the host sent as its reason.
  const name = errorNameIn(description) ?? copy?.name ?? ''
  const fallback = (!name && description) || 'The page could not be loaded.'
  return {
    title: copy?.title ?? UNREACHABLE,
    site,
    reason: copy?.reason(site) ?? fallback,
    code: name,
    target
  }
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

/**
 * `css` from `start` up to the next `end`, without comments and blank lines: the part of the
 * chrome's stylesheet the error page reads. '' when a marker is gone, so the page degrades to an
 * unstyled document rather than failing (`zenPages.test.ts` fails instead).
 */
function cssBetween(css: string, start: number, end: string): string {
  const to = start === -1 ? -1 : css.indexOf(end, start)
  if (to === -1) return ''
  return css
    .slice(start, to)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n')
    .trim()
}

/** Ends the design language v2 token block of `main.css` (it starts at the `:root {` declaring `--v2-page`). */
export const V2_TOKENS_END = '/* Zen clamps its primary colour'

/** The `.zen-v2-button` rule and its variants (a v2 surface of its own in `main.css`). */
export const V2_BUTTON_END = '/* Safe-area insets pushed by mobile hosts'

/** The error page's own rules in `main.css`, listed in `v2Tokens.test.ts` as the page's surface. */
export const ERROR_PAGE_RULES_START = '.zen-error-document {'
export const ERROR_PAGE_RULES_END = '@layer base {'

/**
 * The error page's stylesheet, cut from the chrome's (design-language-v2-draft §1, §2, §4): the
 * token block (light, dark, coarse pointer, phone, the shared `zen-v2-*` focus ring), the v2
 * button that the Reload control is, and the page's own layout and type rules. Every colour and
 * size is read from a token; `light-dark()`, which the system WebView the page ships to (113 on
 * the emulator) does not know, appears nowhere.
 */
export function errorPageStyle(css: string = chromeStylesheet): string {
  const tokens = css.indexOf('--v2-page:')
  return [
    cssBetween(css, tokens === -1 ? -1 : css.lastIndexOf(':root {', tokens), V2_TOKENS_END),
    cssBetween(css, css.indexOf('.zen-v2-button {'), V2_BUTTON_END),
    cssBetween(css, css.indexOf(ERROR_PAGE_RULES_START), ERROR_PAGE_RULES_END)
  ]
    .filter(Boolean)
    .join('\n')
}

const ERROR_STYLE = errorPageStyle()

/**
 * Puts the chrome's root attributes on the page's root from the media the tab sees, so the token
 * block's `:root[data-theme='dark']`, `[data-pointer='coarse']` and `[data-form-factor='phone']`
 * rules apply to the page as they do to the chrome. The classification is `classifyViewport`'s
 * (`formFactor.ts`), including the WebView's `pointer: fine` on plain touch screens; the theme
 * is the tab's colour scheme, the same one every page in the tab sees.
 */
export const ERROR_PAGE_ATTRIBUTES_SCRIPT =
  '(function(){var d=document.documentElement,q=function(m){return matchMedia(m).matches};' +
  "if(q('(prefers-color-scheme: dark)'))d.dataset.theme='dark';" +
  "var hover=q('(hover: hover)'),coarse=q('(pointer: coarse)')||(navigator.maxTouchPoints>0&&!hover)," +
  'side=coarse&&!hover?Math.min(innerWidth,innerHeight):innerWidth;' +
  "d.dataset.pointer=coarse?'coarse':'fine';" +
  `d.dataset.formFactor=side<${PHONE_MAX_WIDTH}?'phone':coarse?'tablet':'desktop'})()`

/** The reason with the site's name set in bold, the way Chrome names the site it could not reach. */
function emphasiseSite(reason: string, site: string): string {
  const at = site ? reason.indexOf(site) : -1
  if (at === -1) return escapeHtml(reason)
  return `${escapeHtml(reason.slice(0, at))}<strong>${escapeHtml(site)}</strong>${escapeHtml(reason.slice(at + site.length))}`
}

/** `net::ERR_BLOCKED_BY_CLIENT`: the request engine stopped the navigation itself. */
export const BLOCKED_BY_CLIENT_CODE = -20

/** `zen://error?code=…&description=…&url=…`: Chrome's error page, in the tab, for the failed URL. */
export function errorPageHtml(url: URL): string {
  const code = Number(url.searchParams.get('code') ?? 0)
  const target = url.searchParams.get('url') ?? ''
  const kind = url.searchParams.get('kind')
  if (kind === 'safebrowsing')
    return safeBrowsingPageHtml(target, threatOf(url.searchParams.get('threat')))
  if (kind === 'https-only') return httpsOnlyPageHtml(target, code)
  if (code === BLOCKED_BY_CLIENT_CODE) return blockedPageHtml(target)
  const content = errorPageContent(code, url.searchParams.get('description') ?? '', target)
  const reload = content.target
    ? `\n  <button type="button" class="zen-v2-button" onclick="location.replace(${escapeHtml(JSON.stringify(content.target))})">Reload</button>`
    : ''
  const name = content.code ? `\n  <p class="zen-error-code">${escapeHtml(content.code)}</p>` : ''
  return `<!doctype html><html class="zen-error-document"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.site || 'Problem loading page')}</title><script>${ERROR_PAGE_ATTRIBUTES_SCRIPT}</script><style>${ERROR_STYLE}</style></head>
<body class="zen-error-page"><main>
  <h1>${escapeHtml(content.title)}</h1>
  <p>${emphasiseSite(content.reason, content.site)}</p>${name}${reload}
</main></body></html>`
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

function hostOf(target: string): string {
  try {
    return new URL(target).hostname || target
  } catch {
    return target
  }
}

function threatOf(value: string | null): SafeBrowsingThreat {
  return value && value in SAFE_BROWSING_THREAT_LABELS ? (value as SafeBrowsingThreat) : 'unknown'
}

const INTERSTITIAL_STYLE = `
  .card { text-align: left; max-width: 560px; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  details { margin: 0 0 20px; opacity: .8; line-height: 1.5; }
  summary { cursor: pointer; }
  .warn { font-size: 40px; line-height: 1; margin-bottom: 16px; }
`

function postAction(action: InterstitialAction, target: string): string {
  return `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:${JSON.stringify(action)},url:${JSON.stringify(target)}}},'*')`
}

/**
 * Safe Browsing's interstitial (Chrome's red page, in Zenium's words): the request engine
 * refused the navigation because the site is on a malware or phishing feed. "Proceed anyway"
 * excepts the origin until the browser closes.
 */
export function safeBrowsingPageHtml(target: string, threat: SafeBrowsingThreat): string {
  const host = hostOf(target)
  const copy = SAFE_BROWSING_THREAT_LABELS[threat]
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Security warning</title><style>${BASE_STYLE}${INTERSTITIAL_STYLE}</style></head>
<body><div class="card" data-interstitial="safebrowsing" data-threat="${escapeHtml(threat)}">
  <div class="warn" aria-hidden="true">&#9888;</div>
  <h1>${escapeHtml(copy.title)}</h1>
  <p>Zenium stopped this page. ${escapeHtml(copy.description)}</p>
  <details>
    <summary>Details</summary>
    <p><strong>${escapeHtml(host)}</strong> is on one of the open malware and phishing feeds Zenium checks (URLhaus, Phishing.Database, malware-filter). Feeds are refreshed while the browser runs; Safe Browsing can be turned off in Settings &rsaquo; Privacy and security.</p>
    <p><code>${escapeHtml(target)}</code></p>
    <p><button class="secondary" onclick="${escapeHtml(postAction('proceed', target))}">Proceed anyway (unsafe)</button></p>
  </details>
  <div class="actions">
    <button class="primary" autofocus onclick="${escapeHtml(postAction('back', target))}">Back to safety</button>
  </div>
</div></body></html>`
}

/**
 * HTTPS-only mode's question: the https upgrade of `httpUrl` failed, so the page can only be
 * had over plaintext. "Continue" allows the site until the browser closes; "Always allow"
 * remembers it (the `https-only` permission).
 */
export function httpsOnlyPageHtml(httpUrl: string, code: number): string {
  const host = hostOf(httpUrl)
  const reason = describeNetError(code, 'The secure connection could not be made.')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Secure connection not available</title><style>${BASE_STYLE}${INTERSTITIAL_STYLE}</style></head>
<body><div class="card" data-interstitial="https-only">
  <div class="warn" aria-hidden="true">&#128275;</div>
  <h1>Secure connection not available</h1>
  <p>Zenium tried to reach <strong>${escapeHtml(host)}</strong> over https and could not. Loading it over http means what you send and receive can be read and changed on the way.</p>
  <details>
    <summary>Details</summary>
    <p>${escapeHtml(reason)}${code ? ` (${code})` : ''}</p>
    <p><code>${escapeHtml(httpUrl)}</code></p>
    <p>HTTPS-only mode can be changed in Settings &rsaquo; Privacy and security.</p>
  </details>
  <div class="actions">
    <button class="primary" autofocus onclick="${escapeHtml(postAction('back', httpUrl))}">Back to safety</button>
    <button class="secondary" onclick="${escapeHtml(postAction('continue', httpUrl))}">Continue to HTTP site</button>
    <button class="secondary" onclick="${escapeHtml(postAction('continue-always', httpUrl))}">Always allow for this site</button>
  </div>
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
  bookmarks: 'bookmarks',
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

/** HTML for any `zen://` URL (unknown pages fall back to the blank page). */
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

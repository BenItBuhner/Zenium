/**
 * `zen://` internal pages. `zen://newtab` is the new tab page (its document lives in
 * `newTabPage.ts`; the host's preload fills it), `zen://blank` an empty page that picks up the
 * theme (new tabs on hosts without the page); `zen://error` renders navigation failures,
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
import type { CertificateDetails, OverlayKind } from './types'
import { SAFE_BROWSING_THREAT_LABELS, type SafeBrowsingThreat } from './privacy'
import { INTERSTITIAL_MESSAGE_KEY, type InterstitialAction } from './interstitial'
import { isCertificateError } from './siteInfo'
import { errorPageCertificate } from './url'
import { newTabPageHtml } from './newTabPage'

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
  /**
   * The certificate interstitial's part, for an `ERR_CERT_*` failure of an https address: the
   * page then offers Back to safety and Advanced, which reveals this and the proceed control, as
   * Chrome's does. Null for every other failure, which keeps the Reload control.
   */
  interstitial: CertificateInterstitial | null
}

export interface CertificateInterstitial {
  /** Chrome's explanation of what is wrong with the certificate (the Advanced block's paragraph). */
  explanation: string
  /** The refused certificate's fields, label and value; empty when the host could not describe it. */
  details: Array<{ label: string; value: string }>
  /**
   * The proceed control's label, `Proceed to <host> (unsafe)`; null when the host could not
   * fingerprint the certificate, since an exception is remembered by that and none could be.
   */
  proceed: string | null
}

/** Chrome's Advanced-block sentence per certificate error; the default covers the rest of the family. */
const CERTIFICATE_EXPLANATIONS: Record<
  number,
  (site: string, cert: CertificateDetails | null) => string
> = {
  [-200]: (site, cert) =>
    `This server could not prove that it is ${site}; its security certificate is ${
      cert?.subjectName ? `from ${cert.subjectName}` : 'for another site'
    }. This may be caused by a misconfiguration or an attacker intercepting your connection.`,
  [-201]: (site) =>
    `This server could not prove that it is ${site}; its security certificate has expired or is not yet valid. This may be caused by a misconfiguration, an attacker intercepting your connection, or a wrong clock on this device.`,
  [-202]: (site) =>
    `This server could not prove that it is ${site}; its security certificate is not trusted by this device's operating system. This may be caused by a misconfiguration or an attacker intercepting your connection.`
}

/** A certificate date for the details list; ISO when the runtime has no locale formatting. */
function certificateDate(ms: number): string {
  const date = new Date(ms)
  try {
    return date.toLocaleDateString(undefined, { dateStyle: 'medium' })
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/**
 * The interstitial's part of the page for an `ERR_CERT_*` failure of an https address (`target`);
 * null for any other failure or address, so an http or `file:` failure never offers to proceed.
 */
export function certificateInterstitial(
  code: number,
  target: string,
  certificate: CertificateDetails | null
): CertificateInterstitial | null {
  if (!isCertificateError(code) || !/^https:\/\//i.test(target)) return null
  const site = siteOf(target)
  if (!site) return null
  const explain =
    CERTIFICATE_EXPLANATIONS[code] ??
    ((s: string) =>
      `This server could not prove that it is ${s}; its security certificate is not valid. This may be caused by a misconfiguration or an attacker intercepting your connection.`)
  const details: Array<{ label: string; value: string }> = []
  if (certificate) {
    if (certificate.subjectName)
      details.push({ label: 'Issued to', value: certificate.subjectName })
    if (certificate.issuerName) details.push({ label: 'Issued by', value: certificate.issuerName })
    if (certificate.validStart)
      details.push({ label: 'Valid from', value: certificateDate(certificate.validStart) })
    if (certificate.validExpiry)
      details.push({ label: 'Valid until', value: certificateDate(certificate.validExpiry) })
    if (certificate.fingerprint)
      details.push({ label: 'Fingerprint', value: certificate.fingerprint })
  }
  return {
    explanation: explain(site, certificate),
    details,
    proceed: certificate?.fingerprint ? `Proceed to ${site} (unsafe)` : null
  }
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
  target: string,
  certificate: CertificateDetails | null = null
): ErrorPageContent {
  const site = siteOf(target)
  if (code === CRASH_CODE) {
    return {
      title: 'Aw, Snap!',
      site,
      reason: 'Something went wrong while displaying this page.',
      code: description,
      target,
      interstitial: null
    }
  }
  const copy = NET_ERRORS[code]
  // The host's description is the exact Chromium name when it has one (`net::ERR_…`); a code
  // without a table entry keeps whatever prose the host sent as its reason.
  const name = errorNameIn(description) ?? copy?.name ?? ''
  const fallback = (!name && description) || 'The page could not be loaded.'
  const interstitial = certificateInterstitial(code, target, certificate)
  return {
    // Every certificate failure is Chrome's "not private" page, named in the table or not.
    title: copy?.title ?? (interstitial ? NOT_PRIVATE : UNREACHABLE),
    site,
    reason: copy?.reason(site) ?? (interstitial ? NET_ERRORS[-207].reason(site) : fallback),
    code: name,
    target,
    interstitial
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
 * The status inks – `--zen-ok`, `--zen-warn`, `--zen-danger` and their rgb triples, which the
 * token block's `--v2-ok` / `--v2-warn` / `--v2-danger` alias (§9.29: status ink is shared by
 * both families, as ink only) – cut from the chrome's first light and dark root blocks and set
 * on the page's root, for the interstitials' title glyphs and the way on to a dangerous site.
 * '' when the blocks are gone.
 */
function statusInkStyle(css: string): string {
  const declarations = (selector: string): string[] => {
    const start = css.indexOf(`${selector} {`)
    if (start === -1) return []
    const body = css.slice(start, css.indexOf('\n}', start))
    return body.match(/--zen-(?:ok|warn|danger)(?:-rgb)?: [^;]+;/g) ?? []
  }
  // Restated on the page's root under the token block's own selectors (the page is a document
  // of its own, so `:root` is the error document).
  const rule = (selector: string): string => {
    const lines = declarations(selector)
    return lines.length ? `${selector} {\n  ${lines.join('\n  ')}\n}` : ''
  }
  return [rule(':root'), rule(":root[data-theme='dark']")].filter(Boolean).join('\n')
}

/**
 * The error page's stylesheet, cut from the chrome's (design-language-v2-draft §1, §2, §4): the
 * token block (light, dark, coarse pointer, phone, the shared `zen-v2-*` focus ring), the v2
 * button that the Reload control is, the status inks the token block aliases, and the page's
 * own layout and type rules – the interstitials' included. Every colour and size is read from a
 * token; `light-dark()`, which the system WebView the page ships to (113 on the emulator) does
 * not know, appears nowhere.
 */
export function errorPageStyle(css: string = chromeStylesheet): string {
  const tokens = css.indexOf('--v2-page:')
  return [
    cssBetween(css, tokens === -1 ? -1 : css.lastIndexOf(':root {', tokens), V2_TOKENS_END),
    cssBetween(css, css.indexOf('.zen-v2-button {'), V2_BUTTON_END),
    statusInkStyle(css),
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

/** Toggles the Advanced block open and closed (the page's own script; nothing crosses to the browser). */
const ADVANCED_TOGGLE_SCRIPT =
  "var a=document.getElementById('zen-error-advanced'),open=a.hidden;a.hidden=!open;" +
  "this.setAttribute('aria-expanded',String(open));this.textContent=open?'Hide advanced':'Advanced'"

/**
 * The certificate interstitial's controls: a page's action row (design language v2 §9.11) with
 * Back to safety as the one primary button, last, so it trails on both platforms – right-aligned
 * on desktop, the trailing half of the split row on the phone (`.zen-error-actions`) – and
 * Advanced before it, revealing the explanation, the certificate and the proceed control, which
 * reads as text so nobody presses it in passing. Back and Proceed post the interstitial message
 * the other warning pages post (`postAction`), which the page script relays.
 */
function interstitialHtml(interstitial: CertificateInterstitial, target: string): string {
  const rows = interstitial.details
    .map((d) => `\n      <div><dt>${escapeHtml(d.label)}</dt><dd>${escapeHtml(d.value)}</dd></div>`)
    .join('')
  const details = rows ? `\n    <dl class="zen-error-certificate">${rows}\n    </dl>` : ''
  const proceed = interstitial.proceed
    ? `\n    <button type="button" class="zen-error-proceed" onclick="${escapeHtml(postAction('proceed', target))}">${escapeHtml(interstitial.proceed)}</button>`
    : ''
  return `
  <div class="zen-error-actions">
    <button type="button" class="zen-v2-button" aria-expanded="false" aria-controls="zen-error-advanced" onclick="${escapeHtml(ADVANCED_TOGGLE_SCRIPT)}">Advanced</button>
    <button type="button" class="zen-v2-button" data-primary onclick="${escapeHtml(postAction('back', target))}">Back to safety</button>
  </div>
  <section id="zen-error-advanced" class="zen-error-advanced" hidden>
    <p>${escapeHtml(interstitial.explanation)}</p>${details}${proceed}
  </section>`
}

/**
 * The script that puts the `zen://error` page `url` in place of the empty document Chromium
 * commits for a failed load (`TabView.showErrorPage`): the document's own root stays, so the
 * page script's listeners and the entry the failure committed stay with it, and the root
 * attributes the page's inline script would set are set here (markup written this way runs no
 * scripts). Only an error document is touched; a page that did load meanwhile is left alone.
 */
export function inPlaceErrorPageScript(url: URL): string {
  const html = JSON.stringify(errorPageHtml(url))
  return (
    "(function(html){if(location.protocol!=='chrome-error:')return false;" +
    "var doc=new DOMParser().parseFromString(html,'text/html'),root=document.documentElement;" +
    'root.className=doc.documentElement.className;root.innerHTML=doc.documentElement.innerHTML;' +
    `${ERROR_PAGE_ATTRIBUTES_SCRIPT};return true})(${html})`
  )
}

/** `zen://error?code=…&description=…&url=…`: Chrome's error page, in the tab, for the failed URL. */
export function errorPageHtml(url: URL): string {
  const code = Number(url.searchParams.get('code') ?? 0)
  const target = url.searchParams.get('url') ?? ''
  const kind = url.searchParams.get('kind')
  if (kind === 'safebrowsing')
    return safeBrowsingPageHtml(target, threatOf(url.searchParams.get('threat')))
  if (kind === 'https-only') return httpsOnlyPageHtml(target, code)
  if (code === BLOCKED_BY_CLIENT_CODE) return blockedPageHtml(target)
  const content = errorPageContent(
    code,
    url.searchParams.get('description') ?? '',
    target,
    errorPageCertificate(url.searchParams)
  )
  const controls = content.interstitial
    ? interstitialHtml(content.interstitial, content.target)
    : content.target
      ? `\n  <button type="button" class="zen-v2-button" onclick="location.replace(${escapeHtml(JSON.stringify(content.target))})">Reload</button>`
      : ''
  const name = content.code ? `\n  <p class="zen-error-code">${escapeHtml(content.code)}</p>` : ''
  return `<!doctype html><html class="zen-error-document"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.site || 'Problem loading page')}</title><script>${ERROR_PAGE_ATTRIBUTES_SCRIPT}</script><style>${ERROR_STYLE}</style></head>
<body class="zen-error-page"><main>
  <h1>${escapeHtml(content.title)}</h1>
  <p>${emphasiseSite(content.reason, content.site)}</p>${name}${controls}
</main></body></html>`
}

/**
 * Shown when a filter list blocks a whole page (malware hosts, ad-only domains). The site can be
 * excepted in Settings → Privacy and Security; the page itself only offers the way back.
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
  <p>To visit it anyway, add the site to the exceptions in Settings &rsaquo; Privacy and Security.</p>
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

/** An inline handler posting the interstitial message `action` for `target` (the certificate page's controls). */
function postAction(action: InterstitialAction, target: string): string {
  return `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:${JSON.stringify(action)},url:${JSON.stringify(target)}}},'*')`
}

/** Lucide's glyphs the warning pages draw inline (the page cannot import the icon set). */
const GLYPHS = {
  'shield-alert':
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  'lock-open':
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
} as const

function glyph(name: keyof typeof GLYPHS): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`
}

/** A warning page's action: the v2 button that posts `action` for the page it stands in for. */
interface WarningButton {
  action: InterstitialAction
  label: string
  /** The page's one primary (Back to safety). */
  primary?: boolean
  /** Goes on to a site Safe Browsing flagged: the label in danger ink. */
  danger?: boolean
}

/** What a warning page says and offers; `warningPageHtml` lays it out. */
interface WarningPage {
  kind: 'safebrowsing' | 'https-only'
  /** The `<title>`. */
  name: string
  /** The status ink of the title's glyph. */
  tone: 'danger' | 'warn'
  glyph: keyof typeof GLYPHS
  title: string
  /** HTML: the title block's description. */
  description: string
  /** The actions beside Details, in order; the primary trails. */
  actions: WarningButton[]
  /** HTML paragraphs under Details, before the address. */
  details: string
  /** The actions under Details, after the address. */
  detailActions: WarningButton[]
  /** The page the interstitial stands in for. */
  target: string
  /** Extra `data-` attributes on the page's `<main>`. */
  data?: Record<string, string>
}

/**
 * The warning pages' script: Details toggles its section; an action posts the page's message
 * (`INTERSTITIAL_MESSAGE_KEY`, relayed to the core) and turns busy – `aria-busy` with the
 * spinner in the label's place, the other actions disabled at .4 (§9.30) – until the browser
 * answers by leaving the page. Should it not, the page frees itself after a while so the
 * choice can be made again.
 */
function warningPageScript(target: string): string {
  const url = JSON.stringify(target).replace(/</g, '\\u003c')
  return (
    '(function(){var main=document.querySelector("main"),toggle=document.getElementById("zen-details-toggle"),details=document.getElementById("zen-details"),' +
    'all=function(){return Array.prototype.slice.call(document.querySelectorAll(".zen-interstitial-action"))};' +
    'toggle.addEventListener("click",function(){var open=details.hidden;details.hidden=!open;toggle.setAttribute("aria-expanded",String(open))});' +
    'all().forEach(function(b){if(!b.dataset.action)return;b.addEventListener("click",function(){' +
    'if(main.dataset.busy)return;main.dataset.busy="true";b.setAttribute("aria-busy","true");' +
    'all().forEach(function(o){if(o!==b)o.disabled=true});' +
    `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:b.dataset.action,url:${url}}},"*");` +
    'setTimeout(function(){delete main.dataset.busy;b.removeAttribute("aria-busy");all().forEach(function(o){o.disabled=false})},8000)})})})()'
  )
}

function warningButton(button: WarningButton, autofocus: boolean): string {
  const classes = ['zen-v2-button', 'zen-interstitial-action']
  if (button.danger) classes.push('zen-interstitial-danger')
  return `<button type="button" class="${classes.join(' ')}"${button.primary ? ' data-primary' : ''}${autofocus ? ' autofocus' : ''} data-action="${button.action}"><span class="zen-interstitial-label">${escapeHtml(button.label)}</span><span class="zen-interstitial-spinner">${glyph('loader-circle')}</span></button>`
}

/**
 * A warning page – Safe Browsing's and HTTPS-only mode's interstitials – on the error page's
 * surface (design-language-v2-draft §9.11, §9.23, §9.30;
 * the rules are the page's own in `main.css`): the neutral page, its block anchored at 30% of
 * the page's height (§9.17), a title block – the glyph in status ink before the 22/600 title, the
 * description under it – and the actions 16 below: Details first, the way on beside it, Back to
 * safety as the primary trailing, the row right-aligned on desktop (a phone splits two peers and
 * stacks three, primary first). Under Details, 16 below the actions, the reason, the address at
 * 13 and the secondary that goes on regardless.
 */
function warningPageHtml(page: WarningPage): string {
  const data = Object.entries({ interstitial: page.kind, ...page.data })
    .map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`)
    .join('')
  const actions = [
    `<button type="button" id="zen-details-toggle" class="zen-v2-button zen-interstitial-action" aria-expanded="false" aria-controls="zen-details">Details</button>`,
    ...page.actions.map((b) => warningButton(b, b.primary === true))
  ]
  return `<!doctype html><html class="zen-error-document"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(page.name)}</title><script>${ERROR_PAGE_ATTRIBUTES_SCRIPT}</script><style>${ERROR_STYLE}</style></head>
<body class="zen-error-page"><main${data}>
  <div class="zen-interstitial-title" data-tone="${page.tone}">
    ${glyph(page.glyph)}
    <div>
      <h1>${escapeHtml(page.title)}</h1>
      <p>${page.description}</p>
    </div>
  </div>
  <div class="zen-interstitial-actions">
    ${actions.join('\n    ')}
  </div>
  <section id="zen-details" class="zen-interstitial-details" hidden>
    ${page.details}
    <p class="zen-interstitial-address">${escapeHtml(page.target)}</p>
    <div class="zen-interstitial-actions">
      ${page.detailActions.map((b) => warningButton(b, false)).join('\n      ')}
    </div>
  </section>
</main><script>${warningPageScript(page.target)}</script></body></html>`
}

/**
 * Safe Browsing's interstitial (Chrome's red page, in Zenium's words on the neutral page): the
 * request engine refused the navigation because the site is on a malware or phishing feed.
 * "Proceed anyway", under Details, excepts the host until the browser closes.
 */
export function safeBrowsingPageHtml(target: string, threat: SafeBrowsingThreat): string {
  const host = hostOf(target)
  const copy = SAFE_BROWSING_THREAT_LABELS[threat]
  return warningPageHtml({
    kind: 'safebrowsing',
    name: 'Security warning',
    tone: 'danger',
    glyph: 'shield-alert',
    title: copy.title,
    description: `Zenium stopped this page. ${escapeHtml(copy.description)}`,
    actions: [{ action: 'back', label: 'Back to safety', primary: true }],
    details: `<p><strong>${escapeHtml(host)}</strong> is on one of the open malware and phishing feeds Zenium checks (URLhaus, Phishing.Database, malware-filter). Feeds are refreshed while the browser runs; Safe Browsing can be turned off in Settings &rsaquo; Privacy and Security.</p>`,
    detailActions: [{ action: 'proceed', label: 'Proceed anyway (unsafe)', danger: true }],
    target,
    data: { threat }
  })
}

/**
 * HTTPS-only mode's question: the https upgrade of `httpUrl` failed, so the page can only be
 * had over plaintext. "Continue" allows the site until the browser closes; "Always allow",
 * under Details, remembers it (the `https-only` permission).
 */
export function httpsOnlyPageHtml(httpUrl: string, code: number): string {
  const host = hostOf(httpUrl)
  const reason = describeNetError(code, 'The secure connection could not be made.')
  return warningPageHtml({
    kind: 'https-only',
    name: 'Secure connection not available',
    tone: 'warn',
    glyph: 'lock-open',
    title: 'Secure connection not available',
    description: `Zenium tried to reach <strong>${escapeHtml(host)}</strong> over https and could not. Loading it over http means what you send and receive can be read and changed on the way.`,
    actions: [
      { action: 'continue', label: 'Continue to HTTP site' },
      { action: 'back', label: 'Back to safety', primary: true }
    ],
    details: `<p>${escapeHtml(reason)}${code ? ` (${code})` : ''}</p>
    <p>HTTPS-only mode can be changed in Settings &rsaquo; Privacy and Security.</p>`,
    detailActions: [{ action: 'continue-always', label: 'Always allow for this site' }],
    target: httpUrl
  })
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

/**
 * `zen://` addresses that are chrome surfaces rather than documents, and the overlay each opens.
 * Settings is not one of them any more: it is an internal page that opens as a tab
 * (`shared/internalPages.ts`, `core/pages.ts`), or as its overlay on hosts without page tabs.
 */
const OVERLAY_PAGES: Record<string, OverlayKind> = {
  bookmarks: 'bookmarks',
  downloads: 'downloads',
  history: 'history'
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
    case 'newtab':
      return newTabPageHtml()
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

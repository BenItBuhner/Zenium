import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/*
 * Chromium's credits on the desktop (Settings › About › Open-source licences › Chromium, the
 * `zen://chromium-licences` document; settings-73): Electron ships the engine's credits – Chrome's
 * chrome://credits, twenty megabytes of every third-party component inside Chromium – as
 * `LICENSES.chromium.html` beside its binary, and electron-builder keeps the file at the app's
 * root on Linux and Windows (a macOS bundle drops it). The Licences page's own list is the
 * packages' (`scripts/licences.ts`); this document is too large to bundle and is Electron's to
 * publish, so the main process serves it from disk as one `zen://` document, rewritten to stand
 * without Chrome's `chrome://resources` stylesheets: its licences fold behind their own "Show
 * licence" labels, as on chrome://credits. A build without the file (a packaged macOS app, an odd
 * unpack) gets a page saying so and where Electron publishes it.
 */

/** The file Electron ships beside its binary. */
export const CHROMIUM_LICENCES_FILE = 'LICENSES.chromium.html'

/** The response for `zen://chromium-licences`. */
export type ChromiumLicencesResponder = () => Promise<Response>

/**
 * Where the credits document may lie for this binary: beside the executable (Linux and Windows,
 * packaged or the `node_modules/electron/dist` of a dev run), and on macOS – where the executable
 * is `Contents/MacOS/Electron` inside a bundle – the directory holding the bundle too (the dev
 * run's `dist/`, which keeps the file the bundle does not).
 */
export function chromiumLicencesCandidates(
  execPath: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const beside = dirname(execPath)
  const dirs = platform === 'darwin' ? [beside, resolve(beside, '../../..')] : [beside]
  return dirs.map((dir) => join(dir, CHROMIUM_LICENCES_FILE))
}

/**
 * Electron's document as one page of its own: Chrome's `<link>`s to `chrome://resources` and
 * `chrome://credits` stylesheets – which no other origin can load – go, and one stylesheet of
 * ours stands in their place, keeping chrome://credits' shape: a product per block, its title
 * and homepage on one line, the licence folded behind the "Show licence" label whose hidden
 * checkbox the document already carries, "Show all licences" at the head.
 */
export function rewriteChromiumCredits(html: string): string {
  const stripped = html.replace(/<link\b[^>]*\bhref="chrome:\/\/[^"]*"[^>]*>\s*/g, '')
  const style = `<style>${CREDITS_STYLE}</style>`
  const head = stripped.indexOf('</head>')
  return head >= 0
    ? `${stripped.slice(0, head)}${style}\n${stripped.slice(head)}`
    : `${style}\n${stripped}`
}

/**
 * The stylesheet the rewritten document carries (`credits.css` and `text_defaults.css`
 * remade): the system colours, so the document follows the OS theme as chrome://credits does;
 * the licence text folded until its label's checkbox is on.
 */
export const CREDITS_STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  padding: 24px 32px 48px;
  background: Canvas;
  color: CanvasText;
  font: 15px/1.5 system-ui, sans-serif;
}
h1 { margin: 0 0 16px; font-size: 22px; line-height: 28px; }
a { color: LinkText; }
label.show {
  display: inline-block;
  cursor: pointer;
  color: LinkText;
  text-decoration: underline;
  user-select: none;
}
label.show input { display: none; }
label.show::before { content: 'Show licence'; }
label.show:has(input:checked)::before { content: 'Hide licence'; }
label.show-all::before { content: 'Show all licences'; }
label.show-all:has(input:checked)::before { content: 'Hide all licences'; }
.product {
  display: grid;
  grid-template-columns: 1fr auto auto;
  column-gap: 16px;
  align-items: baseline;
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
}
.product .title { font-weight: 600; }
.product .license {
  display: none;
  grid-column: 1 / -1;
  margin: 8px 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 20px;
}
.product .license pre { margin: 0; font: inherit; white-space: inherit; }
.product:has(> .show input:checked) .license,
body:has(> .show-all input:checked) .license { display: block; }
`

/** What stands in for the document when the build does not carry it. */
export function chromiumLicencesFallbackHtml(electronVersion: string): string {
  const version = escapeHtml(electronVersion)
  const release = `https://github.com/electron/electron/releases/tag/v${encodeURIComponent(electronVersion)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chromium credits</title>
<style>${CREDITS_STYLE}</style>
</head>
<body>
<h1>Chromium credits</h1>
<p>This build of Zenium does not carry the credits document for its engine.</p>
<p>Zenium runs on Chromium through Electron ${version}, and Electron publishes the engine’s credits – every third-party component inside Chromium, with its licence – as <code>${CHROMIUM_LICENCES_FILE}</code> with each release: <a href="${release}">${escapeHtml(release)}</a></p>
</body>
</html>
`
}

/**
 * The document, from the first candidate that exists; the fallback page when none does or the
 * file cannot be read.
 */
export async function chromiumLicencesResponse(
  candidates: readonly string[],
  electronVersion: string
): Promise<Response> {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  const file = candidates.find((path) => existsSync(path))
  if (file) {
    try {
      return new Response(rewriteChromiumCredits(await readFile(file, 'utf8')), { headers })
    } catch (error) {
      console.warn('[zen] chromium credits:', error)
    }
  }
  return new Response(chromiumLicencesFallbackHtml(electronVersion), { headers })
}

/** The responder for this process's binary and Electron version. */
export function chromiumLicencesResponder(): ChromiumLicencesResponder {
  const candidates = chromiumLicencesCandidates(process.execPath)
  const electronVersion = process.versions.electron ?? ''
  return () => chromiumLicencesResponse(candidates, electronVersion)
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CHROMIUM_LICENCES_FILE,
  chromiumLicencesCandidates,
  chromiumLicencesFallbackHtml,
  chromiumLicencesResponse,
  rewriteChromiumCredits
} from '../licences'

/*
 * Chromium's credits document on the desktop (`zen://chromium-licences`, settings-73): where
 * Electron's `LICENSES.chromium.html` lies for this binary, the rewrite that lets it stand
 * without Chrome's `chrome://` stylesheets, and the page that stands in when a build lacks it.
 */

/** The head of Electron's document as Chromium's `licenses.py` writes it, with one product. */
const CREDITS = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Credits</title>
<link rel="stylesheet" href="chrome://resources/css/text_defaults.css">
<link rel="stylesheet" href="chrome://credits/credits.css">
</head>
<body>
<label class="show show-all"><input type="checkbox" hidden></label>
<h1>Credits</h1>
<div class="product">
<span class="title">zlib</span>
<a class="homepage" href="http://zlib.net/">homepage</a>
<label class="show"><input type="checkbox" hidden></label>
<div class="license"><pre>zlib licence text</pre></div>
</div>
</body>
</html>
`

const dir = mkdtempSync(join(tmpdir(), 'zenium-credits-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('chromiumLicencesCandidates', () => {
  it('looks beside the executable, and on macOS in the directory holding the bundle too', () => {
    expect(chromiumLicencesCandidates('/opt/zenium/zenium', 'linux')).toEqual([
      `/opt/zenium/${CHROMIUM_LICENCES_FILE}`
    ])
    expect(chromiumLicencesCandidates('/w/node_modules/electron/dist/electron', 'win32')).toEqual([
      `/w/node_modules/electron/dist/${CHROMIUM_LICENCES_FILE}`
    ])
    expect(
      chromiumLicencesCandidates(
        '/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        'darwin'
      )
    ).toEqual([
      `/w/node_modules/electron/dist/Electron.app/Contents/MacOS/${CHROMIUM_LICENCES_FILE}`,
      `/w/node_modules/electron/dist/${CHROMIUM_LICENCES_FILE}`
    ])
  })
})

describe('rewriteChromiumCredits', () => {
  it('drops the chrome:// stylesheets and folds the licences behind their labels with its own', () => {
    const html = rewriteChromiumCredits(CREDITS)
    expect(html).not.toContain('chrome://')
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('</head>'))
    expect(html).toContain('.product .license {\n  display: none;')
    expect(html).toContain('.product:has(> .show input:checked) .license')
    expect(html).toContain('body:has(> .show-all input:checked) .license { display: block; }')
    expect(html).toContain("label.show::before { content: 'Show licence'; }")
    expect(html).toContain('<pre>zlib licence text</pre>')
    expect(html).toContain('<title>Credits</title>')
  })

  it('puts the stylesheet first when the document has no head', () => {
    expect(rewriteChromiumCredits('<p>bare</p>').startsWith('<style>')).toBe(true)
  })
})

describe('chromiumLicencesFallbackHtml', () => {
  it('says the build lacks the document and where Electron publishes it', () => {
    const html = chromiumLicencesFallbackHtml('44.4.5')
    expect(html).toContain('Electron 44.4.5')
    expect(html).toContain('https://github.com/electron/electron/releases/tag/v44.4.5')
    expect(html).toContain(`<code>${CHROMIUM_LICENCES_FILE}</code>`)
    expect(chromiumLicencesFallbackHtml('1<script>')).not.toContain('<script>')
  })
})

describe('chromiumLicencesResponse', () => {
  it('serves the first candidate that exists, rewritten', async () => {
    const file = join(dir, CHROMIUM_LICENCES_FILE)
    writeFileSync(file, CREDITS)
    const response = await chromiumLicencesResponse([join(dir, 'missing.html'), file], '44.4.5')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('zlib licence text')
    expect(html).not.toContain('chrome://')
  })

  it('falls back to the page that says so when no candidate exists', async () => {
    const response = await chromiumLicencesResponse([join(dir, 'nowhere.html')], '44.4.5')
    const html = await response.text()
    expect(html).toContain('does not carry the credits document')
    expect(html).toContain('Electron 44.4.5')
  })
})

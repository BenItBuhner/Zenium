// The site the boot family of scenarios loads – the tab `boot` opens through the URL bar and
// `restore` and `crash-restore` bring back, the walkthrough's two tabs, the page its find, zoom
// and context-menu steps act on, the URL its second instance hands over: one loopback HTTP
// server with three static pages, so the smoke needs nothing from the internet.
//
// The pages used to be example.com, example.net and example.org. On 2026-09-22 main's macos-x64
// smoke failed `boot` twice on `ERR_INTERNET_DISCONNECTED` – the runner had no internet, which
// no retry can answer (navigation.mjs's one retry is for a single connection reset) – after an
// earlier `ERR_CONNECTION_RESET` on the same step. The flake was the dependency, so it went.
//
// Bound on 127.0.0.1 with an ephemeral port and nothing else: every runner (Linux under Xvfb,
// Windows x64 and ARM64, macOS ARM64 and Intel) has the IPv4 loopback, no host name has to
// resolve, no IPv6 is assumed. The harness starts the server once per run, before the first
// scenario, so the URL `boot` leaves in the profile – port included – is the one `restore` and
// `crash-restore` load again.
import http from 'node:http'

/**
 * The three pages by the part they play. The titles share no substring, so a sidebar row filter
 * on one names that page alone, and none says "Zenium": the window-title check (`<tab title> -
 * Zenium`) has to find the product name in the app's suffix, not in the page's own title.
 */
export const BOOT_PAGES = {
  /** The tab `boot` opens and the later scenarios restore; the walkthrough's active tab. */
  first: { path: '/first.html', title: 'Smoke fixture: first page' },
  /** The walkthrough's other tab, opened before the first page so that one stays active. */
  second: { path: '/second.html', title: 'Smoke fixture: second page' },
  /** The URL the walkthrough's second instance (`zenium <url>`) hands over. */
  handoff: { path: '/handoff.html', title: 'Smoke fixture: handed-over page' }
}

/** The word the walkthrough's find step types, and how often the first page's body has it. */
export const FIND_WORD = 'loopback'
export const FIND_MATCHES = 2

/**
 * The address that never answers: the server takes the request and writes nothing, so a
 * navigation to it hangs before its document commits – the shape of load Escape, the Stop button
 * and ⌘. have to end (BUG-009). It is a path, not a page: nothing is ever served under it, and
 * `close()` ends the held connections.
 */
export const HANGING_PATH = '/never-answers.html'

/**
 * The download the `downloads` scenario takes (BUG-030 / downloads-01): a file the server sends
 * with `Content-Disposition: attachment` in a type no page renders, so a navigation to it is a
 * download and nothing commits in the tab; and the page with a link to it, for the Alt+click
 * that downloads a link as Chrome's does. Neither is one of {@link BOOT_PAGES}: the boot family
 * never sees them, and the fixture's page table stays the three pages.
 */
export const DOWNLOAD_FIXTURE = {
  page: { path: '/download.html', title: 'Smoke fixture: download page', linkId: 'attachment' },
  file: { path: '/files/smoke-attachment.bin', filename: 'smoke-attachment.bin', size: 4096 }
}

/**
 * The article the `features` scenario reads (parity row ci-04's reader leg): a page Readability's
 * `isProbablyReaderable` says yes to – it scores the `<p>` elements of 140 characters and more by
 * the square root of what they carry past that, and asks for a score over 20 – so the reader chip
 * comes up on it and Reader View has an article to extract. Not one of {@link BOOT_PAGES}: the
 * boot family never opens it, and the fixture's page table stays the three pages.
 */
export const ARTICLE_FIXTURE = {
  path: '/article.html',
  title: 'Smoke fixture: an article for Reader View',
  /** The words the reader's document has to carry, from the article's first paragraph. */
  marker: 'loopback interface of the runner'
}

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="margin:0;font:18px/1.5 sans-serif;color:#222">` +
  `<main style="margin:48px 40px;max-width:720px">${body}</main></body></html>`

const heading = (text) => `<h1 style="margin:0 0 16px;font-size:44px;font-weight:600">${text}</h1>`

/**
 * The documents for a server at `origin`, by path. The first page's body carries
 * {@link FIND_WORD} exactly {@link FIND_MATCHES} times (the count the find step expects) and
 * enough text for the zoom steps to show their scale; the others say which page they are.
 */
export function bootPages(origin) {
  return {
    [BOOT_PAGES.first.path]: html(
      BOOT_PAGES.first.title,
      heading('First page') +
        `<p>The desktop boot smoke's first page, served by the harness at <code>${origin}</code> on the ${FIND_WORD} interface. Nothing on it comes from the internet.</p>` +
        `<p>Find in page looks for the word ${FIND_WORD}; the zoom steps scale this text.</p>`
    ),
    [BOOT_PAGES.second.path]: html(
      BOOT_PAGES.second.title,
      heading('Second page') +
        `<p>The walkthrough's other tab, served by the harness at <code>${origin}</code>.</p>`
    ),
    [BOOT_PAGES.handoff.path]: html(
      BOOT_PAGES.handoff.title,
      heading('Handed-over page') +
        `<p>Opened by a second instance of the app handing its URL to the running one; served by the harness at <code>${origin}</code>.</p>`
    )
  }
}

/**
 * The download page ({@link DOWNLOAD_FIXTURE.page}): one link to the attachment, large enough
 * for a pointer driven from outside to hit its middle. `address` is the server's, for the note.
 */
export function downloadPage(address) {
  const { page, file } = DOWNLOAD_FIXTURE
  return html(
    page.title,
    heading('Download page') +
      `<p style="font-size:28px;line-height:2"><a id="${page.linkId}" href="${file.path}">Download ${file.filename}</a></p>` +
      `<p>The link is a file the harness's server at 127.0.0.1:${address?.port ?? '?'} sends as an attachment: a click downloads it, and so does an Alt+click.</p>`
  )
}

/**
 * The article page ({@link ARTICLE_FIXTURE}): a heading, a byline and five paragraphs of plain
 * prose, each well past Readability's 140-character floor, inside an `<article>`. The first
 * paragraph carries the marker the reader leg looks for in the extracted document.
 */
export function articlePage(origin) {
  const paragraphs = [
    `This page is the harness's own article, served at <code>${origin}</code> on the ${ARTICLE_FIXTURE.marker}, so that the desktop smoke can enter Reader View on a document it controls end to end. Nothing on it is fetched from the internet, and its words change only when the fixture does.`,
    'Reader View strips a page down to the article it carries: the heading, the byline when there is one, and the body text, set in the reading preferences the user keeps. For that the browser first asks whether the page looks like an article at all, and this page is written to be an easy yes.',
    "The check behind that question is Readability's isProbablyReaderable: it walks the paragraphs, keeps those with at least one hundred and forty characters of text, and adds the square root of the surplus of each to a running score. A page passes once the score is over twenty.",
    'Five paragraphs of this length clear the bar comfortably, which is the point: the leg is about the toggle and its accessible state, not about the edge of the detector. A shorter page would put the detector on trial instead, and a failure there would say nothing about the chip.',
    'When the leg is done it leaves Reader View again, and the tab shows this page as it was, so the bookmarks leg that follows has an ordinary web page to star, to open from the bar and to remove.'
  ]
  return html(
    ARTICLE_FIXTURE.title,
    `<article>${heading('An article for Reader View')}` +
      `<p style="color:#666;margin:0 0 20px">By the desktop smoke</p>` +
      paragraphs.map((p) => `<p>${p}</p>`).join('') +
      `</article>`
  )
}

/** {@link BOOT_PAGES} with each page's URL on `origin`. */
export function bootPageUrls(origin) {
  return Object.fromEntries(
    Object.entries(BOOT_PAGES).map(([role, page]) => [
      role,
      { ...page, url: `${origin}${page.path}` }
    ])
  )
}

/**
 * Whether `url` is a web page (`http://` or `https://`) as opposed to the app's own documents
 * (`zen://`, `file://`, `about:blank`): what the crash-restore scenario counts as loaded pages.
 */
export function isWebPage(url) {
  return /^https?:\/\//i.test(String(url ?? ''))
}

/**
 * Starts the server on 127.0.0.1 (an ephemeral port) and names the pages: `first`, `second`
 * and `handoff`, each `{ path, title, url }`, plus `origin` and `port`. `requests` lists what
 * was fetched (path, Host header, Sec-Fetch-Dest) so a run can show the pages came from here;
 * `hanging` is the address that never answers ({@link HANGING_PATH}: `{ path, url }`) with
 * `held()` the number of its requests the server is sitting on; `download` is the attachment and
 * the page linking to it ({@link DOWNLOAD_FIXTURE}, each with its `url`); `article` the page
 * Reader View reads ({@link ARTICLE_FIXTURE}, with its `url`); `close()` stops the server, the
 * held connections included.
 */
export function startBootFixture() {
  const requests = []
  const held = []
  let pages = null
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture')
    requests.push({ path: pathname, host: req.headers.host, dest: req.headers['sec-fetch-dest'] })
    if (pathname === HANGING_PATH) {
      // Accepted and never answered: no status line, no headers, no bytes, until the server
      // closes or the client gives up (which a stopped navigation does: the socket goes).
      held.push(res)
      res.once('close', () => {
        const at = held.indexOf(res)
        if (at >= 0) held.splice(at, 1)
      })
      return
    }
    res.setHeader('cache-control', 'no-store')
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname === DOWNLOAD_FIXTURE.file.path) {
      // A download and nothing else: an attachment in a type no page renders.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${DOWNLOAD_FIXTURE.file.filename}"`,
        'content-length': String(DOWNLOAD_FIXTURE.file.size)
      })
      res.end(Buffer.alloc(DOWNLOAD_FIXTURE.file.size, 0x5a))
      return
    }
    if (pathname === DOWNLOAD_FIXTURE.page.path) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(downloadPage(server.address()))
      return
    }
    if (pathname === ARTICLE_FIXTURE.path) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(articlePage(`http://${req.headers.host ?? '127.0.0.1'}`))
      return
    }
    const page = pages && pages[pathname]
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const origin = `http://127.0.0.1:${port}`
      pages = bootPages(origin)
      resolve({
        port,
        origin,
        ...bootPageUrls(origin),
        hanging: { path: HANGING_PATH, url: `${origin}${HANGING_PATH}` },
        download: {
          page: { ...DOWNLOAD_FIXTURE.page, url: `${origin}${DOWNLOAD_FIXTURE.page.path}` },
          file: { ...DOWNLOAD_FIXTURE.file, url: `${origin}${DOWNLOAD_FIXTURE.file.path}` }
        },
        article: { ...ARTICLE_FIXTURE, url: `${origin}${ARTICLE_FIXTURE.path}` },
        held: () => held.length,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            held.length = 0
            server.close(() => done())
          })
      })
    })
  })
}

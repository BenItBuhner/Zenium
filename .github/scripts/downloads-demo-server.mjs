// Range-capable test server behind the DownloadsDemo instrumentation test (android/app/src/androidTest).
// Run it on the machine that hosts the emulator (`node .github/scripts/downloads-demo-server.mjs 18923`);
// the emulator reaches it at 10.0.2.2:18923. The dispatch-only workflow
// .github/workflows/android-downloads-demo.yml starts it from `setup-script` before the emulator
// boots and runs DownloadsDemo against it. slow.bin is throttled so Pause and Resume have something
// to hold; flaky.bin drops the downloader's first attempt at 1 MiB so only a Range resume can
// finish it; dead.bin dies on the downloader's first attempt and its three automatic resumes, so
// the failure reaches the user as `network-failed`, and is served whole from then on (Resume or
// Retry); the data: and blob: links are named from their anchors.
//
// A tapped link is first a WebView navigation: the WebView reads the response headers, hands the
// transfer to the downloader and drops its own request, and the downloader opens the file's
// second full response. That first full response is always served whole – cut short, it can end
// as the WebView's own error page over the test page when the cut wins the race against the
// hand-off (seen on the software-rendered emulator) – so only full responses are counted, and the
// workflow's Range warm-up with curl does not shift the count. Not a fit for a desktop host,
// where the navigation's response is the download.
import http from 'node:http'
// Every payload byte comes from this formula; DownloadsDemo.expectedByte is the same one.
const byteAt = (i) => (i * 31 + (i >> 8)) & 0xff
const SLOW = 3 * 1024 * 1024
const FLAKY = 2 * 1024 * 1024
const CUT_AT = 1024 * 1024
const DEAD = 1024 * 1024
const DEAD_CUT_AT = 256 * 1024
// The downloader's first attempt and its MAX_AUTO_RESUMES automatic resumes (3 since #291, the
// core's AUTO_RESUME_DELAYS_MS steps of 2, 4 and 8 s; DownloadLogic.kt): the fourth failure in a
// row leaves the row interrupted for good, and the user's Resume is the response served whole.
// One more death here and that Resume dies too – the row goes back to counting down and the
// driver's press of Resume sees no answer (the nightly of #332).
const DEAD_FAILURES = 4
let deadFailures = 0
// 3 MiB at this rate runs about forty-eight seconds: the panel opens on the transfer, the
// recorder catches it moving, and Pause has bytes to hold even though every engine call the
// driver makes waits on the emulator's busy chrome WebView while the row moves (twenty seconds
// from the tap to the pause have been measured).
const SLOW_RATE = 64 * 1024
// Full (non-Range) responses served so far, by file name.
const fullResponses = new Map()
const nthFull = (req, name) => {
  if (req.headers.range) return 0
  const n = (fullResponses.get(name) || 0) + 1
  fullResponses.set(name, n)
  return n
}
const dataText = Buffer.from('Hello from a Zenium data: link\n').toString('base64')
const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zenium download test</title>
<style>
  body { font: 18px system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f6f8; color: #111 }
  h1 { font-size: 22px; margin: 0 0 8px }
  p { margin: 0 0 20px; color: #555; font-size: 15px }
  a { display: block; margin: 14px 0; padding: 20px; border-radius: 16px; background: #4f6bed; color: #fff; text-decoration: none; font-weight: 600 }
</style>
<h1>Zenium download test</h1>
<p>Files served from the runner. slow.bin is throttled, flaky.bin loses its connection once, dead.bin ${DEAD_FAILURES} times.</p>
<a href="/slow.bin">Download slow.bin</a>
<a href="/flaky.bin">Download flaky.bin</a>
<a href="/dead.bin">Download dead.bin</a>
<a href="data:text/plain;base64,${dataText}" download="hello-data.txt">Download hello-data.txt</a>
<a id="blob" href="#" download="hello-blob.txt">Download hello-blob.txt</a>
<script>
  document.getElementById('blob').href =
    URL.createObjectURL(new Blob(['Hello from a Zenium blob: link\\n'], { type: 'text/plain' }))
</script>`

// A Range-capable file of `size` bytes with a strong ETag. `rate` (bytes/s) throttles it;
// `cutAt` drops every full (non-Range) response at that offset, so a resume with Range is the
// only way to finish the file; `cutRangeAt` (an absolute offset) drops Range responses too.
function serve(
  req,
  res,
  name,
  size,
  { rate = 0, cutAt = Infinity, cutRangeAt = Infinity, disposition = false }
) {
  let start = 0
  let end = size - 1
  let status = 200
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    start = Number(range[1])
    if (range[2]) end = Math.min(Number(range[2]), size - 1)
    if (start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    status = 206
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: `"zenium-${name}-${size}"`,
    'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store'
  }
  if (disposition) headers['Content-Disposition'] = `attachment; filename="${name}"`
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(status, headers)
  const cut = range ? cutRangeAt : cutAt
  // A throttled file goes out in four chunks a second, so its row moves rather than steps.
  const chunk = rate ? Math.max(4096, Math.min(64 * 1024, Math.round(rate / 4))) : 64 * 1024
  let pos = start
  const tick = () => {
    if (res.destroyed) return
    if (pos > end) return res.end()
    if (pos >= cut) {
      console.log(`${name}: cutting the connection at ${pos}`)
      return res.destroy()
    }
    const n = Math.min(chunk, end - pos + 1, cut - pos)
    const buf = Buffer.allocUnsafe(n)
    for (let i = 0; i < n; i++) buf[i] = byteAt(pos + i)
    pos += n
    const delay = rate ? Math.round((n / rate) * 1000) : 0
    if (res.write(buf)) setTimeout(tick, delay)
    else res.once('drain', () => setTimeout(tick, delay))
  }
  tick()
}

http
  .createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    console.log(
      `${req.method} ${path} range=${req.headers.range || '-'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`
    )
    if (path === '/page.html' || path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      return res.end(page)
    }
    if (path === '/slow.bin')
      return serve(req, res, 'slow.bin', SLOW, { rate: SLOW_RATE, disposition: true })
    if (path === '/flaky.bin') {
      // The second full response is the downloader's first attempt: it dies at 1 MiB.
      const cutAt = nthFull(req, 'flaky.bin') === 2 ? CUT_AT : Infinity
      return serve(req, res, 'flaky.bin', FLAKY, { cutAt })
    }
    if (path === '/dead.bin') {
      // From the downloader's first attempt (the second full response) on, four responses die:
      // full ones after 256 KiB, Range resumes before their first byte (a resume that moves
      // resets the downloader's retry budget). Everything after that is whole.
      const navigation = nthFull(req, 'dead.bin') === 1
      if (!navigation && deadFailures < DEAD_FAILURES) {
        deadFailures++
        console.log(`dead.bin: response ${deadFailures} of ${DEAD_FAILURES} will die`)
        return serve(req, res, 'dead.bin', DEAD, {
          cutAt: DEAD_CUT_AT,
          cutRangeAt: 0,
          disposition: true
        })
      }
      return serve(req, res, 'dead.bin', DEAD, { disposition: true })
    }
    res.writeHead(404)
    res.end()
  })
  .listen(Number(process.argv[2] || 18923), '0.0.0.0', () => console.log('download test server up'))

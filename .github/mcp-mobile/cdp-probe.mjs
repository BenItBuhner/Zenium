// TEMPORARY – informational probe: does the system WebView's DevTools socket honour
// Page.captureScreenshot { captureBeyondViewport } for a clip taller than the viewport? Saves the
// result next to the other artifacts; nothing in the app depends on it.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [out, appId] = process.argv.slice(2)
const pid = execSync(`adb shell pidof ${appId}`).toString().trim().split(/\s+/)[0]
if (!pid) throw new Error('app not running')
execSync(`adb forward tcp:9222 localabstract:webview_devtools_remote_${pid}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(500)
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
console.log(
  'targets:',
  JSON.stringify(
    targets.map((t) => ({ type: t.type, url: t.url, description: t.description })),
    null,
    1
  )
)
const page = targets.find(
  (t) => t.type === 'page' && t.url && !t.url.startsWith('https://appassets.androidplatform.net')
)
if (!page) {
  console.log('no tab target yet (only the chrome WebView) – skipping')
  process.exit(0)
}
const ws = new WebSocket(page.webSocketDebuggerUrl.replace('ws:///', 'ws://127.0.0.1:9222/'))
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
console.log(
  'navigate:',
  JSON.stringify(await send('Page.navigate', { url: 'http://10.0.2.2:8765/long.html' }))
)
await wait(6000)
const metrics = await send('Page.getLayoutMetrics')
console.log('layout metrics:', JSON.stringify(metrics.result))
const content = metrics.result?.cssContentSize ?? metrics.result?.contentSize
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: 0,
    y: 0,
    width: Math.round(content.width),
    height: Math.min(Math.round(content.height), 8000),
    scale: 1
  },
  captureBeyondViewport: true,
  fromSurface: true
})
if (shot.error) {
  console.log('captureBeyondViewport error:', JSON.stringify(shot.error))
} else {
  const buf = Buffer.from(shot.result.data, 'base64')
  writeFileSync(`${out}/cdp-capture-beyond-viewport.png`, buf)
  // PNG IHDR: width at byte 16, height at byte 20.
  console.log(
    'captureBeyondViewport image:',
    buf.readUInt32BE(16),
    'x',
    buf.readUInt32BE(20),
    'px,',
    buf.length,
    'bytes'
  )
}
const plain = await send('Page.captureScreenshot', { format: 'png' })
if (!plain.error) {
  const buf = Buffer.from(plain.result.data, 'base64')
  writeFileSync(`${out}/cdp-capture-viewport.png`, buf)
  console.log('viewport image:', buf.readUInt32BE(16), 'x', buf.readUInt32BE(20), 'px')
}
ws.close()
process.exit(0)

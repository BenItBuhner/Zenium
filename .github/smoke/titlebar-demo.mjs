// A screen recording of the Windows title bar (PR #824), paced for a person to watch: the
// window at rest with no bar, the cursor gliding to the top edge so Windows' buttons slide in,
// hovering each one, leaving, Maximize and Restore, dragging the window by its top edge, and the
// buttons standing in the toolbar's corner when the toolbar row shows. ffmpeg records the
// desktop with the real cursor; steps.json says when each step started, for captions.
//
// usage: node titlebar-demo.mjs --exe <zenium.exe> --out <dir> --ffmpeg <ffmpeg.exe>
import { _electron as electron } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
)
const outDir = path.resolve(args.out ?? 'titlebar-demo')
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...m) => console.log('[demo]', ...m)

function input(action, params = {}) {
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'win-input.ps1')]
  argv.push('-Action', action)
  for (const [k, v] of Object.entries(params)) argv.push(`-${k}`, String(v))
  execFileSync('powershell.exe', argv, { stdio: 'inherit' })
}

async function waitFor(fn, timeoutMs = 4000, everyMs = 100) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(everyMs)
  }
  return last
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-demo-'))
fs.mkdirSync(path.join(userData, 'zen'), { recursive: true })
fs.writeFileSync(
  path.join(userData, 'zen', 'state.json'),
  JSON.stringify({
    version: 2,
    settings: {
      onboardingDone: true,
      updates: { autoCheck: false, autoDownload: false, channel: 'stable' }
    }
  })
)

const app = await electron.launch({ executablePath: args.exe, args: [`--user-data-dir=${userData}`] })
const win = (fn, arg) =>
  app.evaluate(
    ({ BrowserWindow }, [src, a]) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.getParentWindow() && x.isVisible())
      if (!w) return null
      return new Function('w', 'a', 'BrowserWindow', src)(w, a, BrowserWindow)
    },
    [fn, arg]
  )
const info = () =>
  win(`return { bounds: w.getBounds(), content: w.getContentBounds(), maximized: w.isMaximized() }`).catch(
    () => null
  )
const page = await waitFor(
  () => app.windows().find((p) => /index\.html(\?|$)/.test(p.url()) && !p.url().includes('surface=')),
  60000,
  250
)
await page.waitForSelector('[data-testid="chrome-root"]', { timeout: 60000 })
const display = await app.evaluate(({ screen }) => {
  const d = screen.getPrimaryDisplay()
  return { scaleFactor: d.scaleFactor, bounds: d.bounds, workArea: d.workArea }
})
const scale = display.scaleFactor
const px = (v) => Math.round(v * scale)
log('display', JSON.stringify(display))

// A couple of real pages so the window looks lived in.
for (const url of ['https://en.wikipedia.org/wiki/Web_browser', 'https://example.com']) {
  await page.evaluate((u) => window.zen.invoke('tab.create', { url: u }), url).catch((e) => log(e))
  await sleep(500)
}
const wa = display.workArea
const W = Math.min(980, wa.width - 80)
const H = Math.min(660, wa.height - 80)
const home = { x: wa.x + Math.round((wa.width - W) / 2), y: wa.y + 40, width: W, height: H }
const place = () => win(`w.unmaximize(); w.setBounds(a); w.focus(); return true`, home)
await place()
await sleep(4000)

const panel = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="caption-buttons"]')
    if (!el) return null
    const btn = (label) => {
      const b = el.querySelector(`[aria-label="${label}"]`)
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return {
      minimize: btn('Minimize'),
      maximize: btn('Maximize'),
      restore: btn('Restore'),
      close: btn('Close')
    }
  })
const at = (c, p) => ({ X: px(c.x + p.x), Y: px(c.y + p.y) })
const middle = (i) => ({ X: px(i.content.x + i.content.width * 0.6), Y: px(i.content.y + i.content.height * 0.55) })

// Recording starts here.
const video = path.join(outDir, 'titlebar.mp4')
const ff = spawn(
  args.ffmpeg ?? 'ffmpeg',
  ['-y', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', video],
  { stdio: ['pipe', 'inherit', 'inherit'] }
)
const t0 = Date.now()
await sleep(1500)
const steps = []
const mark = (caption) => {
  steps.push({ at: (Date.now() - t0) / 1000, caption })
  log(caption)
}

try {
  let i = await info()
  input('click', middle(i))
  await sleep(300)
  mark('At rest: no title bar, no buttons. The page uses the whole window.')
  await sleep(3500)

  mark('Move the mouse to the top edge: the normal Windows buttons slide in')
  input('glide', { X: px(i.content.x + i.content.width - 200), Y: px(i.content.y + 1) })
  await waitFor(async () => (await panel())?.close, 4000)
  await sleep(1500)
  let p = await panel()
  mark('They work like normal Windows buttons, with the red Close hover')
  for (const b of [p.minimize, p.maximize, p.close]) {
    input('glide', at(i.content, b))
    await sleep(900)
  }
  await sleep(600)

  mark('Move away and they slide back out of the way')
  input('glide', middle(i))
  await sleep(2500)

  mark('Maximize from the top edge...')
  input('glide', { X: px(i.content.x + i.content.width - 200), Y: px(i.content.y + 1) })
  await waitFor(async () => (await panel())?.maximize, 4000)
  await sleep(700)
  p = await panel()
  input('glide', at(i.content, p.maximize))
  await sleep(500)
  input('click', at(i.content, p.maximize))
  await waitFor(async () => (await info())?.maximized, 4000)
  await sleep(1500)
  i = await info()
  input('glide', middle(i))
  await sleep(1200)

  mark('...and Restore it the same way')
  input('glide', { X: px(i.content.x + i.content.width - 200), Y: px(i.content.y + 1) })
  await waitFor(async () => (await panel())?.restore, 4000)
  await sleep(800)
  p = await panel()
  input('glide', at(i.content, p.restore))
  await sleep(500)
  input('click', at(i.content, p.restore))
  await waitFor(async () => (await info())?.maximized === false, 4000)
  await sleep(1500)

  mark('Drag the window by its top edge, like a normal title bar')
  await place()
  await sleep(600)
  i = await info()
  const gx = px(i.content.x + i.content.width * 0.55)
  const gy = px(i.content.y + 5)
  input('glide', { X: gx, Y: gy + 40 })
  input('drag', { X: gx, Y: gy, X2: gx - px(120), Y2: gy + px(60) })
  await sleep(1200)
  input('drag', { X: gx - px(108), Y: gy + px(56), X2: gx - px(8), Y2: gy + px(6) })
  await sleep(1500)

  mark('With the toolbar row turned on, the buttons sit in its corner instead')
  await place()
  await page.evaluate(() => window.zen.invoke('settings.update', { toolbarLayout: 'multiple' }))
  await sleep(1200)
  i = await info()
  p = await panel()
  input('glide', middle(i))
  if (p?.close) {
    input('glide', at(i.content, p.minimize))
    await sleep(700)
    input('glide', at(i.content, p.close))
  }
  await sleep(2500)
  await page.evaluate(() => window.zen.invoke('settings.update', { toolbarLayout: 'single' }))
  await sleep(1500)
  mark('end')
} catch (e) {
  log('FAILED', e?.stack ?? e)
  process.exitCode = 1
} finally {
  ff.stdin.write('q')
  await new Promise((r) => ff.on('exit', r))
  fs.writeFileSync(path.join(outDir, 'steps.json'), JSON.stringify({ display, steps }, null, 2))
  await app.close().catch(() => null)
}

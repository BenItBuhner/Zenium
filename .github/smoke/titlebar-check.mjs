// The Windows title bar check (PR #824): boots the unpacked build on a Windows runner and drives
// the real OS cursor and mouse buttons (win-input.ps1, user32) – the main process polls the real
// cursor for the top-edge reveal, and Windows' own hit testing decides what a drag on the top
// gutter does, so neither can be faked from inside the page. Each step screenshots the desktop.
//
//   rest       no Window Controls Overlay, no window buttons drawn, nothing kept across the top
//   reveal     the cursor on the top edge slides the minimise / maximise / close panel down
//   leave      the cursor going away puts it back
//   maximize   the panel's Maximize maximises; revealed again at the screen's top, Restore restores
//   drag       pressing the top gutter and moving drags the window
//   snap       Win+Left snaps the window to the left half
//   drag-top   dragging the gutter to the screen's top edge (Windows' snap / maximise on drop)
//   close      the panel's Close closes the window
//
// usage: node titlebar-check.mjs --exe <zenium.exe> --out <dir>
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
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
const outDir = path.resolve(args.out ?? 'titlebar-out')
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const log = (...m) => console.log('[titlebar]', ...m)

function input(action, params = {}) {
  const argv = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(here, 'win-input.ps1')
  ]
  argv.push('-Action', action)
  for (const [k, v] of Object.entries(params)) argv.push(`-${k}`, String(v))
  execFileSync('powershell.exe', argv, { stdio: 'inherit' })
}

let scale = 1
const px = (v) => Math.round(v * scale)
function shot(name, crop) {
  const file = path.join(outDir, `${name}.png`)
  input(
    'shot',
    crop
      ? { X: px(crop.x), Y: px(crop.y), W: px(crop.width), H: px(crop.height), Path: file }
      : { Path: file }
  )
  return file
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

async function step(name, required, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, required, ms: Date.now() - t0, detail })
    log('PASS', name, JSON.stringify(detail ?? {}))
  } catch (e) {
    results.push({ name, ok: false, required, ms: Date.now() - t0, error: String(e?.message ?? e) })
    log('FAIL', name, e?.message ?? e)
    try {
      shot(`fail-${name}`)
    } catch {
      // The step's own error is the one worth reporting.
    }
  }
}

// A fresh profile past onboarding, with the default layout (Only sidebar).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-titlebar-'))
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

const app = await electron.launch({
  executablePath: args.exe,
  args: [`--user-data-dir=${userData}`],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  colorScheme: null,
  timeout: 90000
})
const exited = new Promise((r) => app.process().on('exit', () => r(true)))

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
  win(`return { bounds: w.getBounds(), content: w.getContentBounds(), maximized: w.isMaximized(),
    focused: w.isFocused(), count: BrowserWindow.getAllWindows().length }`).catch(() => null)

async function chromePage() {
  return waitFor(
    () =>
      app.windows().find((p) => /index\.html(\?|$)/.test(p.url()) && !p.url().includes('surface=')),
    60000,
    250
  )
}

const page = await chromePage()
if (!page) throw new Error('no chrome page')
await page.waitForSelector('[data-testid="chrome-root"]', { timeout: 60000 })
const display = await app.evaluate(({ screen }) => {
  const d = screen.getPrimaryDisplay()
  return { scaleFactor: d.scaleFactor, bounds: d.bounds, workArea: d.workArea }
})
scale = display.scaleFactor
log('display', JSON.stringify(display))

// A known place, away from the screen's edges, with the window in front.
await win(
  `w.unmaximize(); w.setBounds({ x: 40, y: 40, width: 900, height: 600 }); w.focus(); return true`
)
await sleep(1500)
const panel = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="caption-reveal"] .zen-panel')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const btn = (label) => {
      const b = el.querySelector(`[aria-label="${label}"]`)
      if (!b) return null
      const br = b.getBoundingClientRect()
      return { x: br.x + br.width / 2, y: br.y + br.height / 2 }
    }
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      minimize: btn('Minimize'),
      maximize: btn('Maximize'),
      restore: btn('Restore'),
      close: btn('Close')
    }
  })
const toScreen = (content, p) => ({ X: px(content.x + p.x), Y: px(content.y + p.y) })
const centre = (i) => ({
  X: px(i.content.x + i.content.width / 2),
  Y: px(i.content.y + i.content.height / 2)
})
const topRightCrop = (i) => ({
  x: i.content.x + i.content.width - 420,
  y: i.content.y,
  width: 420,
  height: 140
})

/** Reveal the panel with the real cursor on the top edge, over the trailing half. */
async function reveal() {
  const i = await info()
  input('move', { X: px(i.content.x + i.content.width - 160), Y: px(i.content.y + 1) })
  const p = await waitFor(async () => {
    const got = await panel()
    return got?.rect.height > 0 && got.rect.y >= 0 ? got : null
  }, 4000)
  await sleep(500) // the slide's spring comes to rest
  return { i, p: p ? await panel() : null }
}

await step('rest', true, async () => {
  const i = await info()
  input('click', centre(i)) // a real click puts the window in front, as a person's would
  input('move', centre(i))
  await sleep(1200)
  const dom = await page.evaluate(() => ({
    overlayVisible: Boolean(navigator.windowControlsOverlay?.visible),
    captionOverlayAttr: document
      .querySelector('[data-testid="chrome-root"]')
      ?.getAttribute('data-caption-overlay'),
    windowButtons: document.querySelectorAll(
      '[aria-label="Minimize"],[aria-label="Maximize"],[aria-label="Close"]'
    ).length,
    revealMounted: Boolean(document.querySelector('[data-testid="caption-reveal"]')),
    sidebarTop:
      document.querySelector('aside, [data-testid="sidebar"]')?.getBoundingClientRect().top ?? null,
    layout: document.querySelector('[data-testid="chrome-root"]')?.getAttribute('data-layout')
  }))
  shot('01-rest')
  shot('01-rest-top-right', topRightCrop(i))
  if (dom.overlayVisible) throw new Error('the Window Controls Overlay is still on')
  if (dom.windowButtons !== 0)
    throw new Error(`${dom.windowButtons} window buttons showing at rest`)
  if (!dom.revealMounted) throw new Error('the caption reveal is not mounted')
  return { ...dom, window: i }
})

await step('reveal', true, async () => {
  const { i, p } = await reveal()
  shot('02-top-edge')
  shot('02-top-edge-top-right', topRightCrop(i))
  if (!p?.maximize || !p.close || !p.minimize)
    throw new Error(`no panel with three buttons: ${JSON.stringify(p)}`)
  return p
})

await step('leave', true, async () => {
  const i = await info()
  input('move', centre(i))
  const gone = await waitFor(async () => !(await panel()), 4000)
  shot('03-after-leave-top-right', topRightCrop(i))
  if (!gone) throw new Error('the panel stayed after the cursor left')
  return { gone }
})

await step('maximize', true, async () => {
  const { i, p } = await reveal()
  if (!p?.maximize) throw new Error('no Maximize button')
  input('click', toScreen(i.content, p.maximize))
  const max = await waitFor(async () => (await info())?.maximized, 4000)
  await sleep(800)
  shot('04-maximized')
  if (!max) throw new Error('the window did not maximise')
  const again = await reveal()
  shot('05-maximized-top-edge')
  if (!again.p?.restore)
    throw new Error(`no Restore button on the maximised window: ${JSON.stringify(again.p)}`)
  input('click', toScreen(again.i.content, again.p.restore))
  const restored = await waitFor(async () => (await info())?.maximized === false, 4000)
  if (!restored) throw new Error('Restore did not restore')
  return { maximizedContent: again.i.content }
})

await step('drag', true, async () => {
  await win(`w.setBounds({ x: 40, y: 40, width: 900, height: 600 }); return true`)
  await sleep(600)
  const i = await info()
  const pad = await page.evaluate(
    () =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zen-padding')) || 8
  )
  const at = { x: i.content.width * 0.55, y: Math.max(5, pad - 2) }
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el
      ? {
          tag: el.tagName,
          cls: String(el.className).slice(0, 80),
          region: getComputedStyle(el).getPropertyValue('-webkit-app-region')
        }
      : null
  }, at)
  input('drag', {
    X: px(i.content.x + at.x),
    Y: px(i.content.y + at.y),
    X2: px(i.content.x + at.x + 150),
    Y2: px(i.content.y + at.y + 100)
  })
  await sleep(600)
  const after = await info()
  shot('06-after-drag')
  const dx = after.bounds.x - i.bounds.x
  const dy = after.bounds.y - i.bounds.y
  if (Math.abs(dx - 150) > 20 || Math.abs(dy - 100) > 20)
    throw new Error(`moved by ${dx},${dy} instead of 150,100 (pressed on ${JSON.stringify(hit)})`)
  return { dx, dy, pressedOn: hit }
})

await step('snap', true, async () => {
  await win(`w.setBounds({ x: 120, y: 100, width: 760, height: 520 }); w.focus(); return true`)
  await sleep(600)
  const i = await info()
  input('click', centre(i))
  await sleep(300)
  input('snap-left')
  const wa = display.workArea
  const snapped = await waitFor(async () => {
    const b = (await info())?.bounds
    // The left half, or the window's 640 minimum where half the screen is narrower than it.
    const half = Math.max(wa.width / 2, 640)
    return b &&
      Math.abs(b.x - wa.x) <= 12 &&
      Math.abs(b.width - half) <= 24 &&
      b.height >= wa.height - 24
      ? b
      : null
  }, 4000)
  await sleep(500)
  shot('07-snap-left')
  input('click', { X: px(wa.x + wa.width * 0.75), Y: px(wa.y + wa.height / 2) }) // dismiss Snap Assist
  if (!snapped)
    throw new Error(`Win+Left left the window at ${JSON.stringify((await info())?.bounds)}`)
  return { snapped }
})

await step('drag-top', false, async () => {
  await win(
    `w.unmaximize(); w.setBounds({ x: 120, y: 160, width: 760, height: 480 }); w.focus(); return true`
  )
  await sleep(800)
  const i = await info()
  const x = px(i.content.x + i.content.width * 0.55)
  input('drag', { X: x, Y: px(i.content.y + 6), X2: x, Y2: 0 })
  await sleep(1200)
  const after = await info()
  shot('08-drag-to-top')
  if (!after.maximized)
    throw new Error(`not maximised after the drop: ${JSON.stringify(after.bounds)}`)
  return { maximized: true }
})

await step('close', true, async () => {
  await win(
    `w.unmaximize(); w.setBounds({ x: 40, y: 40, width: 900, height: 600 }); w.focus(); return true`
  ).catch(() => null)
  await sleep(800)
  const { i, p } = await reveal()
  if (!p?.close) throw new Error('no Close button')
  shot('09-before-close-top-right', topRightCrop(i))
  input('click', toScreen(i.content, p.close))
  const closed = await Promise.race([
    exited,
    waitFor(async () => (await info()) === null, 8000).then(Boolean)
  ])
  if (!closed) throw new Error('the window is still open')
  return { closed }
})

await app.close().catch(() => null)
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ display, results }, null, 2))
const failed = results.filter((r) => !r.ok && r.required)
log(`${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

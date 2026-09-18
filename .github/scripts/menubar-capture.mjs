// Temporary: launches the unpacked macOS app, dumps Menu.getApplicationMenu() and captures the
// menu bar. Removed with its workflow (desktop-menu-bar-mac.yml) once the capture is in the
// project store.
import { _electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const exe = process.argv[2]
const out = process.argv[3] || 'menubar-out'
if (!exe)
  throw new Error('usage: node menubar-capture.mjs <Zenium.app/Contents/MacOS/Zenium> [outDir]')
fs.mkdirSync(out, { recursive: true })

// A finished-onboarding profile so the window shows the browser, not the welcome flow.
const profile = fs.mkdtempSync('/tmp/zenium-menubar-')
fs.mkdirSync(path.join(profile, 'zen'), { recursive: true })
fs.writeFileSync(
  path.join(profile, 'zen', 'state.json'),
  JSON.stringify({
    version: 2,
    spaces: [],
    tabs: [],
    essentialTabIds: [],
    activeSpaceId: '',
    containers: [],
    folders: [],
    splitGroups: [],
    settings: {
      onboardingDone: true,
      colorScheme: 'light',
      updates: { autoCheck: false, autoDownload: false },
      resources: { enabled: false }
    },
    shortcutOverrides: {},
    bookmarks: []
  })
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    return `ERR ${String(e.message).slice(0, 300)}`
  }
}
const osascript = (script) => sh('osascript', ['-e', script])

const app = await _electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${profile}`],
  timeout: 90000
})
const pid = app.process().pid
const win = await app.firstWindow()
const pageErrors = []
win.on('pageerror', (e) => pageErrors.push(e.message))
await sleep(4000)

const bar = await app.evaluate(({ Menu }) => {
  const m = Menu.getApplicationMenu()
  const walk = (menu) =>
    menu.items.map((i) => ({
      label: i.label,
      type: i.type,
      role: i.role ?? null,
      accelerator: i.accelerator ?? null,
      registerAccelerator: i.registerAccelerator,
      enabled: i.enabled,
      checked: i.type === 'checkbox' || i.type === 'radio' ? i.checked : undefined,
      submenu: i.submenu ? walk(i.submenu) : undefined
    }))
  return m ? walk(m) : null
})
fs.writeFileSync(path.join(out, 'application-menu.json'), JSON.stringify(bar, null, 2))
const fmt = (items, ind = '') =>
  items
    .map((i) => {
      if (i.type === 'separator') return `${ind}---`
      const displayOnly = i.registerAccelerator === false ? ', display only' : ''
      const flags = [
        i.enabled === false ? '(disabled)' : '',
        i.checked ? '[x]' : '',
        i.role ? `{${i.role}}` : '',
        i.accelerator ? `<${i.accelerator}${displayOnly}>` : ''
      ]
        .filter(Boolean)
        .join(' ')
      const line = `${ind}${i.label}${flags ? ` ${flags}` : ''}`
      return i.submenu ? `${line}\n${fmt(i.submenu, ind + '    ')}` : line
    })
    .join('\n')
const text = bar ? fmt(bar) : '(no application menu)'
fs.writeFileSync(path.join(out, 'application-menu.txt'), text)
console.log('## Menu.getApplicationMenu()\n' + text)

const top = bar ? bar.map((i) => i.label) : []
const expected = ['Zenium', 'File', 'Edit', 'View', 'History', 'Bookmarks', 'Window', 'Help']
const ok = JSON.stringify(top) === JSON.stringify(expected)
console.log('## top-level:', JSON.stringify(top))
console.log(
  ok ? 'PASS top-level menus' : `FAIL top-level menus, expected ${JSON.stringify(expected)}`
)

// What the OS shows: bring the app to the front, list the menu bar items through System Events,
// capture the bar, then the File and View menus dropped down (chords as macOS draws them).
await app.evaluate(({ app }) => app.focus({ steal: true }))
const proc = `(first process whose unix id is ${pid})`
osascript(`tell application "System Events" to set frontmost of ${proc} to true`)
await sleep(1500)
const osItems = osascript(
  `tell application "System Events" to get name of every menu bar item of menu bar 1 of ${proc}`
)
console.log('## System Events menu bar items:', osItems)
fs.writeFileSync(path.join(out, 'system-events-menu-bar.txt'), osItems)
console.log(sh('screencapture', ['-x', path.join(out, 'screen.png')]))
console.log(sh('screencapture', ['-x', '-R', '0,0,1440,30', path.join(out, 'menu-bar.png')]))
for (const name of ['File', 'View']) {
  osascript(
    `tell application "System Events" to tell ${proc} to click menu bar item "${name}" of menu bar 1`
  )
  await sleep(900)
  console.log(sh('screencapture', ['-x', path.join(out, `${name.toLowerCase()}-menu-open.png`)]))
  osascript('tell application "System Events" to key code 53')
  await sleep(400)
}

console.log('## page errors:', JSON.stringify(pageErrors))
await app.close().catch(() => null)
console.log(ok ? 'RESULT PASS' : 'RESULT FAIL')
process.exit(ok ? 0 : 1)

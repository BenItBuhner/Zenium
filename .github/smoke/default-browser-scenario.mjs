// The `default-browser` scenario: Make default on macOS (os-07). Its own file so the harness's
// scenario table gains one line for it (the `downloads` shape); off macOS every step is skipped
// with a note.
//
// LaunchServices keeps the default web browser and only the user can change it: the app's
// `app.setAsDefaultProtocolClient('http')` (src/main/platform/defaultBrowser.ts, macRequest) makes
// the system put "Do you want to change your default web browser to Zenium?" on screen, and
// nothing in a runner's session answers it (UI scripting through System Events needs the
// Accessibility permission a fresh runner has not granted). So the scenario asserts the app's
// side of the hand-over and records the OS's:
//
//   bundle-claims-web          the bundle's Info.plist has CFBundleURLTypes for http and https
//                              (electron-builder's `protocols`): the registration LaunchServices
//                              lists the app under – read with plutil; the OS's own file
//   handlers-before            LSHandlers from com.apple.launchservices.secure: who holds http and
//                              https before the request – recorded
//   make-default-calls-ls      `defaultBrowser.request` (the Settings row's source) calls
//                              app.setAsDefaultProtocolClient('http') – http first and alone, https
//                              only once http is held (two prompts otherwise, #defaultBrowser.ts) –
//                              and what LaunchServices returned for the call; the app's path up to
//                              the OS's dialog
//   os-dialog                  the screen as the dialog would be on it; a best-effort look at
//                              CoreServicesUIAgent's windows and a best-effort click on its "Use"
//                              button through System Events (refused without the Accessibility
//                              permission: recorded as not automatable) – the OS's half
//   handlers-after             LSHandlers again, and whether http is now held – recorded (held
//                              only when the click above went through)
import path from 'node:path'

export const DEFAULT_BROWSER_SCENARIO = 'default-browser'

/** The schemes a web browser claims (electron-builder.yml `protocols`). */
export const WEB_SCHEMES = ['http', 'https']

/** The LaunchServices preferences domain whose LSHandlers name the default handlers. */
export const LAUNCH_SERVICES_DOMAIN = 'com.apple.LaunchServices/com.apple.launchservices.secure'

/**
 * What is wrong with the bundle's URL-type claims (`Info.plist`, parsed from `plutil -convert
 * json`): CFBundleURLTypes has to list http and https among its schemes. One line per miss.
 */
export function urlTypeProblems(infoPlist) {
  if (!infoPlist || typeof infoPlist !== 'object') return ['Info.plist could not be read']
  const types = Array.isArray(infoPlist.CFBundleURLTypes) ? infoPlist.CFBundleURLTypes : []
  if (!types.length) return ['Info.plist has no CFBundleURLTypes: the bundle claims no URL scheme']
  const schemes = new Set()
  for (const t of types) {
    for (const s of t?.CFBundleURLSchemes ?? []) schemes.add(String(s).toLowerCase())
  }
  return WEB_SCHEMES.filter((s) => !schemes.has(s)).map(
    (s) =>
      `Info.plist's CFBundleURLTypes do not claim ${s} (schemes: ${[...schemes].join(', ') || 'none'})`
  )
}

/**
 * The LSHandlers entries out of the LaunchServices preferences, from either the JSON `plutil
 * -convert json` writes or the XML `defaults export` writes (plutil refuses plists with values
 * it cannot put in JSON, so the XML is the fallback). Each entry: its string-valued keys only.
 * Unreadable text gives an empty list.
 */
export function parseLsHandlers(text) {
  const src = String(text ?? '').trim()
  if (!src) return []
  if (src.startsWith('{')) {
    try {
      const doc = JSON.parse(src)
      return Array.isArray(doc?.LSHandlers)
        ? doc.LSHandlers.filter((h) => h && typeof h === 'object')
        : []
    } catch {
      return []
    }
  }
  const handlers = []
  for (const text of entryDicts(src)) {
    const entry = {}
    const pairRe = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g
    let p
    while ((p = pairRe.exec(text))) entry[decodeXml(p[1])] = decodeXml(p[2])
    if (Object.keys(entry).some((k) => k.startsWith('LSHandler'))) handlers.push(entry)
  }
  return handlers
}

/**
 * The text of every `<dict>` two levels down in a plist's XML (the root dict holds `LSHandlers`,
 * its array holds one dict per handler), with the dicts nested inside it cut out: an entry's
 * `LSHandlerPreferredVersions` dict carries an `LSHandlerRoleAll` of its own ("-") that would
 * otherwise pass for the entry's.
 */
function entryDicts(xml) {
  const entries = []
  const tagRe = /<\/?dict>/g
  let depth = 0
  let entryStart = -1
  let nestedStart = -1
  let cuts = []
  let m
  while ((m = tagRe.exec(xml))) {
    if (m[0] === '<dict>') {
      depth++
      if (depth === 2) {
        entryStart = m.index + m[0].length
        cuts = []
      } else if (depth === 3) nestedStart = m.index
      continue
    }
    if (depth === 3) cuts.push([nestedStart, m.index + m[0].length])
    else if (depth === 2) {
      let text = ''
      let pos = entryStart
      for (const [from, to] of cuts) {
        text += xml.slice(pos, from)
        pos = to
      }
      entries.push(text + xml.slice(pos, m.index))
    }
    depth = Math.max(0, depth - 1)
  }
  return entries
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Who holds each web scheme in `handlers` (the bundle id LSHandlerRoleAll or LSHandlerRoleViewer
 * names, lower-cased as LaunchServices writes it), null when no entry names the scheme – which
 * on a fresh macOS means Safari, the built-in default with no entry of its own.
 */
export function webHandlers(handlers) {
  const out = {}
  for (const scheme of WEB_SCHEMES) {
    const entry = (handlers ?? []).find(
      (h) => String(h.LSHandlerURLScheme ?? '').toLowerCase() === scheme
    )
    out[scheme] = entry ? (entry.LSHandlerRoleAll ?? entry.LSHandlerRoleViewer ?? null) : null
  }
  return out
}

/**
 * The verdict on Make default's hand-over to LaunchServices, from the calls the wrapped `app`
 * methods recorded (`{ method, args, result }` each, in order) and whether http was held before
 * the request. The app has to ask for http, first and (while http is not held) alone; the answer
 * LaunchServices gave to the http request is recorded in `reading`, not judged – an ad-hoc-signed
 * bundle may be refused, and the user's yes is what makes the app the default. One line per miss.
 */
export function requestProblems({ calls, httpHeldBefore }) {
  const problems = []
  const sets = (calls ?? []).filter((c) => c.method === 'setAsDefaultProtocolClient')
  if (!sets.length) {
    return ['defaultBrowser.request made no app.setAsDefaultProtocolClient call']
  }
  const first = sets[0]
  const scheme = String(first.args?.[0] ?? '')
  if (httpHeldBefore) {
    // Already the default: the only claim due is https, quietly.
    if (sets.some((c) => c.args?.[0] === 'http')) {
      problems.push('http was requested again although the app already held it')
    }
  } else {
    if (scheme !== 'http')
      problems.push(`the first LaunchServices request was for '${scheme}', expected 'http'`)
    // https before the user's yes would put a second copy of the prompt on screen.
    const httpsBeforeHeld = sets.findIndex((c) => c.args?.[0] === 'https')
    if (httpsBeforeHeld !== -1) {
      const heldBefore = (calls ?? [])
        .slice(0, calls.indexOf(sets[httpsBeforeHeld]))
        .some(
          (c) =>
            c.method === 'isDefaultProtocolClient' && c.args?.[0] === 'http' && c.result === true
        )
      if (!heldBefore) problems.push('https was requested before LaunchServices reported http held')
    }
  }
  return problems
}

/** How LaunchServices took the http request, for the step's detail and the report. */
export function requestReading({ calls, httpHeldBefore }) {
  const http = (calls ?? []).find(
    (c) => c.method === 'setAsDefaultProtocolClient' && c.args?.[0] === 'http'
  )
  if (httpHeldBefore) return 'not asked: the app already held http'
  if (!http) return 'not asked'
  if (http.error) return `threw: ${http.error}`
  return http.result === true
    ? "accepted (LSSetDefaultHandlerForURLScheme returned noErr: the dialog is the OS's)"
    : `refused (returned ${JSON.stringify(http.result)})`
}

/**
 * The `osascript` results of looking at and clicking the dialog, read into one verdict: what
 * System Events said, or why it could not say ('not automatable' when the Accessibility
 * permission is missing – error -1719 or -1743 – or System Events is not scriptable here).
 */
export function dialogReading({ windows, click }) {
  const text = (r) => `${r?.stderr ?? ''} ${r?.stdout ?? ''} ${r?.error ?? ''}`.trim()
  const clip = (t) => String(t).slice(0, 300)
  if (!windows) return { dialog: 'not looked at', clicked: false }
  if (windows.status !== 0) {
    if (
      /-1719|-1743|assistive access|not allowed to send keystrokes|is not allowed/i.test(
        text(windows)
      )
    ) {
      return {
        dialog: `not automatable: ${clip(text(windows) || 'osascript refused')}`,
        clicked: false
      }
    }
    if (/-1728|can.t get process/i.test(text(windows))) {
      return { dialog: 'no CoreServicesUIAgent process (no dialog up)', clicked: false }
    }
    return {
      dialog: `osascript failed: ${clip(text(windows) || `exit ${windows.status}`)}`,
      clicked: false
    }
  }
  const names = String(windows.stdout).trim()
  if (!names || names === 'missing value')
    return { dialog: 'no CoreServicesUIAgent window on screen', clicked: false }
  const base = { dialog: `on screen: ${clip(names)}` }
  if (!click) return { ...base, clicked: false }
  if (click.status !== 0)
    return { ...base, clicked: false, clickError: clip(text(click) || `exit ${click.status}`) }
  return { ...base, clicked: true, clickResult: clip(String(click.stdout)) }
}

/** Whether `dialogReading`'s look found the dialog on screen (the click is worth trying). */
export function dialogOnScreen(reading) {
  return typeof reading?.dialog === 'string' && reading.dialog.startsWith('on screen')
}

/**
 * Installed in the main process: records every LaunchServices call the app makes from now on
 * (`setAsDefaultProtocolClient`, `isDefaultProtocolClient`, `removeAsDefaultProtocolClient`) with
 * its arguments and result, and keeps the originals under `orig` for the harness's own reads.
 */
function wrapLaunchServices({ app }) {
  const g = globalThis
  if (g.__smokeLS) return { installed: false, calls: g.__smokeLS.calls.length }
  const calls = []
  const orig = {}
  g.__smokeLS = { calls, orig }
  for (const method of [
    'setAsDefaultProtocolClient',
    'isDefaultProtocolClient',
    'removeAsDefaultProtocolClient'
  ]) {
    const fn = app[method].bind(app)
    orig[method] = fn
    app[method] = (...args) => {
      const entry = { method, args: args.map((a) => String(a)), at: Date.now() }
      try {
        entry.result = fn(...args)
      } catch (e) {
        entry.error = String((e && e.message) || e)
        calls.push(entry)
        throw e
      }
      calls.push(entry)
      return entry.result
    }
  }
  return { installed: true, calls: 0 }
}

/** The chrome page fires the request and keeps its outcome, without waiting for the OS. */
const FIRE_REQUEST = `(() => {
  const rec = { at: Date.now(), settled: false, result: undefined, error: null }
  window.__smokeDefaultBrowser = rec
  window.zen
    .invoke('defaultBrowser.request', { source: 'settings' })
    .then((r) => { rec.settled = true; rec.result = r })
    .catch((e) => { rec.settled = true; rec.error = String((e && e.message) || e) })
  return true
})()`

const READ_REQUEST = `(() => {
  const r = window.__smokeDefaultBrowser
  return r ? { at: r.at, settled: r.settled, result: r.result, error: r.error } : null
})()`

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, `writeJson`, `grabScreen`, `sh` (a command runner: `{status, stdout, stderr,
 * error}`), `osascript`, the executable's path (the bundle is three levels up), the run's output
 * directory and the platform flag.
 */
export async function scenarioDefaultBrowser(h) {
  const {
    freshProfile,
    runScenario,
    waitFor,
    delay,
    log,
    writeJson,
    grabScreen,
    sh,
    osascript,
    exe,
    outDir,
    isMac
  } = h
  const userData = freshProfile(`profile-${DEFAULT_BROWSER_SCENARIO}`, { onboardingDone: true })
  const bundle = path.resolve(exe, '..', '..', '..')
  const infoPlist = path.join(bundle, 'Contents', 'Info.plist')

  const readHandlers = () => {
    // `defaults export` reads through cfprefsd (the file on disk may lag); plutil turns the XML
    // into JSON, or the XML itself is parsed when it cannot.
    const exported = sh('defaults', ['export', LAUNCH_SERVICES_DOMAIN, '-'], 30000)
    if (exported.status !== 0) {
      return {
        readable: false,
        error: exported.stderr || exported.error || `exit ${exported.status}`,
        handlers: [],
        web: webHandlers([])
      }
    }
    const json = sh('plutil', ['-convert', 'json', '-o', '-', '-'], 30000, {
      input: exported.stdout
    })
    const handlers = parseLsHandlers(json.status === 0 ? json.stdout : exported.stdout)
    return {
      readable: true,
      via: json.status === 0 ? 'plutil json' : 'plist xml',
      count: handlers.length,
      web: webHandlers(handlers)
    }
  }

  return runScenario(DEFAULT_BROWSER_SCENARIO, userData, {}, async (s, out) => {
    const skip = { skipped: 'Make default through LaunchServices is macOS-only' }
    let bundleId = null
    let httpHeldBefore = null

    await s.step('bundle-claims-web', async () => {
      if (!isMac) return skip
      const r = sh('plutil', ['-convert', 'json', '-o', '-', infoPlist], 30000)
      let doc = null
      try {
        doc = JSON.parse(r.stdout)
      } catch {
        throw new Error(
          `plutil could not read ${infoPlist} as JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`
        )
      }
      bundleId = doc.CFBundleIdentifier ?? null
      const detail = { bundle, bundleId, urlTypes: doc.CFBundleURLTypes ?? null }
      const problems = urlTypeProblems(doc)
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      out.bundleId = bundleId
      return detail
    })

    await s.step('handlers-before', async () => {
      if (!isMac) return skip
      const facts = readHandlers()
      writeJson(path.join(outDir, `${DEFAULT_BROWSER_SCENARIO}-handlers-before.json`), facts)
      // The app's own answer, through the method the request reads (before the wrapper is in).
      httpHeldBefore = await s.app.evaluate(({ app }) => app.isDefaultProtocolClient('http'))
      log(
        `${DEFAULT_BROWSER_SCENARIO}: before the request http → ${facts.web.http ?? 'system default'}, https → ${facts.web.https ?? 'system default'}; app holds http: ${httpHeldBefore}`
      )
      return { ...facts, httpHeldBefore }
    })

    await s.step('make-default-calls-ls', async () => {
      if (!isMac) return skip
      const state = await s.chrome.evaluate(() => window.zen.invoke('app.getState'))
      if (state?.capabilities?.defaultBrowser !== true) {
        throw new Error(
          `capabilities.defaultBrowser is ${JSON.stringify(state?.capabilities?.defaultBrowser)}: the Settings row would be inert`
        )
      }
      const wrapped = await s.app.evaluate(wrapLaunchServices)
      const fired = await s.chrome.evaluate(FIRE_REQUEST)
      const t0 = Date.now()
      let calls = []
      await waitFor(
        async () => {
          calls = await s.app.evaluate(() => globalThis.__smokeLS?.calls ?? [])
          return calls.some((c) => c.method === 'setAsDefaultProtocolClient') ? calls : null
        },
        20000,
        'app.setAsDefaultProtocolClient called',
        250
      ).catch(() => undefined)
      const request = await s.chrome.evaluate(READ_REQUEST)
      const reading = requestReading({ calls, httpHeldBefore })
      const detail = {
        wrapped,
        fired,
        ms: Date.now() - t0,
        calls,
        request,
        reading,
        httpHeldBefore
      }
      const problems = requestProblems({ calls, httpHeldBefore })
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: ${calls
          .filter((c) => c.method === 'setAsDefaultProtocolClient')
          .map((c) => `set(${c.args.join(',')}) → ${c.result}`)
          .join(', ')}; http request ${reading}`
      )
      out.launchServices = { reading }
      return detail
    })

    await s.step('os-dialog', async () => {
      if (!isMac) return skip
      // The dialog takes a moment to come up; then the screen as it is.
      await delay(2000)
      const screen = grabScreen(`${DEFAULT_BROWSER_SCENARIO}-dialog`)
      const windows = osascript(
        'tell application "System Events" to tell process "CoreServicesUIAgent" to get name of every window',
        20000
      )
      let click = null
      if (dialogOnScreen(dialogReading({ windows }))) {
        // "Use "Zenium"" makes the app the default: the whole path, when the session lets a script
        // press it. Any other answer is left to the user.
        click = osascript(
          'tell application "System Events" to tell process "CoreServicesUIAgent" to tell window 1 to click (first button whose name begins with "Use")',
          20000
        )
      }
      const reading = dialogReading({ windows, click })
      if (reading.clicked) await delay(3000)
      const held = await s.app.evaluate(({ app }) => {
        const is =
          globalThis.__smokeLS?.orig?.isDefaultProtocolClient ??
          app.isDefaultProtocolClient.bind(app)
        return { http: is('http'), https: is('https') }
      })
      log(
        `${DEFAULT_BROWSER_SCENARIO}: dialog ${reading.dialog}; clicked ${reading.clicked}; app holds http ${held.http}, https ${held.https}`
      )
      out.dialog = reading
      return { screen: screen.file, reading, windows, click, held }
    })

    await s.step('handlers-after', async () => {
      if (!isMac) return skip
      const facts = readHandlers()
      writeJson(path.join(outDir, `${DEFAULT_BROWSER_SCENARIO}-handlers-after.json`), facts)
      const calls = await s.app.evaluate(() => globalThis.__smokeLS?.calls ?? [])
      const held = await s.app.evaluate(({ app }) => {
        const is =
          globalThis.__smokeLS?.orig?.isDefaultProtocolClient ??
          app.isDefaultProtocolClient.bind(app)
        return { http: is('http'), https: is('https') }
      })
      const request = await s.chrome.evaluate(READ_REQUEST)
      const detail = {
        ...facts,
        held,
        request,
        sets: calls.filter((c) => c.method === 'setAsDefaultProtocolClient')
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: after the request http → ${facts.web.http ?? 'system default'}, https → ${facts.web.https ?? 'system default'}; app holds http ${held.http}, https ${held.https}`
      )
      out.after = { web: facts.web, held }
      return detail
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}

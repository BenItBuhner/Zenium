// The `default-browser` scenario: Make default on macOS (os-07) and on Windows (ci-08's registry
// read). Its own file so the harness's scenario table gains one line for it (the `downloads`
// shape); the macOS steps are skipped with a note off macOS, the Windows steps off Windows.
//
// LaunchServices keeps the default web browser and only the user can change it: the app's
// `app.setAsDefaultProtocolClient('http')` (src/main/platform/defaultBrowser.ts, macRequest) makes
// the system put "Do you want to change your default web browser to Zenium?" on screen, and the
// app then waits for the user's yes. The scenario asserts the app's side of the hand-over and
// reads the OS's; where the session lets a script press the dialog's "Use" button (UI scripting
// through System Events needs the Accessibility permission – the GitHub runners grant it, a fresh
// Mac does not) the app's follow-through on the yes is asserted too:
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
//   os-dialog                  the screen as the dialog would be on it; every process's windows
//                              scanned through System Events for the dialog (its "default web
//                              browser" text or its "Use …"/"Keep …" buttons, whoever owns it),
//                              its "Use" button clicked when found (refused without the
//                              Accessibility permission: recorded as not automatable) – the OS's
//                              half, recorded; after a click, LaunchServices reporting http held
//                              (the OS's yes, recorded – an ad-hoc-signed bundle may be refused)
//                              makes the app see to https (macClaimHttps: looked at, claimed when
//                              the yes did not already cover it – macOS 26 sets both schemes on
//                              the one yes) and resolve the request true – the app's
//                              follow-through, asserted; a second scan tells whether a claim put
//                              another dialog up
//   handlers-after             LSHandlers again (given up to 20 s to catch up with the API once
//                              http is held: lsd writes the file late), and whether http and
//                              https are now held – recorded (held only when the click above
//                              went through)
//
// Windows keeps the default in the user's choice (UserChoice, written by Settings > Apps >
// Default apps and by nothing else since Windows 8), so the app never claims a scheme there:
// `defaultBrowser.request` (windowsRequest) reads the shell's association, then whether the
// installer's `RegisteredApplications\Zenium` entry is there (the entry Settings lists the app
// from), and sends the user to the app's own Default apps page
// (`ms-settings:defaultapps?registeredAppUser=Zenium`, Windows 11; the plain page on older builds
// or when the OS refuses the deep link) to press "Set default" – `app.setAsDefaultProtocolClient`
// is not called, because on Windows it writes `HKCU\Software\Classes\http\shell\open\command`,
// a class the user's choice overrides and the uninstaller does not know. The registry is read
// before and after the request through win-install.ps1 (`-Action registration`, beside the
// installer's keys the install step judges and the AppUserModelId key the notifications
// scenario judges):
//
//   registration-before        RegisteredApplications\Zenium, the StartMenuInternet client and
//                              its Capabilities, the ZeniumHTML ProgID – complete and pointing
//                              at the executable under test for an installed build (asserted),
//                              recorded for an unpacked one (not registered: the runner's
//                              unpacked leg runs before the install) – and the per-user http and
//                              https classes and the user's choice as they stand
//   make-default-opens-settings `defaultBrowser.request` (the Settings row's source) with
//                              `app.setAsDefaultProtocolClient` / `removeAsDefaultProtocolClient`
//                              and `shell.openExternal` wrapped: registered, the deep link to the
//                              app's Default apps page is opened, first (the plain page only after
//                              the OS refused it) and the request waits for the user; not
//                              registered, nothing is opened and the request resolves false at
//                              once; no scheme is claimed either way – the app's path up to the
//                              OS's Settings window
//   os-settings-page           a page call the OS has not answered yet is waited on (the arm64
//                              runner is slow to launch Settings); then the screen as Settings
//                              would be on it and the SystemSettings processes – the OS's half,
//                              recorded; then Settings closed so that nothing is left for the
//                              legs after
//   registry-after             the registration again – intact for the installed build – with
//                              the http and https classes: neither may name the executable (the
//                              class a setAsDefaultProtocolClient would have left); the user's
//                              choice again, for the record; and the state's
//                              `defaultBrowser.isDefault` reading false, the honest answer on a
//                              runner where Zenium is not the default (a class write would read
//                              as "default" without being it)
import path from 'node:path'

export const DEFAULT_BROWSER_SCENARIO = 'default-browser'

/** The schemes a web browser claims (electron-builder.yml `protocols`). */
export const WEB_SCHEMES = ['http', 'https']

/** The LaunchServices preferences domain whose LSHandlers name the default handlers. */
export const LAUNCH_SERVICES_DOMAIN = 'com.apple.LaunchServices/com.apple.launchservices.secure'

/**
 * The value name under `HKCU\Software\RegisteredApplications` build/installer.nsh writes and the
 * app's windowsIsRegistered looks for (src/main/platform/defaultBrowser.ts WINDOWS_REGISTERED_APP;
 * the test holds the two in step).
 */
export const WINDOWS_REGISTERED_APP = 'Zenium'

/** The first Windows 11 build: Settings has a per-app Default apps page with a "Set default" button. */
export const WINDOWS_11_BUILD = 22000

/** The ProgID build/installer.nsh registers for http, https and the document types (win-install.ps1's $ProgId). */
export const WINDOWS_PROG_ID = 'ZeniumHTML'

/** The Settings app's process, closed after the request opened it (nothing left for the legs after). */
export const WINDOWS_SETTINGS_PROCESS = 'SystemSettings'

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
 * The windows System Events found on screen, out of `windowScanScript`'s output: one line per
 * window, six tab-separated fields – the owner's pid and name, the window's index among the
 * owner's windows (1-based, what `clickUseScript` addresses), its name, its static texts and
 * its buttons (each list joined with ' | ', newlines flattened). Lines short of the six fields
 * are skipped.
 */
export function parseWindowScan(stdout) {
  const windows = []
  const list = (s) =>
    s
      .split(' | ')
      .map((t) => t.trim())
      .filter(Boolean)
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    if (fields.length < 6) continue
    const [pid, process, index, name, texts, buttons] = fields
    windows.push({
      pid: Number(pid),
      process,
      index: Number(index),
      name: name.trim(),
      texts: list(texts),
      buttons: list(buttons)
    })
  }
  return windows
}

/**
 * The default-browser dialog among the scanned windows: the one whose name or texts say
 * "default web browser" (LaunchServices' "Do you want to change your default web browser to
 * “…” or keep using “…”?"), or that offers a "Use …" and a "Keep …" button (the dialog's two
 * answers) – whichever process owns it (the scan assumes none). The app's own windows are not
 * candidates (`ownProcess`: the app's process name). null when no window matches.
 */
export function findDefaultBrowserDialog(windows, { ownProcess } = {}) {
  return (
    (windows ?? []).find((w) => {
      if (ownProcess && String(w.process).startsWith(ownProcess)) return false
      if (/default web browser/i.test([w.name, ...(w.texts ?? [])].join(' '))) return true
      const buttons = w.buttons ?? []
      return buttons.some((b) => /^Use\b/.test(b)) && buttons.some((b) => /^Keep\b/.test(b))
    }) ?? null
  )
}

/**
 * The `osascript` results of scanning the screen's windows and clicking the dialog, read into
 * one verdict: what System Events found, or why it could not look ('not automatable' when the
 * Accessibility permission is missing – error -1719 or -1743 – or System Events is not
 * scriptable here). With the dialog on screen: its owner (`process`, `pid`, the window's
 * `index`), its text and buttons; with `click`, whether the "Use" button was pressed.
 */
export function dialogReading({ scan, click, ownProcess }) {
  const text = (r) => `${r?.stderr ?? ''} ${r?.stdout ?? ''} ${r?.error ?? ''}`.trim()
  const clip = (t) => String(t).slice(0, 300)
  if (!scan) return { dialog: 'not looked at', clicked: false }
  if (scan.status !== 0) {
    if (
      /-1719|-1743|assistive access|not allowed to send keystrokes|is not allowed/i.test(text(scan))
    ) {
      return {
        dialog: `not automatable: ${clip(text(scan) || 'osascript refused')}`,
        clicked: false
      }
    }
    return {
      dialog: `osascript failed: ${clip(text(scan) || `exit ${scan.status}`)}`,
      clicked: false
    }
  }
  const windows = parseWindowScan(scan.stdout)
  const processes = new Set(windows.map((w) => w.process)).size
  const dialog = findDefaultBrowserDialog(windows, { ownProcess })
  if (!dialog) {
    return {
      dialog: `no default-browser dialog among the ${windows.length} window(s) of ${processes} process(es) on screen`,
      clicked: false,
      windows: windows.length
    }
  }
  const base = {
    dialog: `on screen (${dialog.process}, pid ${dialog.pid}, window ${dialog.index}): ${clip([dialog.name, ...dialog.texts].filter(Boolean).join(' '))}`,
    process: dialog.process,
    pid: dialog.pid,
    index: dialog.index,
    buttons: dialog.buttons,
    windows: windows.length
  }
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
 * The verdict on the app's follow-through once the dialog was answered "Use": LaunchServices
 * reporting http held – the OS's part, recorded when it does not come (an ad-hoc-signed bundle
 * may be refused) – is what makes the app see to https (macClaimHttps: looked at, and claimed
 * when the yes did not already cover it – macOS 26 sets both schemes on the one yes) and
 * resolve the request true. Nothing to judge without a click, or without http held. One line
 * per miss.
 */
export function followThroughProblems({ clicked, held, calls, request }) {
  if (!clicked || held?.http !== true) return []
  const problems = []
  const https = (c) => c.args?.[0] === 'https'
  const looked = (calls ?? []).some((c) => c.method === 'isDefaultProtocolClient' && https(c))
  const claimed = (calls ?? []).some((c) => c.method === 'setAsDefaultProtocolClient' && https(c))
  if (!looked && !claimed) {
    problems.push('http is held after the yes but the app never looked at https (macClaimHttps)')
  } else if (held.https !== true && !claimed) {
    problems.push('https is not held after the yes and the app did not claim it (macClaimHttps)')
  }
  if (!request?.settled) {
    problems.push('the request has not resolved although the app holds http')
  } else if (request.result !== true) {
    problems.push(
      `the request resolved ${JSON.stringify(request.result)} although the app holds http`
    )
  }
  return problems
}

// --- Windows ------------------------------------------------------------------------------------

/**
 * The Settings pages the app opens for the user's choice, in the order it tries them, given the
 * OS release (`os.release()`, "10.0.<build>"): from Windows 11 on the app's own Default apps page
 * (the deep link Settings resolves through RegisteredApplications) and then the plain page as
 * the fallback the OS's refusal gets; before it only the plain page (windowsRequest's `pages`).
 */
export function windowsSettingsPages(osRelease) {
  const build = Number(String(osRelease ?? '').split('.')[2] ?? 0)
  const plain = 'ms-settings:defaultapps'
  return build >= WINDOWS_11_BUILD
    ? [`${plain}?registeredAppUser=${WINDOWS_REGISTERED_APP}`, plain]
    : [plain]
}

/**
 * The scheme claims the app must not make on Windows, out of the calls the wrapped `app` methods
 * recorded: `setAsDefaultProtocolClient` and `removeAsDefaultProtocolClient` write and delete
 * HKCU\Software\Classes\<scheme>\shell\open\command there – a class the user's choice overrides
 * (so it would read as "default" without being it) and the uninstaller does not know. One line
 * per call.
 */
export function schemeClaimProblems(calls) {
  const problems = []
  for (const c of calls ?? []) {
    if (c.method === 'setAsDefaultProtocolClient' || c.method === 'removeAsDefaultProtocolClient') {
      const scheme = c.args?.[0] ?? '<scheme>'
      problems.push(
        `the app called app.${c.method}('${scheme}') on Windows: that writes HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command, which the user's choice overrides and the uninstaller does not remove`
      )
    }
  }
  return problems
}

/** The request's outcome so far, for a problem line or the log. */
function describeRequest(request) {
  if (!request) return 'not fired'
  if (!request.settled) return 'pending'
  if (request.error) return `threw ${request.error}`
  return `resolved ${JSON.stringify(request.result)}`
}

/**
 * The verdict on Make default's hand-over on Windows, from the calls the wrapped `app` methods
 * (`calls`: `{ method, args, result }`) and the wrapped `shell.openExternal` (`opens`: `{ url,
 * settled, error }`) recorded, whether the installer's registration was there (`registered`:
 * RegisteredApplications\Zenium – what the app keys on), whether the app already held the role
 * (`isDefaultBefore`), the request's outcome so far and the `pages` this OS build gets
 * (`windowsSettingsPages`). The app must not claim a scheme (`setAsDefaultProtocolClient` /
 * `removeAsDefaultProtocolClient` write HKCU\Software\Classes\<scheme>, which the user's choice
 * overrides and the uninstaller does not know); registered, it opens the app's own Default apps
 * page first – the plain page only after the OS refused the deep link – and waits for the
 * choice; not registered, it opens nothing and resolves false at once (Settings would not list
 * it); already the default, it resolves true and opens nothing. One line per miss.
 */
export function windowsRequestProblems({
  registered,
  isDefaultBefore = false,
  calls,
  opens,
  request,
  pages
}) {
  const problems = schemeClaimProblems(calls)
  const urls = (opens ?? []).map((o) => String(o.url))
  const opened = urls.length ? urls.join(', ') : 'nothing'
  if (isDefaultBefore === true) {
    if (urls.length) {
      problems.push(`Settings was opened (${opened}) although the app already held the role`)
    }
    if (!request?.settled || request.result !== true) {
      problems.push(
        `the request did not resolve true although the app already held the role (${describeRequest(request)})`
      )
    }
    return problems
  }
  if (!registered) {
    if (urls.length) {
      problems.push(
        `Settings was opened (${opened}) although Zenium is not registered with Windows (Settings would not list it)`
      )
    }
    if (!request?.settled) {
      problems.push(
        'the request is still pending although Zenium is not registered with Windows (it resolves false at once)'
      )
    } else if (request.result !== false) {
      problems.push(
        `the request ${describeRequest(request)} although Zenium is not registered with Windows, expected false`
      )
    }
    return problems
  }
  const expected = pages ?? windowsSettingsPages()
  if (!urls.length) {
    problems.push(`defaultBrowser.request opened no Settings page (expected ${expected[0]})`)
    return problems
  }
  if (urls[0] !== expected[0]) {
    problems.push(`the first Settings page opened was ${urls[0]}, expected ${expected[0]}`)
  }
  if (urls.length > 1) {
    if (!opens[0].error) {
      problems.push(
        `a second Settings page (${urls[1]}) was opened although the OS took the first (${urls[0]})`
      )
    } else if (urls[1] !== expected[1]) {
      problems.push(
        `the second Settings page opened was ${urls[1]}, expected ${expected[1] ?? 'none'}`
      )
    }
  }
  if (urls.length > expected.length) {
    problems.push(`${urls.length} Settings pages were opened, at most ${expected.length} expected`)
  }
  const allRefused = (opens ?? []).every((o) => o.error)
  if (request?.settled) {
    if (allRefused && request.result !== false) {
      problems.push(
        `the request ${describeRequest(request)} although the OS refused every Settings page, expected false`
      )
    } else if (!allRefused) {
      problems.push(
        `the request ${describeRequest(request)} although Settings is open and the user has not chosen (it waits for the choice)`
      )
    }
  } else if (allRefused) {
    problems.push('the request is still pending although the OS refused every Settings page')
  }
  return problems
}

/** How the request went on Windows, for the step's detail, the log and the report. */
export function windowsRequestReading({ registered, isDefaultBefore = false, opens, request }) {
  if (isDefaultBefore === true)
    return `not asked: the app already held the role (${describeRequest(request)})`
  if (!registered)
    return `not registered with Windows: no Settings page opened, request ${describeRequest(request)}`
  const list = (opens ?? []).map(
    (o) => `${o.url} → ${o.error ? `refused (${o.error})` : o.settled ? 'opened' : 'opening'}`
  )
  return `${list.length ? list.join('; ') : 'no Settings page opened'}; request ${describeRequest(request)}`
}

/**
 * What is wrong with the installer's registration as `win-install.ps1 -Action registration` read
 * it (`facts`: `registered`, `registrationProblems` against the executable under test) for a
 * build that is meant to be registered (`expectRegistered`: the installed one); an unpacked
 * build's reading is recorded, not judged. One line per miss.
 */
export function windowsRegistrationProblems(facts, { expectRegistered }) {
  if (!facts || typeof facts !== 'object') return ['the registration could not be read']
  if (!expectRegistered) return []
  const problems = []
  if (facts.registered !== true) {
    problems.push(
      `HKCU\\Software\\RegisteredApplications ${WINDOWS_REGISTERED_APP} does not name the Capabilities key (${JSON.stringify(facts.registration?.registeredApplications ?? null)}): the app's windowsIsRegistered would send nobody to Settings`
    )
  }
  for (const p of facts.registrationProblems ?? []) problems.push(String(p))
  return problems
}

/**
 * Whether a class's `shell\open\command` names the executable under test: the command Electron's
 * setAsDefaultProtocolClient writes is `"<exe>" "%1"` (slashes and case as the caller had them).
 */
export function commandNamesExe(command, exe) {
  if (!command || !exe) return false
  const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase()
  return norm(command).includes(norm(exe))
}

/**
 * What is wrong with the per-user http and https classes (`schemeClasses` out of the registration
 * reading: `{ http: { command }, https: { command } }`) after the request: neither command may
 * name the executable under test – the class only an `app.setAsDefaultProtocolClient` call
 * would have left. One line per miss.
 */
export function schemeClassProblems(schemeClasses, exe) {
  const problems = []
  for (const scheme of WEB_SCHEMES) {
    const command = schemeClasses?.[scheme]?.command
    if (commandNamesExe(command, exe)) {
      problems.push(
        `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command names the executable (${command}): the class app.setAsDefaultProtocolClient writes, which the app must not touch on Windows`
      )
    }
  }
  return problems
}

/** The user's choice per scheme, for a problem line or the log ("system default" when no UserChoice). */
export function describeUserChoice(userChoice) {
  return WEB_SCHEMES.map((s) => `${s} → ${userChoice?.[s] ?? 'system default'}`).join(', ')
}

/**
 * What is wrong with the state's default-browser reading (`status`: `state.defaultBrowser`) given
 * the user's choice as the registry has it (`userChoice`: the ProgId per scheme): the app is the
 * default when the choice names its ProgID for both schemes and not otherwise – on the runners
 * it never does, so `isDefault` has to read false; true there would mean the status reads a
 * class write rather than the user's choice, null that the host never answered.
 */
export function windowsStatusProblems(status, userChoice) {
  const ours = WEB_SCHEMES.every((s) => userChoice?.[s] === WINDOWS_PROG_ID)
  const isDefault = status?.isDefault
  if (isDefault === ours) return []
  if (isDefault === true) {
    return [
      `state.defaultBrowser.isDefault reads true although the user's choice does not name ${WINDOWS_PROG_ID} (${describeUserChoice(userChoice)}): the status must come from the user's choice, not a class write`
    ]
  }
  if (isDefault === false) {
    return [
      `state.defaultBrowser.isDefault reads false although the user's choice names ${WINDOWS_PROG_ID} for http and https`
    ]
  }
  return [
    `state.defaultBrowser.isDefault reads ${JSON.stringify(isDefault ?? null)}: the host never answered (windowsIsDefault reads the shell association for http:// and https://)`
  ]
}

/**
 * The AppleScript that lists every window of every process with its name, static texts and
 * buttons (one level of groups deep – the dialog's message and answers), one tab-separated line
 * each, for `parseWindowScan`. Processes whose name begins with `skipPrefix` (the app's own) are
 * left alone: querying a Chromium window's accessibility tree would switch the app's
 * accessibility on mid-run, and the OS's dialog is never the app's window.
 */
export function windowScanScript(skipPrefix = '') {
  const skip = JSON.stringify(skipPrefix)
  return `on clean(t)
  set AppleScript's text item delimiters to {linefeed, return, tab}
  set parts to text items of (t as text)
  set AppleScript's text item delimiters to " "
  return parts as text
end clean

on joinItems(xs)
  set s to ""
  repeat with x in xs
    try
      set v to contents of x
      if v is not missing value then
        if s is not "" then set s to s & " | "
        set s to s & my clean(v)
      end if
    end try
  end repeat
  return s
end joinItems

set out to ""
tell application "System Events"
  repeat with p in (every application process)
    try
      set pn to name of p
      set ownerPid to unix id of p
      if ${skip} is "" or pn does not start with ${skip} then
        set idx to 0
        repeat with w in (every window of p)
          set idx to idx + 1
          try
            set wn to name of w
            if wn is missing value then set wn to ""
            set texts to {}
            set btns to {}
            try
              set texts to value of every static text of w
            end try
            try
              set btns to name of every button of w
            end try
            try
              repeat with g in (every group of w)
                try
                  set texts to texts & (value of every static text of g)
                end try
                try
                  set btns to btns & (name of every button of g)
                end try
              end repeat
            end try
            set out to out & (ownerPid as text) & tab & pn & tab & (idx as text) & tab & (my clean(wn)) & tab & (my joinItems(texts)) & tab & (my joinItems(btns)) & linefeed
          end try
        end repeat
      end if
    end try
  end repeat
end tell
return out`
}

/**
 * The AppleScript that presses the first button beginning with "Use" ("Use “Zenium”") in window
 * `index` of the process with `pid` – in the window itself or in one of its groups – and names
 * the button it pressed.
 */
export function clickUseScript(pid, index) {
  const p = Number(pid)
  const i = Number(index)
  if (!Number.isInteger(p) || !Number.isInteger(i) || i < 1) {
    throw new Error(`clickUseScript needs a pid and a 1-based window index, got ${pid}, ${index}`)
  }
  return `tell application "System Events"
  set p to first application process whose unix id is ${p}
  tell p
    set w to window ${i}
    set b to missing value
    try
      set b to first button of w whose name begins with "Use"
    end try
    if b is missing value then
      repeat with g in (every group of w)
        try
          set b to first button of g whose name begins with "Use"
          exit repeat
        end try
      end repeat
    end if
    if b is missing value then error "no button beginning with Use in window ${i}"
    set bn to name of b
    click b
    return "clicked " & bn
  end tell
end tell`
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

/**
 * Installed in the main process: records every `shell.openExternal` call the app makes from now
 * on (the URL, when, and how the OS took it – resolved, or rejected with its message) and lets
 * it through: on Windows the Make default path opens the Default apps page for the user, and
 * the OS's half (the Settings window) is read afterwards. Keeps the original under `orig`.
 */
function wrapOpenExternal({ shell }) {
  const g = globalThis
  if (g.__smokeOpen) return { installed: true, calls: g.__smokeOpen.calls.length }
  const calls = []
  const orig = shell.openExternal.bind(shell)
  g.__smokeOpen = { calls, orig }
  const wrapped = (url, options) => {
    const entry = { url: String(url), at: Date.now(), settled: false, error: null }
    calls.push(entry)
    let p
    try {
      p = Promise.resolve(orig(url, options))
    } catch (e) {
      entry.settled = true
      entry.error = String((e && e.message) || e)
      throw e
    }
    return p.then(
      (r) => {
        entry.settled = true
        return r
      },
      (e) => {
        entry.settled = true
        entry.error = String((e && e.message) || e)
        throw e
      }
    )
  }
  try {
    shell.openExternal = wrapped
  } catch {
    // A read-only property: defined over below.
  }
  if (shell.openExternal !== wrapped) {
    try {
      Object.defineProperty(shell, 'openExternal', {
        value: wrapped,
        configurable: true,
        writable: true
      })
    } catch {
      // Not configurable either: `installed` says so.
    }
  }
  return { installed: shell.openExternal === wrapped, calls: 0 }
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
 * error}`), `osascript`, `ps` (a PowerShell runner for the scripts beside smoke.mjs), the
 * executable's path (the bundle is three levels up on macOS; the registration has to point at
 * it on Windows), the run's output directory and label (the registration readings are written
 * as `<label>-registration-<stage>.json`; the `installed` label is the build the installer
 * registered), the OS release (`os.release()`) and the platform flags.
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
    ps,
    exe,
    outDir,
    label = 'unpacked',
    osRelease = '',
    isMac,
    isWin = false
  } = h
  const userData = freshProfile(`profile-${DEFAULT_BROWSER_SCENARIO}`, { onboardingDone: true })
  const bundle = path.resolve(exe, '..', '..', '..')
  const infoPlist = path.join(bundle, 'Contents', 'Info.plist')
  // The installed build is the one the installer registered (the workflow's install step judged
  // the set); an unpacked build's registration is whatever the machine has – recorded.
  const expectRegistered = label === 'installed'
  const settingsPages = windowsSettingsPages(osRelease)

  // The registration as it stands, through win-install.ps1 (the reader the install and uninstall
  // steps judge with), written to the run's output as `<label>-registration-<stage>.json`.
  const readRegistration = (stage) => {
    const r = ps(
      'win-install.ps1',
      ['-Action', 'registration', '-Exe', exe, '-Out', outDir, '-Label', label, '-Stage', stage],
      90000
    )
    try {
      return JSON.parse(r.stdout)
    } catch {
      throw new Error(
        `win-install.ps1 -Action registration (${stage}) gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout || r.error || '').slice(0, 500)}`
      )
    }
  }

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
    // The app's process name as System Events sees it (the bundle's executable): its own windows
    // are no candidates for the OS's dialog.
    const appName = await s.app.evaluate(({ app }) => app.getName())
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

    // What LaunchServices says the app holds, through the unwrapped methods (the wrapper's
    // record stays the app's own calls).
    const heldNow = () =>
      s.app.evaluate(({ app }) => {
        const is =
          globalThis.__smokeLS?.orig?.isDefaultProtocolClient ??
          app.isDefaultProtocolClient.bind(app)
        return { http: is('http'), https: is('https') }
      })
    const lsCalls = () => s.app.evaluate(() => globalThis.__smokeLS?.calls ?? [])
    // The screen's windows read through System Events, and the dialog among them pressed "Use"
    // when `press` is set: "Use “Zenium”" makes the app the default – the whole path, when the
    // session lets a script press it. Any other answer is left to the user.
    const lookForDialog = (press) => {
      const scan = osascript(windowScanScript(appName), 90000)
      const look = dialogReading({ scan, ownProcess: appName })
      const click =
        press && dialogOnScreen(look)
          ? osascript(clickUseScript(look.pid, look.index), 20000)
          : null
      return { reading: dialogReading({ scan, click, ownProcess: appName }), scan, click }
    }

    await s.step('os-dialog', async () => {
      if (!isMac) return skip
      // The dialog takes a moment to come up; then the screen as it is.
      await delay(2000)
      const screen = grabScreen(`${DEFAULT_BROWSER_SCENARIO}-dialog`)
      const { reading, scan, click } = lookForDialog(true)
      let held = await heldNow()
      let afterYes = null
      if (reading.clicked) {
        // The app's awaitChoice asks LaunchServices every second: http held is the OS's yes, the
        // https claim and the request's resolution the app's follow-through.
        held = await waitFor(
          async () => {
            const h = await heldNow()
            return h.http ? h : null
          },
          15000,
          'LaunchServices reporting http held',
          500
        ).catch(() => heldNow())
        if (held.http) {
          await waitFor(
            async () => {
              const calls = await lsCalls()
              const request = await s.chrome.evaluate(READ_REQUEST)
              const https = calls.some(
                (c) =>
                  (c.method === 'isDefaultProtocolClient' ||
                    c.method === 'setAsDefaultProtocolClient') &&
                  c.args?.[0] === 'https'
              )
              return https && request?.settled ? true : null
            },
            15000,
            'https seen to and the request resolved',
            500
          ).catch(() => undefined)
          held = await heldNow()
        }
        // The https claim (when one was due) is meant to go through without another dialog: the
        // screen again, and any dialog that is up pressed too, for the record.
        await delay(1500)
        const second = lookForDialog(true)
        afterYes = {
          screen: grabScreen(`${DEFAULT_BROWSER_SCENARIO}-after-yes`).file,
          dialog: second.reading
        }
        if (second.reading.clicked) {
          await delay(1500)
          held = await heldNow()
        }
      }
      const calls = await lsCalls()
      const request = await s.chrome.evaluate(READ_REQUEST)
      const detail = {
        screen: screen.file,
        reading,
        scan: {
          status: scan.status,
          stderr: scan.stderr,
          windows: scan.status === 0 ? parseWindowScan(scan.stdout) : []
        },
        click,
        held,
        calls,
        request,
        afterYes
      }
      const problems = followThroughProblems({ clicked: reading.clicked, held, calls, request })
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: dialog ${reading.dialog}; clicked ${reading.clicked}; app holds http ${held.http}, https ${held.https}; request ${request?.settled ? `resolved ${JSON.stringify(request.result)}` : 'pending'}${afterYes ? `; after the yes: ${afterYes.dialog.dialog}` : ''}`
      )
      out.dialog = { ...reading, held, request, afterYes: afterYes?.dialog ?? null }
      return detail
    })

    await s.step('handlers-after', async () => {
      if (!isMac) return skip
      // LSHandlers names the bundle id in lower case, as LaunchServices writes it.
      const namesAppIn = (facts) =>
        Object.fromEntries(
          WEB_SCHEMES.map((scheme) => [
            scheme,
            String(facts.web[scheme] ?? '').toLowerCase() === String(bundleId ?? '').toLowerCase()
          ])
        )
      const held = await heldNow()
      let facts = readHandlers()
      let rounds = 1
      if (held.http) {
        // The API answers before lsd has written the preferences file (seen seconds to minutes
        // behind on the runners): when the app holds http, the file is given a moment to name
        // it – recorded either way, the API's answer being the OS's.
        await waitFor(
          () => {
            if (namesAppIn(facts).http) return facts
            rounds++
            facts = readHandlers()
            return null
          },
          20000,
          'LSHandlers naming the app for http',
          1000
        ).catch(() => undefined)
      }
      writeJson(path.join(outDir, `${DEFAULT_BROWSER_SCENARIO}-handlers-after.json`), facts)
      const calls = await lsCalls()
      const request = await s.chrome.evaluate(READ_REQUEST)
      const namesApp = namesAppIn(facts)
      const detail = {
        ...facts,
        namesApp,
        rounds,
        held,
        request,
        sets: calls.filter((c) => c.method === 'setAsDefaultProtocolClient')
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: after the request http → ${facts.web.http ?? 'system default'}, https → ${facts.web.https ?? 'system default'}; app holds http ${held.http}, https ${held.https}`
      )
      out.after = { web: facts.web, namesApp, held }
      return detail
    })

    // --- Windows: the registry before and after the request (ci-08) ---------------------------
    const winSkip = { skipped: 'Make default through Windows Settings is Windows-only' }
    let registered = null
    let isDefaultBefore = null
    let opens = []
    // The state's reading of the role (`state.defaultBrowser`: the Settings row's source).
    const status = () =>
      s.chrome
        .evaluate(() => window.zen.invoke('app.getState'))
        .then((st) => st?.defaultBrowser ?? null)
    const openCalls = () => s.app.evaluate(() => globalThis.__smokeOpen?.calls ?? [])
    const summarize = (facts) => ({
      registered: facts.registered,
      registrationProblems: facts.registrationProblems,
      registeredApplications: facts.registration?.registeredApplications ?? null,
      hklmRegisteredApplications: facts.registration?.hklmRegisteredApplications ?? null,
      progIdOpenCommand: facts.registration?.progIdOpenCommand?.['(default)'] ?? null,
      schemeClasses: facts.schemeClasses,
      userChoice: facts.userChoice
    })

    await s.step('registration-before', async () => {
      if (!isWin) return winSkip
      const facts = readRegistration('before')
      registered = facts.registered === true
      // The core read the role at start (windowsIsDefault: the shell's association for http://
      // and https://, asynchronous); given a moment to have answered.
      const st = await waitFor(
        async () => {
          const v = await status()
          return v && v.isDefault !== null ? v : null
        },
        10000,
        'state.defaultBrowser answered',
        250
      ).catch(() => status())
      isDefaultBefore = st?.isDefault ?? null
      const detail = { ...summarize(facts), status: st, expectRegistered, exe }
      const problems = windowsRegistrationProblems(facts, { expectRegistered })
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: before the request RegisteredApplications\\${WINDOWS_REGISTERED_APP} ${registered ? `names ${facts.registration.registeredApplications}` : 'is not there'} (${facts.registrationProblems.length} problem(s) against ${exe}${expectRegistered ? '' : ', not judged for this build'}); user's choice ${describeUserChoice(facts.userChoice)}; isDefault ${JSON.stringify(isDefaultBefore)}`
      )
      out.windows = { registeredBefore: registered, userChoice: facts.userChoice }
      return detail
    })

    await s.step('make-default-opens-settings', async () => {
      if (!isWin) return winSkip
      const state = await s.chrome.evaluate(() => window.zen.invoke('app.getState'))
      if (state?.capabilities?.defaultBrowser !== true) {
        throw new Error(
          `capabilities.defaultBrowser is ${JSON.stringify(state?.capabilities?.defaultBrowser)}: the Settings row would be inert`
        )
      }
      const wrappedLs = await s.app.evaluate(wrapLaunchServices)
      const wrappedOpen = await s.app.evaluate(wrapOpenExternal)
      if (!wrappedOpen.installed) {
        throw new Error(
          'the harness could not wrap shell.openExternal in the main process (a read-only property): the Settings page the request opens cannot be read'
        )
      }
      const fired = await s.chrome.evaluate(FIRE_REQUEST)
      const t0 = Date.now()
      let request = null
      // Registered, the page opens once reg.exe has answered; not registered, the request
      // resolves false at once. Either ends the wait.
      await waitFor(
        async () => {
          opens = await openCalls()
          request = await s.chrome.evaluate(READ_REQUEST)
          return opens.length || request?.settled ? true : null
        },
        20000,
        'a Settings page opened or the request settled',
        250
      ).catch(() => undefined)
      // The OS's answer to each open (ShellExecute) and, after a refusal, the app's next move:
      // the plain page, or giving up.
      await waitFor(
        async () => {
          opens = await openCalls()
          request = await s.chrome.evaluate(READ_REQUEST)
          if (!opens.length) return true
          if (!opens.every((o) => o.settled)) return null
          const last = opens[opens.length - 1]
          if (last.error && !request?.settled && opens.length < settingsPages.length) return null
          return true
        },
        10000,
        'the Settings page calls settled',
        250
      ).catch(() => undefined)
      const calls = await lsCalls()
      const warned = /default browser: Zenium is not registered with Windows/.test(
        s.stderr.join('')
      )
      const reading = windowsRequestReading({ registered, isDefaultBefore, opens, request })
      const detail = {
        wrappedLs,
        wrappedOpen,
        fired,
        ms: Date.now() - t0,
        registered,
        isDefaultBefore,
        pages: settingsPages,
        osRelease,
        opens,
        calls,
        request,
        warned,
        reading
      }
      const problems = windowsRequestProblems({
        registered,
        isDefaultBefore,
        calls,
        opens,
        request,
        pages: settingsPages
      })
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${DEFAULT_BROWSER_SCENARIO}: ${reading}; ${calls.length} protocol-client call(s)${warned ? '; the main process warned that Zenium is not registered' : ''}`
      )
      out.windows = { ...out.windows, reading, opens: opens.map((o) => o.url) }
      return detail
    })

    await s.step('os-settings-page', async () => {
      if (!isWin) return winSkip
      const t0 = Date.now()
      // ShellExecute answers once Settings is launching; the arm64 runner takes its time over
      // that (past the request step's wait), so a call still open is waited on here.
      let settledAfterMs = null
      if (opens.some((o) => !o.settled)) {
        await waitFor(
          async () => {
            opens = await openCalls()
            return opens.every((o) => o.settled) ? true : null
          },
          30000,
          'the Settings page calls settled',
          500
        )
          .then(() => {
            settledAfterMs = Date.now() - t0
          })
          .catch(() => undefined)
      }
      const taken = opens.filter((o) => !o.error)
      if (!taken.length) {
        return {
          note: registered
            ? 'the OS took no Settings page'
            : 'no Settings page was opened: Zenium is not registered with Windows',
          opens
        }
      }
      // Settings takes a moment to come up; then the screen as it is and the processes.
      await delay(3000)
      const screen = grabScreen(`${DEFAULT_BROWSER_SCENARIO}-settings`)
      const seen = ps(
        'win-session.ps1',
        ['-Action', 'processes', '-ProcessName', WINDOWS_SETTINGS_PROCESS],
        60000
      )
      let processes
      try {
        processes = JSON.parse(seen.stdout)
      } catch {
        processes = { error: (seen.stderr || seen.stdout || seen.error || '').slice(0, 300) }
      }
      // Closed so that nothing is left for the legs after (the session's kill stops zenium* only).
      const closed = ps(
        'win-session.ps1',
        ['-Action', 'kill', '-ProcessName', WINDOWS_SETTINGS_PROCESS],
        60000
      )
      const detail = {
        screen: screen.file,
        opened: taken.map((o) => `${o.url} → ${o.settled ? 'opened' : 'opening'}`),
        settledAfterMs,
        processes,
        closed: closed.stdout || closed.stderr || closed.error || `exit ${closed.status}`
      }
      const title = processes?.processes?.find((p) => p.mainWindowTitle)?.mainWindowTitle
      log(
        `${DEFAULT_BROWSER_SCENARIO}: ${detail.opened.join(', ')}${settledAfterMs !== null ? ` after ${settledAfterMs} ms more` : ''}; Settings ${processes?.count ? `on screen (${processes.count} ${WINDOWS_SETTINGS_PROCESS} process(es)${title ? `, "${title}"` : ''})` : 'not seen as a process'}; ${detail.closed}`
      )
      out.windows = {
        ...out.windows,
        settings: { processes: processes?.count ?? null, title: title ?? null, screen: screen.file }
      }
      return detail
    })

    await s.step('registry-after', async () => {
      if (!isWin) return winSkip
      const facts = readRegistration('after')
      const st = await status()
      const calls = await lsCalls()
      opens = await openCalls()
      const detail = { ...summarize(facts), status: st, calls, opens, exe }
      const problems = [
        ...windowsRegistrationProblems(facts, { expectRegistered }),
        ...schemeClassProblems(facts.schemeClasses, exe),
        ...schemeClaimProblems(calls),
        ...windowsStatusProblems(st, facts.userChoice)
      ]
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      const command = (scheme) => JSON.stringify(facts.schemeClasses?.[scheme]?.command ?? null)
      log(
        `${DEFAULT_BROWSER_SCENARIO}: after the request RegisteredApplications\\${WINDOWS_REGISTERED_APP} ${facts.registered ? 'intact' : 'not there'} (${facts.registrationProblems.length} problem(s)); http class command ${command('http')}, https ${command('https')}; user's choice ${describeUserChoice(facts.userChoice)}; isDefault ${JSON.stringify(st?.isDefault ?? null)}`
      )
      out.windows = {
        ...out.windows,
        registeredAfter: facts.registered,
        isDefault: st?.isDefault ?? null,
        schemeCommands: {
          http: facts.schemeClasses?.http?.command ?? null,
          https: facts.schemeClasses?.https?.command ?? null
        }
      }
      return detail
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}

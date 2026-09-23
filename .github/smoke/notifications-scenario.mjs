// The `notifications` scenario: a page's Web Notification on the OS's notification platform
// (os-27), the click that brings its tab and window forward (os-28) and the sender registration
// Windows Settings > System > Notifications lists Zenium from (os-30). Its own file so the
// harness's scenario table gains one line for it (the `downloads` shape).
//
// The profile is past onboarding and its permissions.json already allows notifications for the
// fixture origin (the store of record src/core/permissions.ts reads at start: the same answer
// the in-chrome prompt's Allow writes), so the page reads `Notification.permission === 'granted'`
// through the page preload's shim and `new Notification()` goes straight to the engine.
//
// What each step reads, and who confirms it:
//   permission-granted   the page's `Notification.permission` (the app's store through its shim)
//   app-id-registered    HKCU\Software\Classes\AppUserModelId\<id> with DisplayName and IconUri
//                        (the registration a copy without installer shortcuts writes for itself,
//                        src/main/platform/notifications.ts; read with win-toast.ps1) – Windows
//   shortcut-aumid       the installed shortcuts' System.AppUserModel.ID (the installer's
//                        WinShell::SetLnkAUMI; the id an installed build's toasts carry) – Windows,
//                        installed build only
//   fire                 `new Notification()` in the page: `show` fired, no `error`; and the main
//                        process's toast log (ELECTRON_DEBUG_NOTIFICATIONS=1 turns Electron's
//                        `LOG(INFO)` lines on: "Notification created" once ToastNotifier.Show
//                        returned S_OK, "WinAPI: … failed" otherwise) – the app's path up to the
//                        platform's acceptance of the toast
//   os-toast             the notification platform's per-sender key
//                        (HKCU\…\Notifications\Settings\<id>: created by Windows once the app has
//                        shown a toast; what Settings lists senders from) – the OS; plus, for
//                        the record, the banner windows on screen, the platform's store scanned
//                        for the id and the title, the platform's event log ("Toast … is
//                        delivered to <id>"), and a UI Automation click on the banner when one
//                        is there (WIN-006: the runner's session showed none)
//   click-reveals-tab    with another tab active, the notification's `click` dispatched in the
//                        page under a user gesture: `onclick` → `window.focus()` → the preload's
//                        `zen:page {type:'focus'}` → the core's `revealTab` – the tab active
//                        again, the window's show()/focus() called (wrapped) – the app's path
//                        from `onclick` on; Chromium's routing of an OS toast activation to
//                        `onclick` is the one link no runner click exercises
import path from 'node:path'

export const NOTIFICATIONS_SCENARIO = 'notifications'

/**
 * Must equal `APP_USER_MODEL_ID` in src/main/platform/notifications.ts and electron-builder's
 * `appId` (notifications-scenario.test.mjs holds the three in step).
 */
export const APP_USER_MODEL_ID = 'io.github.benitbuhner.zenium'

/** The environment that turns Electron's toast log on (shell/browser/notifications/notification.cc). */
export const TOAST_DEBUG_ENV = { ELECTRON_DEBUG_NOTIFICATIONS: '1' }

/**
 * The permissions.json document that allows notifications for `origin` – the shape
 * src/core/permissions.ts persists (`version: 1`, `decisions` keyed `${origin}|${permission}`,
 * the origin as `permissionSite` reads it: `new URL(url).origin`).
 */
export function notificationPermissionSeed(origin, decision = 'allow') {
  return { version: 1, decisions: { [`${new URL(origin).origin}|notifications`]: decision } }
}

/** One toast title per run, so a scan of the platform's store finds this run's toast. */
export function toastTitle(label, when = Date.now()) {
  return `Zenium smoke toast ${label} ${when}`
}

/**
 * Electron's toast log (windows_toast_notification.cc, DebugLog) read off the main process's
 * stderr: how often Show was called and a toast created, the failures with their text, the
 * clicks and dismissals, and whether the presenter came up at all. Lines without the log's
 * words are ignored; the matching lines come back for the step's detail.
 */
export function toastLogSummary(stderr) {
  const summary = {
    presenter: false,
    showCalled: 0,
    created: 0,
    clicked: 0,
    activated: 0,
    dismissed: 0,
    failed: [],
    lines: []
  }
  for (const raw of String(stderr ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.includes('Successfully created Windows notifications presenter')) {
      summary.presenter = true
    } else if (line.includes('WindowsToastNotification::Show called')) {
      summary.showCalled++
    } else if (line.includes('Notification created')) {
      summary.created++
    } else if (line.includes('Notification clicked')) {
      summary.clicked++
    } else if (line.includes('Notification activated')) {
      summary.activated++
    } else if (line.includes('Notification dismissed')) {
      summary.dismissed++
    } else if (
      /WinAPI: .* failed/.test(line) ||
      line.includes('PostNotificationFailedToUIThread called with error') ||
      line.includes('Calling NotificationFailed with error')
    ) {
      summary.failed.push(line.slice(0, 500))
    } else continue
    summary.lines.push(line.slice(0, 500))
  }
  return summary
}

/**
 * What is wrong with the AppUserModelId class key (`win-toast.ps1 -Action app-id`) for a copy
 * that registers itself: the key with `DisplayName` = the app's name and an `IconUri` naming a
 * file that exists. One line per miss, empty when the registration is complete.
 */
export function appIdProblems(facts, { displayName, aumid = APP_USER_MODEL_ID } = {}) {
  const problems = []
  const key = facts?.classKey ?? `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`
  if (!facts?.class) return [`${key} is missing`]
  const name = facts.class.DisplayName
  if (name !== displayName) {
    problems.push(`${key} DisplayName is ${shown(name)}, expected '${displayName}'`)
  }
  const icon = facts.class.IconUri
  if (!icon) problems.push(`${key} has no IconUri`)
  else if (facts.iconExists !== true)
    problems.push(`${key} IconUri names ${shown(icon)}, which is not on disk`)
  return problems
}

/**
 * What is wrong with the installed shortcuts (`win-toast.ps1 -Action shortcuts`): at least one
 * `Zenium.lnk` under the user's Start menu or Desktop, every one of them carrying the app id as
 * its System.AppUserModel.ID (the id the toasts of an installed build are grouped under).
 */
export function shortcutProblems(facts, aumid = APP_USER_MODEL_ID) {
  const shortcuts = facts?.shortcuts ?? []
  if (!shortcuts.length) {
    return [
      `no shortcut found under ${(facts?.folders ?? []).join(', ') || 'the Start menu and Desktop folders'}`
    ]
  }
  const problems = []
  for (const s of shortcuts) {
    if (s.error) problems.push(`${s.path}: ${s.error}`)
    else if (s.aumid !== aumid) {
      problems.push(
        `${s.path} carries System.AppUserModel.ID ${shown(s.aumid)}, expected '${aumid}'`
      )
    }
  }
  return problems
}

/**
 * The verdict on a fired notification: what the page saw (`show`, or `error`), what Electron's
 * toast log says. On Windows both halves have to agree – `show` in the page and "Notification
 * created" in the log, no failure line; elsewhere the log stays empty (no DebugLog off Windows)
 * and the page's `show` decides. One line per miss.
 */
export function fireProblems({ page, log, isWin }) {
  const problems = []
  if (!page) return ['the page kept no record of the notification (window.__smokeToast missing)']
  if (page.error) problems.push(`new Notification() threw: ${page.error}`)
  const types = (page.events ?? []).map((e) => e.type)
  const errored = (page.events ?? []).find((e) => e.type === 'error')
  if (errored) problems.push(`the notification fired 'error' (${types.join(', ')})`)
  if (!types.includes('show'))
    problems.push(`the notification never fired 'show' (events: ${types.join(', ') || 'none'})`)
  if (isWin) {
    if (log.failed.length)
      problems.push(`Electron's toast log reports a failure: ${log.failed.join(' | ')}`)
    if (log.created < 1) {
      problems.push(
        `Electron's toast log has no "Notification created" (show called ${log.showCalled}×, presenter ${log.presenter ? 'up' : 'not reported'}; ${log.lines.length} toast line(s) on stderr)`
      )
    }
  }
  return problems
}

/**
 * What is wrong with the platform's side after the toast (`win-toast.ps1 -Action toast`): the
 * per-sender key has to be there – Windows creates it when an app first shows a toast, and it
 * is what Settings > System > Notifications lists the app from (os-30). The banner, the store
 * scan and the event log are recorded, not judged (the runner's session may show no banner).
 */
export function senderProblems(facts, aumid = APP_USER_MODEL_ID) {
  const key =
    facts?.senderSettingsKey ??
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`
  if (!facts?.senderSettings) {
    return [
      `${key} is missing after the toast (waited ${facts?.senderSettingsRounds ?? '?'} round(s)): Windows did not register the sender`
    ]
  }
  return []
}

/**
 * How the OS side of a toast reads, for the step's detail and the report: `banner` when a "New
 * notification" window was on screen, `store` when the platform's database names the id and
 * the title, `delivered` when the platform's event log (Microsoft-Windows-PushNotification-
 * Platform/Operational, event 3153) says a toast was delivered to the app id, `osClick` when
 * the UI Automation click reached Electron ("Notification clicked" in the log or `click` in the
 * page) – each 'confirmed', 'not seen' or 'unreadable'.
 */
export function osToastReadings(facts, { log, pageEvents = [] } = {}) {
  const banner = (facts?.windows ?? []).some((w) => w.toast)
  const store = facts?.store
  const storeReadable = (store?.files ?? []).some((f) => f.exists && !f.error)
  const clicked = (log?.clicked ?? 0) > 0 || pageEvents.some((e) => e.type === 'click')
  const platformLog = facts?.platformLog
  const delivery = deliveredEvent(platformLog?.events, facts?.aumid ?? APP_USER_MODEL_ID)
  return {
    banner: banner ? 'confirmed' : 'not seen',
    store: !storeReadable
      ? 'unreadable'
      : store.aumidFound && store.titleFound
        ? 'confirmed'
        : store.aumidFound
          ? 'id only'
          : 'not seen',
    delivered:
      !platformLog || platformLog.error || platformLog.enabled === false
        ? 'unreadable'
        : delivery
          ? `confirmed (tracking id ${delivery.trackingId} at ${delivery.time})`
          : 'not seen',
    osClick: facts?.click?.invoked
      ? clicked
        ? 'confirmed'
        : 'invoked, no click reached Electron'
      : facts?.click?.attempted
        ? `not automatable: ${facts.click.error ?? 'no banner'}`
        : 'not attempted'
  }
}

/**
 * The verdict on the click path: the notification's tab was not the active one, the dispatched
 * click made it active again, the window's show()/focus() were called by the reveal, and the
 * page's focus request went over the preload's IPC. `windowFocused` is recorded, not judged:
 * whether Windows lets a background process take the foreground is the OS's call.
 */
export function clickProblems({
  notificationTabId,
  activeBefore,
  activeAfter,
  ipcFocusSeen,
  focusCalls,
  showCalls,
  pageEvents = []
}) {
  const problems = []
  if (activeBefore === notificationTabId) {
    problems.push(
      `the notification's tab ${notificationTabId} was still the active one before the click`
    )
  }
  const types = pageEvents.map((e) => e.type)
  if (!types.includes('onclick'))
    problems.push(`the page's onclick never ran (events: ${types.join(', ') || 'none'})`)
  if (!ipcFocusSeen)
    problems.push("no zen:page {type:'focus'} reached the main process from the page")
  if (activeAfter !== notificationTabId) {
    problems.push(`the active tab is ${activeAfter}, not the notification's ${notificationTabId}`)
  }
  if (!(focusCalls > 0)) problems.push("the window's focus() was not called by the reveal")
  if (!(showCalls > 0)) problems.push("the window's show() was not called by the reveal")
  return problems
}

/**
 * The platform's "Toast with notification tracking id N is delivered to <app id> on session S."
 * event (id 3153) for `aumid` among the event log's records, as `{ trackingId, time }`, or null.
 */
export function deliveredEvent(events, aumid = APP_USER_MODEL_ID) {
  const re = new RegExp(
    `Toast with notification tracking id (\\d+) is delivered to ${aumid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on session`,
    'i'
  )
  for (const e of events ?? []) {
    const m = re.exec(String(e?.message ?? ''))
    if (m) return { trackingId: Number(m[1]), time: e.time ?? null }
  }
  return null
}

function shown(v) {
  return v === undefined || v === null ? '<missing>' : `'${v}'`
}

/** The page's record of its notification, without the object itself. */
const READ_TOAST = `(() => {
  const r = window.__smokeToast
  return r ? { title: r.title, permission: r.permission, events: r.events, error: r.error } : null
})()`

function fireScript(title, body) {
  return `(() => {
    const rec = { title: ${JSON.stringify(title)}, permission: Notification.permission, events: [], error: null, at: Date.now() }
    window.__smokeToast = rec
    try {
      const n = new Notification(rec.title, { body: ${JSON.stringify(body)}, tag: 'zenium-smoke' })
      rec.n = n
      for (const type of ['show', 'error', 'click', 'close']) {
        n.addEventListener(type, () => rec.events.push({ type, at: Date.now() }))
      }
      n.onclick = () => {
        rec.events.push({ type: 'onclick', at: Date.now(), activation: navigator.userActivation ? navigator.userActivation.isActive : null })
        window.focus()
      }
    } catch (e) {
      rec.error = String((e && e.message) || e)
    }
    return { title: rec.title, permission: rec.permission, error: rec.error }
  })()`
}

const CLICK_SCRIPT = `(() => {
  const r = window.__smokeToast
  if (!r || !r.n) return { dispatched: false }
  const activation = navigator.userActivation ? navigator.userActivation.isActive : null
  r.n.dispatchEvent(new Event('click'))
  return { dispatched: true, activation }
})()`

/** Installed in the main process: counts show()/focus() on the window whose id is given. */
function wrapWindowReveal({ BrowserWindow }, windowId) {
  const w = BrowserWindow.fromId(windowId)
  if (!w || w.isDestroyed()) return null
  const g = globalThis
  if (!g.__smokeReveal) g.__smokeReveal = {}
  const counts = { show: 0, focus: 0 }
  g.__smokeReveal[windowId] = counts
  if (!w.__smokeRevealWrapped) {
    const show = w.show.bind(w)
    const focus = w.focus.bind(w)
    w.show = (...args) => {
      counts.show++
      return show(...args)
    }
    w.focus = (...args) => {
      counts.focus++
      return focus(...args)
    }
    w.__smokeRevealWrapped = true
  }
  return counts
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`,
 * `waitFor`, `delay`, `log`, `writeJson`, `grabScreen`, `ps` (a PowerShell runner for the
 * scripts beside smoke.mjs), the fixture (`startBootFixture`'s result), the run's label,
 * `expectShortcuts` (an installed build: the installer's shortcuts must be there) and the
 * platform flags.
 */
export async function scenarioNotifications(h) {
  const {
    freshProfile,
    runScenario,
    waitFor,
    delay,
    log,
    writeJson,
    grabScreen,
    ps,
    fixture,
    label,
    expectShortcuts = false,
    isWin
  } = h
  const page = fixture.first
  const userData = freshProfile(`profile-${NOTIFICATIONS_SCENARIO}`, { onboardingDone: true })
  writeJson(
    path.join(userData, 'zen', 'permissions.json'),
    notificationPermissionSeed(fixture.origin)
  )
  const title = toastTitle(label)
  const body = `Fired by the desktop smoke's ${NOTIFICATIONS_SCENARIO} scenario from ${fixture.origin}.`

  return runScenario(NOTIFICATIONS_SCENARIO, userData, { env: TOAST_DEBUG_ENV }, async (s, out) => {
    out.title = title
    out.aumid = APP_USER_MODEL_ID
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })
    const inPage = (id, code, userGesture = false) =>
      s.app.evaluate(
        ({ webContents }, { id, code, userGesture }) => {
          const wc = webContents.fromId(id)
          if (!wc || wc.isDestroyed()) throw new Error(`webContents ${id} is gone`)
          return wc.executeJavaScript(code, userGesture)
        },
        { id, code, userGesture }
      )
    const toastLog = () => toastLogSummary(s.stderr.join(''))
    const appName = await s.app.evaluate(({ app }) => app.getName())
    let tabId = null
    let view = null

    await s.step('permission-granted', async () => {
      tabId = await invoke('tab.create', { url: page.url, active: true })
      view = await s.waitForTab(page.url, 20000)
      // The shim answers from the app's store on the page's first read.
      const status = await inPage(view.id, 'Notification.permission')
      if (status !== 'granted') {
        throw new Error(
          `Notification.permission reads '${status}' on ${page.url} with permissions.json allowing ${fixture.origin}`
        )
      }
      return { tabId, webContents: view.id, url: view.url, permission: status }
    })

    await s.step('app-id-registered', async () => {
      if (!isWin) return { skipped: 'the AppUserModelId class key is Windows-only' }
      // Written by reg.exe after browser.start (ensureWindowsAppIdRegistered is asynchronous and
      // silent), so the read is polled.
      let facts = null
      let problems = null
      await waitFor(
        async () => {
          const r = ps('win-toast.ps1', ['-Action', 'app-id', '-Aumid', APP_USER_MODEL_ID], 60000)
          facts = parseJson(r.stdout, r)
          problems = appIdProblems(facts, { displayName: appName })
          return problems.length === 0
        },
        15000,
        'the AppUserModelId class key complete',
        1000
      ).catch((e) => {
        const err = new Error(`${problems ? problems.join('; ') : e.message}`)
        err.detail = facts
        throw err
      })
      return facts
    })

    await s.step('shortcut-aumid', async () => {
      if (!isWin) return { skipped: 'installer shortcuts are Windows-only' }
      const r = ps('win-toast.ps1', ['-Action', 'shortcuts', '-Aumid', APP_USER_MODEL_ID], 60000)
      const facts = parseJson(r.stdout, r)
      if (!expectShortcuts) {
        return {
          skipped:
            'the unpacked build has no installer shortcut (its toasts ride on the class key above)',
          ...facts
        }
      }
      const problems = shortcutProblems(facts)
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = facts
        throw err
      }
      return facts
    })

    await s.step('fire', async () => {
      const t0 = Date.now()
      const fired = await inPage(view.id, fireScript(title, body), true)
      let record = null
      await waitFor(
        async () => {
          record = await inPage(view.id, READ_TOAST)
          const types = (record?.events ?? []).map((e) => e.type)
          return types.includes('show') || types.includes('error') || record?.error ? record : null
        },
        15000,
        "the notification's show or error event",
        250
      ).catch(() => undefined)
      // The log line lands on stderr a moment after the page's event.
      await delay(500)
      const logSummary = toastLog()
      const problems = fireProblems({ page: record, log: logSummary, isWin })
      const detail = { fired, page: record, log: logSummary, ms: Date.now() - t0 }
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${NOTIFICATIONS_SCENARIO}: '${title}' shown after ${detail.ms} ms; toast log: ${logSummary.lines.join(' | ') || 'none'}`
      )
      return detail
    })

    await s.step('os-toast', async () => {
      if (!isWin) return { skipped: 'the notification platform reads are Windows-only' }
      // The screen as it is while a banner would be up (they time out after a few seconds).
      const screen = grabScreen(`${NOTIFICATIONS_SCENARIO}-toast`)
      const r = ps(
        'win-toast.ps1',
        [
          '-Action',
          'toast',
          '-Aumid',
          APP_USER_MODEL_ID,
          '-Title',
          title,
          '-WaitSeconds',
          '10',
          '-Click'
        ],
        120000
      )
      const facts = parseJson(r.stdout, r)
      // A click that reached the banner shows up in Electron's log and the page within a moment.
      if (facts.click?.invoked) await delay(2000)
      const pageRecord = await inPage(view.id, READ_TOAST)
      const logSummary = toastLog()
      const readings = osToastReadings(facts, {
        log: logSummary,
        pageEvents: pageRecord?.events ?? []
      })
      const detail = { screen: screen.file, readings, facts, log: logSummary, page: pageRecord }
      const problems = senderProblems(facts)
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(`${NOTIFICATIONS_SCENARIO}: platform readings ${JSON.stringify(readings)}`)
      return detail
    })

    await s.step('click-reveals-tab', async () => {
      // Another tab takes the front, so the reveal has something to do.
      const otherTabId = await invoke('tab.create', { active: true })
      const activeBefore = await waitFor(
        async () => {
          const active = await s.activeTabId()
          return active && active !== tabId ? active : null
        },
        8000,
        'another tab active'
      )
      const counts = await s.app.evaluate(wrapWindowReveal, s.mainWindowId)
      if (!counts) throw new Error(`window ${s.mainWindowId} is gone`)
      const eventsBefore = s
        .readEvents()
        .filter((e) => e.type === 'page-message' && e.message === 'focus').length
      const dispatched = await inPage(view.id, CLICK_SCRIPT, true)
      if (!dispatched.dispatched)
        throw new Error('the page lost its notification object before the click')
      let activeAfter = null
      await waitFor(
        async () => {
          activeAfter = await s.activeTabId()
          return activeAfter === tabId
        },
        8000,
        "the notification's tab active again"
      ).catch(() => undefined)
      const reveal = await s.app.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        return {
          counts: globalThis.__smokeReveal?.[id] ?? null,
          focused: w && !w.isDestroyed() ? w.isFocused() : null,
          visible: w && !w.isDestroyed() ? w.isVisible() : null,
          minimized: w && !w.isDestroyed() ? w.isMinimized() : null
        }
      }, s.mainWindowId)
      // The window's focus, polled for a moment: Windows may or may not hand the foreground over.
      let windowFocused = reveal.focused
      if (!windowFocused) {
        windowFocused = await waitFor(
          () => s.window().then((w) => w?.focused ?? null),
          3000,
          'the window focused',
          250
        ).catch(() => false)
      }
      const focusEvents = s
        .readEvents()
        .filter((e) => e.type === 'page-message' && e.message === 'focus')
      const ipcFocusSeen = focusEvents.length > eventsBefore
      const pageRecord = await inPage(view.id, READ_TOAST)
      const detail = {
        notificationTabId: tabId,
        otherTabId,
        activeBefore,
        activeAfter,
        dispatched,
        ipcFocusSeen,
        ipcFocusEvents: focusEvents.length - eventsBefore,
        reveal: { ...reveal, windowFocused },
        page: pageRecord,
        log: toastLog()
      }
      const problems = clickProblems({
        notificationTabId: tabId,
        activeBefore,
        activeAfter,
        ipcFocusSeen,
        focusCalls: reveal.counts?.focus ?? 0,
        showCalls: reveal.counts?.show ?? 0,
        pageEvents: pageRecord?.events ?? []
      })
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = detail
        throw err
      }
      log(
        `${NOTIFICATIONS_SCENARIO}: click → tab ${tabId} active (was ${activeBefore}); window focused ${windowFocused}, show ${reveal.counts?.show}× focus ${reveal.counts?.focus}×`
      )
      return detail
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}

/** The JSON a PowerShell helper printed, or an error naming what it printed instead. */
function parseJson(text, r) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `win-toast.ps1 printed no JSON (exit ${r?.status}): ${(r?.stderr || r?.stdout || r?.error || '').slice(0, 800)}`
    )
  }
}

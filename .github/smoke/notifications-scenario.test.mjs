import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APP_USER_MODEL_ID,
  NOTIFICATIONS_SCENARIO,
  TOAST_DEBUG_ENV,
  appIdProblems,
  clickProblems,
  fireProblems,
  notificationPermissionSeed,
  osToastReadings,
  senderProblems,
  shortcutProblems,
  toastLogSummary,
  toastTitle
} from './notifications-scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const classKey = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`
const senderKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${APP_USER_MODEL_ID}`

// Electron's LOG(INFO) lines as the main process writes them to stderr under
// ELECTRON_ENABLE_LOGGING (shell/browser/notifications/win/windows_toast_notification.cc).
const stderrShown = [
  '[7032:0923/160102.101:INFO:windows_toast_notification.cc(95)] Successfully created Windows notifications presenter',
  'Some unrelated line the app printed',
  '[7032:0923/160102.412:INFO:windows_toast_notification.cc(144)] WindowsToastNotification::Show called',
  '[7032:0923/160102.480:INFO:windows_toast_notification.cc(233)] Notification created',
  '',
  '[7032:0923/160104.001:INFO:windows_toast_notification.cc(560)] Notification clicked',
  '[7032:0923/160105.900:INFO:windows_toast_notification.cc(580)] Notification dismissed'
].join('\r\n')

const stderrFailed = [
  '[7032:0923/160102.412:INFO:windows_toast_notification.cc(144)] WindowsToastNotification::Show called',
  '[7032:0923/160102.480:ERROR:windows_toast_notification.cc(200)] WinAPI: ShowNotification failed, ERROR -2143420143',
  '[7032:0923/160102.481:INFO:windows_toast_notification.cc(210)] PostNotificationFailedToUIThread called with error: E_NOTIMPL'
].join('\n')

describe('the scenario constants', () => {
  it('names the scenario the harness table and the workflow use', () => {
    expect(NOTIFICATIONS_SCENARIO).toBe('notifications')
    expect(read('.github/workflows/desktop-smoke.yml')).toMatch(
      /--scenarios [a-z,-]*\bnotifications\b/
    )
  })

  it('holds the AppUserModelId in step with the main process and electron-builder', () => {
    const source = read('src/main/platform/notifications.ts')
    expect(source).toContain(`export const APP_USER_MODEL_ID = '${APP_USER_MODEL_ID}'`)
    expect(read('electron-builder.yml')).toMatch(
      new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm')
    )
  })

  it('turns Electron’s toast log on with the switch notification.cc reads', () => {
    expect(TOAST_DEBUG_ENV).toEqual({ ELECTRON_DEBUG_NOTIFICATIONS: '1' })
  })
})

describe('notificationPermissionSeed', () => {
  it('writes the store’s shape keyed by the page’s origin and the permission', () => {
    expect(notificationPermissionSeed('http://127.0.0.1:41234/first.html?x=1')).toEqual({
      version: 1,
      decisions: { 'http://127.0.0.1:41234|notifications': 'allow' }
    })
  })

  it('takes the decision to write', () => {
    expect(notificationPermissionSeed('https://example.com', 'deny').decisions).toEqual({
      'https://example.com|notifications': 'deny'
    })
  })

  it('keys the decision the way src/core/permissions.ts reads it', () => {
    const source = read('src/core/permissions.ts')
    expect(source).toContain('`${origin}|${permission}`')
    expect(source).toContain(
      'if (data?.version === 1 && data.decisions) this.decisions = data.decisions'
    )
  })
})

describe('toastTitle', () => {
  it('names the run and the moment, so a store scan finds this toast', () => {
    expect(toastTitle('installed', 1700000000000)).toBe(
      'Zenium smoke toast installed 1700000000000'
    )
    expect(toastTitle('unpacked')).toMatch(/^Zenium smoke toast unpacked \d+$/)
  })
})

describe('toastLogSummary', () => {
  it('counts the presenter, the shows, the creations, clicks and dismissals', () => {
    const s = toastLogSummary(stderrShown)
    expect(s.presenter).toBe(true)
    expect(s.showCalled).toBe(1)
    expect(s.created).toBe(1)
    expect(s.clicked).toBe(1)
    expect(s.activated).toBe(0)
    expect(s.dismissed).toBe(1)
    expect(s.failed).toEqual([])
    expect(s.lines).toHaveLength(5)
    expect(s.lines.some((l) => l.includes('unrelated'))).toBe(false)
  })

  it('collects the failure lines with their text', () => {
    const s = toastLogSummary(stderrFailed)
    expect(s.showCalled).toBe(1)
    expect(s.created).toBe(0)
    expect(s.failed).toHaveLength(2)
    expect(s.failed[0]).toContain('ShowNotification failed, ERROR -2143420143')
    expect(s.failed[1]).toContain('E_NOTIMPL')
  })

  it('reads an empty or missing log as nothing', () => {
    expect(toastLogSummary('')).toMatchObject({
      presenter: false,
      showCalled: 0,
      created: 0,
      failed: [],
      lines: []
    })
    expect(toastLogSummary(undefined).lines).toEqual([])
  })
})

describe('appIdProblems', () => {
  const complete = {
    classKey,
    class: {
      DisplayName: 'Zenium',
      IconUri: 'C:\\Users\\r\\AppData\\Roaming\\Zenium\\zen\\app-icon.png'
    },
    iconExists: true
  }

  it('accepts the complete registration', () => {
    expect(appIdProblems(complete, { displayName: 'Zenium' })).toEqual([])
  })

  it('names a missing key', () => {
    expect(appIdProblems({ classKey, class: null }, { displayName: 'Zenium' })).toEqual([
      `${classKey} is missing`
    ])
    expect(appIdProblems(null, { displayName: 'Zenium' })).toEqual([`${classKey} is missing`])
  })

  it('names a DisplayName that is not the app’s name', () => {
    const problems = appIdProblems(
      { ...complete, class: { ...complete.class, DisplayName: 'Electron' } },
      { displayName: 'Zenium' }
    )
    expect(problems).toEqual([`${classKey} DisplayName is 'Electron', expected 'Zenium'`])
  })

  it('names a missing IconUri and one that is not on disk', () => {
    expect(
      appIdProblems({ ...complete, class: { DisplayName: 'Zenium' } }, { displayName: 'Zenium' })
    ).toEqual([`${classKey} has no IconUri`])
    expect(appIdProblems({ ...complete, iconExists: false }, { displayName: 'Zenium' })).toEqual([
      `${classKey} IconUri names '${complete.class.IconUri}', which is not on disk`
    ])
  })
})

describe('shortcutProblems', () => {
  const lnk = (p, aumid = APP_USER_MODEL_ID) => ({
    path: p,
    aumid,
    target: 'C:\\Users\\r\\AppData\\Local\\Programs\\Zenium\\Zenium.exe'
  })

  it('accepts shortcuts that all carry the app id', () => {
    expect(
      shortcutProblems({
        shortcuts: [
          lnk('C:\\Users\\r\\Desktop\\Zenium.lnk'),
          lnk('C:\\Users\\r\\...\\Programs\\Zenium.lnk')
        ]
      })
    ).toEqual([])
  })

  it('names the folders looked in when no shortcut was found', () => {
    expect(shortcutProblems({ shortcuts: [], folders: ['C:\\a', 'C:\\b'] })).toEqual([
      'no shortcut found under C:\\a, C:\\b'
    ])
    expect(shortcutProblems(null)).toEqual([
      'no shortcut found under the Start menu and Desktop folders'
    ])
  })

  it('names a shortcut with another id, or none, and one that could not be read', () => {
    const problems = shortcutProblems({
      shortcuts: [
        lnk('C:\\d\\Zenium.lnk', 'com.electron.zenium'),
        lnk('C:\\p\\Zenium.lnk', null),
        { path: 'C:\\x\\Zenium.lnk', error: 'COM refused' }
      ]
    })
    expect(problems).toEqual([
      `C:\\d\\Zenium.lnk carries System.AppUserModel.ID 'com.electron.zenium', expected '${APP_USER_MODEL_ID}'`,
      `C:\\p\\Zenium.lnk carries System.AppUserModel.ID <missing>, expected '${APP_USER_MODEL_ID}'`,
      'C:\\x\\Zenium.lnk: COM refused'
    ])
  })
})

describe('fireProblems', () => {
  const shown = {
    title: 't',
    permission: 'granted',
    events: [{ type: 'show', at: 1 }],
    error: null
  }
  const okLog = toastLogSummary(stderrShown)

  it('accepts a shown toast on Windows when the page and the log agree', () => {
    expect(fireProblems({ page: shown, log: okLog, isWin: true })).toEqual([])
  })

  it('lets the page’s show decide off Windows, where the log is empty', () => {
    expect(fireProblems({ page: shown, log: toastLogSummary(''), isWin: false })).toEqual([])
  })

  it('names a page that kept no record, a throw, an error event and a missing show', () => {
    expect(fireProblems({ page: null, log: okLog, isWin: true })).toEqual([
      'the page kept no record of the notification (window.__smokeToast missing)'
    ])
    expect(
      fireProblems({
        page: { ...shown, events: [], error: 'Illegal constructor' },
        log: okLog,
        isWin: true
      })
    ).toEqual([
      'new Notification() threw: Illegal constructor',
      "the notification never fired 'show' (events: none)"
    ])
    expect(
      fireProblems({
        page: { ...shown, events: [{ type: 'error', at: 1 }] },
        log: okLog,
        isWin: true
      })
    ).toEqual([
      "the notification fired 'error' (error)",
      "the notification never fired 'show' (events: error)"
    ])
  })

  it('names the log’s failure and a missing creation on Windows', () => {
    const problems = fireProblems({ page: shown, log: toastLogSummary(stderrFailed), isWin: true })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(
      /^Electron's toast log reports a failure: .*ShowNotification failed/
    )
    expect(problems[1]).toBe(
      'Electron\'s toast log has no "Notification created" (show called 1×, presenter not reported; 3 toast line(s) on stderr)'
    )
  })
})

describe('senderProblems', () => {
  it('accepts the per-sender key Windows created', () => {
    expect(
      senderProblems({ senderSettingsKey: senderKey, senderSettings: { Enabled: 1 } })
    ).toEqual([])
  })

  it('names the key that is missing after the toast', () => {
    expect(
      senderProblems({
        senderSettingsKey: senderKey,
        senderSettings: null,
        senderSettingsRounds: 10
      })
    ).toEqual([
      `${senderKey} is missing after the toast (waited 10 round(s)): Windows did not register the sender`
    ])
    expect(senderProblems(null)[0]).toContain(
      `${senderKey} is missing after the toast (waited ? round(s))`
    )
  })
})

describe('osToastReadings', () => {
  const store = (aumidFound, titleFound) => ({ files: [{ exists: true }], aumidFound, titleFound })

  it('reads a banner, a store naming id and title, and a click that reached Electron', () => {
    const facts = {
      windows: [{ toast: true, title: 'New notification' }],
      store: store(true, true),
      click: { attempted: true, invoked: true }
    }
    expect(osToastReadings(facts, { log: { clicked: 1 }, pageEvents: [] })).toEqual({
      banner: 'confirmed',
      store: 'confirmed',
      osClick: 'confirmed'
    })
    expect(
      osToastReadings(facts, { log: { clicked: 0 }, pageEvents: [{ type: 'click' }] }).osClick
    ).toBe('confirmed')
  })

  it('reads nothing on screen, an unreadable store and a click that was not possible', () => {
    expect(
      osToastReadings({
        windows: [],
        store: { files: [{ exists: false }] },
        click: { attempted: true, invoked: false, error: 'no banner' }
      })
    ).toEqual({
      banner: 'not seen',
      store: 'unreadable',
      osClick: 'not automatable: no banner'
    })
    expect(osToastReadings({ store: store(true, false) }, {}).store).toBe('id only')
    expect(osToastReadings({ store: store(false, false) }, {}).store).toBe('not seen')
    expect(
      osToastReadings({ store: { files: [{ exists: true, error: 'locked' }] } }, {}).store
    ).toBe('unreadable')
    expect(osToastReadings({}, {}).osClick).toBe('not attempted')
  })

  it('tells an invoked click that reached nothing', () => {
    expect(
      osToastReadings(
        { click: { attempted: true, invoked: true } },
        { log: { clicked: 0 }, pageEvents: [] }
      ).osClick
    ).toBe('invoked, no click reached Electron')
  })
})

describe('clickProblems', () => {
  const good = {
    notificationTabId: 'tab-a',
    activeBefore: 'tab-b',
    activeAfter: 'tab-a',
    ipcFocusSeen: true,
    focusCalls: 1,
    showCalls: 1,
    pageEvents: [{ type: 'show' }, { type: 'onclick' }]
  }

  it('accepts a click that brought the tab back through the preload and the reveal', () => {
    expect(clickProblems(good)).toEqual([])
  })

  it('names each miss', () => {
    expect(clickProblems({ ...good, activeBefore: 'tab-a' })).toEqual([
      "the notification's tab tab-a was still the active one before the click"
    ])
    expect(clickProblems({ ...good, pageEvents: [{ type: 'show' }] })).toEqual([
      "the page's onclick never ran (events: show)"
    ])
    expect(clickProblems({ ...good, ipcFocusSeen: false })).toEqual([
      "no zen:page {type:'focus'} reached the main process from the page"
    ])
    expect(clickProblems({ ...good, activeAfter: 'tab-b' })).toEqual([
      "the active tab is tab-b, not the notification's tab-a"
    ])
    expect(clickProblems({ ...good, focusCalls: 0, showCalls: 0 })).toEqual([
      "the window's focus() was not called by the reveal",
      "the window's show() was not called by the reveal"
    ])
  })
})

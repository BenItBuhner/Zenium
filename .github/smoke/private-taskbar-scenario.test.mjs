import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APP_USER_MODEL_ID,
  PRIVATE_APP_USER_MODEL_ID,
  PRIVATE_DISPLAY_NAME,
  PRIVATE_ICON_FOLDER,
  PRIVATE_TASKBAR_SCENARIO,
  expectedPrivateRelaunchCommand,
  iconResourcePath,
  mainWindowProblems,
  privateWindowProblems,
  quoteWindowsArg
} from './private-taskbar-scenario.mjs'
import * as main from '../../src/main/platform/privateTaskbar'
import { APP_USER_MODEL_ID as MAIN_APP_USER_MODEL_ID } from '../../src/main/platform/notifications'
import { APP_ICON_PRIVATE } from '../../src/shared/appIcon'
import { parseLaunchArgs } from '../../src/shared/launchArgs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Zenium\\Zenium.exe'
const PROFILE = 'D:\\a\\Zenium\\Zenium\\smoke-out\\profiles\\profile-private-taskbar'
const ICO =
  'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Zenium\\resources\\icons\\private\\icon.ico'

describe('the scenario constants', () => {
  it('names the scenario the harness table and both Windows legs of the workflow use', () => {
    expect(PRIVATE_TASKBAR_SCENARIO).toBe('private-taskbar')
    const workflow = read('.github/workflows/desktop-smoke.yml')
    const legs = workflow.match(/--scenarios [a-z,-]*\bprivate-taskbar\b/g) ?? []
    expect(legs).toHaveLength(2)
    expect(read('.github/smoke/smoke.mjs')).toContain('[PRIVATE_TASKBAR_SCENARIO]: () =>')
  })

  it('expects the ids, the name and the icon folder the main process gives a private window', () => {
    expect(APP_USER_MODEL_ID).toBe(MAIN_APP_USER_MODEL_ID)
    expect(PRIVATE_APP_USER_MODEL_ID).toBe(main.PRIVATE_APP_USER_MODEL_ID)
    expect(PRIVATE_APP_USER_MODEL_ID).toBe('io.github.benitbuhner.zenium.private')
    expect(PRIVATE_DISPLAY_NAME).toBe(main.privateRelaunchDisplayName('Zenium'))
    expect(PRIVATE_ICON_FOLDER).toBe(APP_ICON_PRIVATE.folder)
    expect(main.WINDOWS_PRIVATE_APP_ID_KEY).toBe(
      `HKCU\\Software\\Classes\\AppUserModelId\\${PRIVATE_APP_USER_MODEL_ID}`
    )
  })

  it('is read by scripts that name the same key and the same property store', () => {
    const taskbar = read('.github/smoke/win-taskbar.ps1')
    expect(taskbar).toContain('SHGetPropertyStoreForWindow')
    // PKEY_AppUserModel_*: ID (5), RelaunchCommand (2), RelaunchIconResource (3), RelaunchDisplayNameResource (4).
    expect(taskbar).toContain('9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3')
    for (const pid of [2, 3, 4, 5]) expect(taskbar).toMatch(new RegExp(`\\b${pid}\\b`))
    expect(read('.github/smoke/win-install.ps1')).toContain(
      '$PrivateAppIdClassKey = "Software\\Classes\\AppUserModelId\\$AppUserModelId.private"'
    )
    expect(read('build/installer.nsh')).toContain(
      'ZENIUM_PRIVATE_APP_USER_MODEL_ID_KEY "Software\\Classes\\AppUserModelId\\${APP_ID}.private"'
    )
  })
})

describe('the rules the scenario shares with the main process', () => {
  it('expects the relaunch command a packaged build gives, quoted as the main process quotes it', () => {
    const launch = { execPath: EXE, isPackaged: true, appPath: 'unused' }
    for (const dir of [PROFILE, 'D:\\smoke out\\profile', null]) {
      expect(expectedPrivateRelaunchCommand(EXE, dir)).toBe(
        main.privateRelaunchCommand({ ...launch, userDataDir: dir })
      )
    }
    expect(expectedPrivateRelaunchCommand(EXE, null)).toBe(`${EXE} --private-window`)
    expect(expectedPrivateRelaunchCommand(EXE, undefined)).toBe(`${EXE} --private-window`)
    expect(expectedPrivateRelaunchCommand(EXE, 'D:\\smoke out\\profile')).toBe(
      `${EXE} "--user-data-dir=D:\\smoke out\\profile" --private-window`
    )
    expect(expectedPrivateRelaunchCommand('C:\\Program Files\\Zenium\\Zenium.exe', null)).toBe(
      '"C:\\Program Files\\Zenium\\Zenium.exe" --private-window'
    )
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('a "b" c')).toBe('"a \\"b\\" c"')
  })

  it('carries the flag the launch parser reads as a private window', () => {
    expect(main.PRIVATE_WINDOW_SWITCH).toBe('--private-window')
    const command = expectedPrivateRelaunchCommand(EXE, null)
    const argv = command.split(' ').slice(1)
    expect(parseLaunchArgs(argv, 'C:\\').window).toBe('private')
  })

  it('reads the icon resource as Chromium formats it: `<path>,<index>`', () => {
    expect(iconResourcePath(`${ICO},0`)).toBe(ICO)
    expect(iconResourcePath(`${ICO},1`)).toBeNull()
    expect(iconResourcePath(ICO)).toBeNull()
    expect(iconResourcePath(null)).toBeNull()
    expect(iconResourcePath(undefined)).toBeNull()
    expect(iconResourcePath('<vt 0>')).toBeNull()
  })
})

describe('privateWindowProblems', () => {
  const command = expectedPrivateRelaunchCommand(EXE, PROFILE)
  const entry = {
    hwnd: 197412,
    title: 'Zenium (Private Browsing)',
    class: 'Chrome_WidgetWin_1',
    visible: true,
    appUserModelId: PRIVATE_APP_USER_MODEL_ID,
    relaunchCommand: command,
    relaunchIconResource: `${ICO},0`,
    relaunchDisplayName: PRIVATE_DISPLAY_NAME,
    error: null
  }

  it('is silent when the frame carries the group’s facts', () => {
    expect(privateWindowProblems(entry, { command, exists: true })).toEqual([])
    expect(privateWindowProblems(entry, { command })).toEqual([])
    expect(privateWindowProblems(entry)).toEqual([])
  })

  it('names a missing window, an unreadable store, and each value that is not the group’s', () => {
    expect(privateWindowProblems(null, { command })).toEqual([
      'the private window is not among the process’s top-level windows'
    ])
    expect(privateWindowProblems({ ...entry, error: 'E_FAIL' }, { command })).toEqual([
      'the property store could not be read: E_FAIL'
    ])
    expect(privateWindowProblems({ ...entry, appUserModelId: null }, { command })).toEqual([
      `System.AppUserModel.ID is <none>, expected '${PRIVATE_APP_USER_MODEL_ID}'`
    ])
    expect(
      privateWindowProblems({ ...entry, appUserModelId: APP_USER_MODEL_ID }, { command })
    ).toEqual([
      `System.AppUserModel.ID is '${APP_USER_MODEL_ID}', expected '${PRIVATE_APP_USER_MODEL_ID}'`
    ])
    expect(
      privateWindowProblems({ ...entry, relaunchCommand: `${EXE} --private-window` }, { command })
    ).toEqual([`RelaunchCommand is '${EXE} --private-window', expected '${command}'`])
    expect(privateWindowProblems({ ...entry, relaunchDisplayName: 'Zenium' }, { command })).toEqual(
      [`RelaunchDisplayNameResource is 'Zenium', expected '${PRIVATE_DISPLAY_NAME}'`]
    )
  })

  it('requires the icon resource to name the private ICO at index 0, on disk when told', () => {
    expect(privateWindowProblems({ ...entry, relaunchIconResource: null }, { command })).toEqual([
      "RelaunchIconResource is <none>, expected '<ico>,0' naming the private icon"
    ])
    expect(
      privateWindowProblems({ ...entry, relaunchIconResource: `${ICO},1` }, { command })
    ).toEqual([`RelaunchIconResource is '${ICO},1', expected '<ico>,0' naming the private icon`])
    const other = 'C:\\Zenium\\resources\\icons\\indigo\\icon.ico'
    expect(
      privateWindowProblems({ ...entry, relaunchIconResource: `${other},0` }, { command })
    ).toEqual([`RelaunchIconResource names '${other}', not the private icon.ico`])
    expect(privateWindowProblems(entry, { command, exists: false })).toEqual([
      `RelaunchIconResource names '${ICO}', which is not on disk`
    ])
  })
})

describe('mainWindowProblems', () => {
  const entry = {
    hwnd: 66082,
    title: 'Zenium',
    appUserModelId: null,
    relaunchCommand: null,
    relaunchIconResource: null,
    relaunchDisplayName: null,
    error: null
  }

  it('accepts a frame with no id of its own or the app’s, never the private one', () => {
    expect(mainWindowProblems(entry)).toEqual([])
    expect(mainWindowProblems({ ...entry, appUserModelId: APP_USER_MODEL_ID })).toEqual([])
    expect(mainWindowProblems({ ...entry, appUserModelId: PRIVATE_APP_USER_MODEL_ID })).toEqual([
      `the main window's System.AppUserModel.ID is '${PRIVATE_APP_USER_MODEL_ID}', expected none or '${APP_USER_MODEL_ID}'`
    ])
    expect(mainWindowProblems(null)).toEqual([
      'the main window is not among the process’s top-level windows'
    ])
  })
})

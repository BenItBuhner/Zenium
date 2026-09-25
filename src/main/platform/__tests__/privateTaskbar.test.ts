import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PRIVATE_APP_USER_MODEL_ID,
  PRIVATE_WINDOW_SWITCH,
  WINDOWS_PRIVATE_APP_ID_KEY,
  privateAppDetails,
  privateRelaunchCommand,
  privateRelaunchDisplayName,
  type ZeniumLaunch
} from '../privateTaskbar'
import {
  APP_USER_MODEL_ID,
  ensureWindowsAppIdRegistered,
  windowsAppIdKey,
  windowsAppIdQuery,
  windowsAppIdRefresh,
  type WindowsRegistryCommand,
  type WindowsRegistryResult
} from '../notifications'
import { parseLaunchArgs } from '../../../shared/launchArgs'
import { formatWindowTitle } from '../../../shared/windowTitle'
import { NO_WINDOW_SWITCHES, parseCliSwitches, windowSwitchesOf } from '../../cli'

const INSTALLED: ZeniumLaunch = {
  execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe',
  isPackaged: true,
  appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\resources\\app.asar',
  userDataDir: null
}

const PRIVATE_ICO =
  'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\resources\\app.asar.unpacked\\resources\\icons\\private\\icon.ico'

describe('the private windows’ taskbar group', () => {
  it('is a second AppUserModelID: the app’s, suffixed', () => {
    expect(PRIVATE_APP_USER_MODEL_ID).toBe(`${APP_USER_MODEL_ID}.private`)
    expect(PRIVATE_APP_USER_MODEL_ID).toBe('io.github.benitbuhner.zenium.private')
    expect(WINDOWS_PRIVATE_APP_ID_KEY).toBe(windowsAppIdKey(PRIVATE_APP_USER_MODEL_ID))
    expect(WINDOWS_PRIVATE_APP_ID_KEY).toBe(
      'HKCU\\Software\\Classes\\AppUserModelId\\io.github.benitbuhner.zenium.private'
    )
  })

  it('is named as every private window’s title is', () => {
    expect(privateRelaunchDisplayName('Zenium')).toBe('Zenium (Private)')
    // `shared/windowTitle.ts`: `<tab> — Zenium (Private)`; the group's name is the suffix's form.
    expect(formatWindowTitle('Example', true)).toMatch(/Zenium \(Private\)$/)
  })

  it('relaunches this copy with a private window – the flag the launch parser reads', () => {
    expect(privateRelaunchCommand(INSTALLED)).toBe(`${INSTALLED.execPath} --private-window`)
    expect(parseLaunchArgs([PRIVATE_WINDOW_SWITCH], 'C:\\').window).toBe('private')
  })

  it('quotes what has spaces – the exe under Program Files, a profile path – as the RunOnce entry does', () => {
    const spaced = { ...INSTALLED, execPath: 'C:\\Program Files\\Zenium\\Zenium.exe' }
    expect(privateRelaunchCommand(spaced)).toBe(
      '"C:\\Program Files\\Zenium\\Zenium.exe" --private-window'
    )
    const profile = { ...INSTALLED, userDataDir: 'D:\\a\\Zenium\\smoke out\\profiles\\p1' }
    expect(privateRelaunchCommand(profile)).toBe(
      `${INSTALLED.execPath} "--user-data-dir=D:\\a\\Zenium\\smoke out\\profiles\\p1" --private-window`
    )
    const plain = { ...INSTALLED, userDataDir: 'D:\\profiles\\p1' }
    expect(privateRelaunchCommand(plain)).toBe(
      `${INSTALLED.execPath} --user-data-dir=D:\\profiles\\p1 --private-window`
    )
  })

  it('in development names electron and the app’s directory', () => {
    const dev: ZeniumLaunch = {
      execPath: 'D:\\dev\\Zenium\\node_modules\\electron\\dist\\electron.exe',
      isPackaged: false,
      appPath: 'D:\\dev\\Zenium',
      userDataDir: null
    }
    expect(privateRelaunchCommand(dev)).toBe(
      'D:\\dev\\Zenium\\node_modules\\electron\\dist\\electron.exe D:\\dev\\Zenium --private-window'
    )
  })

  it('gives setAppDetails the id, the private ICO and the relaunch', () => {
    expect(privateAppDetails(INSTALLED, 'Zenium', PRIVATE_ICO)).toEqual({
      appId: PRIVATE_APP_USER_MODEL_ID,
      appIconPath: PRIVATE_ICO,
      appIconIndex: 0,
      relaunchCommand: `${INSTALLED.execPath} --private-window`,
      relaunchDisplayName: 'Zenium (Private)'
    })
    // A copy without the icon file leaves the icon to Windows (the exe's) rather than naming a
    // file that is not there.
    expect(privateAppDetails(INSTALLED, 'Zenium', null)).toEqual({
      appId: PRIVATE_APP_USER_MODEL_ID,
      relaunchCommand: `${INSTALLED.execPath} --private-window`,
      relaunchDisplayName: 'Zenium (Private)'
    })
  })

  it('reaches the windows through the window switches: the resolved profile directory', () => {
    expect(NO_WINDOW_SWITCHES.userDataDir).toBeNull()
    expect(windowSwitchesOf(parseCliSwitches([])).userDataDir).toBeNull()
    // The raw switch by default; the resolved directory when the launcher hands it over.
    expect(windowSwitchesOf(parseCliSwitches(['--user-data-dir=p1'])).userDataDir).toBe('p1')
    expect(
      windowSwitchesOf(parseCliSwitches(['--user-data-dir=p1']), 'D:\\work\\p1').userDataDir
    ).toBe('D:\\work\\p1')
  })
})

describe('the private id’s class key', () => {
  const PRIVATE_PNG =
    'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\resources\\app.asar.unpacked\\resources\\icons\\private\\icon.png'

  it('is queried and written under its own key', () => {
    expect(windowsAppIdQuery(PRIVATE_APP_USER_MODEL_ID)).toEqual({
      file: 'reg.exe',
      args: ['query', WINDOWS_PRIVATE_APP_ID_KEY]
    })
    const commands = windowsAppIdRefresh(
      { DisplayName: null, IconUri: null },
      { DisplayName: 'Zenium (Private)', IconUri: PRIVATE_PNG },
      PRIVATE_APP_USER_MODEL_ID
    )
    expect(commands.map((c) => c.args.slice(0, 4))).toEqual([
      ['add', WINDOWS_PRIVATE_APP_ID_KEY, '/v', 'DisplayName'],
      ['add', WINDOWS_PRIVATE_APP_ID_KEY, '/v', 'IconUri']
    ])
  })

  it('registers beside the app’s without touching the app’s key', async () => {
    const ran: WindowsRegistryCommand[] = []
    const run = async (command: WindowsRegistryCommand): Promise<WindowsRegistryResult> => {
      ran.push(command)
      return { ok: command.args[0] !== 'query', stdout: '' }
    }
    const outcome = await ensureWindowsAppIdRegistered(
      'Zenium (Private)',
      PRIVATE_PNG,
      run,
      PRIVATE_APP_USER_MODEL_ID
    )
    expect(outcome).toBe('registered')
    expect(ran.every((c) => c.args[1] === WINDOWS_PRIVATE_APP_ID_KEY)).toBe(true)
    expect(ran.map((c) => c.args[0])).toEqual(['query', 'add', 'add'])
    expect(ran[2].args).toContain(PRIVATE_PNG)
  })

  it('is the second key the uninstaller deletes (build/installer.nsh) and the install smoke flags', () => {
    const nsh = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    expect(nsh).toContain(
      '!define ZENIUM_PRIVATE_APP_USER_MODEL_ID_KEY "Software\\Classes\\AppUserModelId\\${APP_ID}.private"'
    )
    const uninstall = /!macro customUnInstall\n([\s\S]*?)!macroend/.exec(nsh)
    expect(uninstall?.[1]).toContain('DeleteRegKey HKCU "${ZENIUM_PRIVATE_APP_USER_MODEL_ID_KEY}"')
    const ps = readFileSync(join(process.cwd(), '.github', 'smoke', 'win-install.ps1'), 'utf8')
    expect(ps).toContain(
      '$PrivateAppIdClassKey = "Software\\Classes\\AppUserModelId\\$AppUserModelId.private"'
    )
    expect(ps).toContain('if ($reg.privateAppUserModelIdClass) { $left +=')
  })
})

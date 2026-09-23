import { describe, expect, it } from 'vitest'
import {
  NO_WINDOW_SWITCHES,
  describeSwitches,
  droppedSecondInstanceSwitches,
  parseCliSwitches,
  windowLaunchState,
  windowSwitchesOf
} from '../cli'

describe('parseCliSwitches', () => {
  it('reads nothing from a plain launch, URLs and Chromium switches included', () => {
    expect(parseCliSwitches([])).toEqual({
      kiosk: false,
      userDataDir: null,
      restoreLastSession: false,
      startMaximized: false,
      profileDirectory: null
    })
    expect(
      parseCliSwitches(['https://example.com', '--no-sandbox', '--disable-gpu', '-psn_0_1', '--'])
    ).toEqual(parseCliSwitches([]))
  })

  it('reads each of the switches, in any order and case', () => {
    const switches = parseCliSwitches([
      '--start-maximized',
      'https://example.com/',
      '--KIOSK',
      '--restore-last-session',
      '--user-data-dir=/tmp/profile one',
      '--profile-directory=Profile 2'
    ])
    expect(switches).toEqual({
      kiosk: true,
      userDataDir: '/tmp/profile one',
      restoreLastSession: true,
      startMaximized: true,
      profileDirectory: 'Profile 2'
    })
  })

  it('takes the last value of a repeated switch and drops the quotes a shell may leave', () => {
    expect(
      parseCliSwitches(['--user-data-dir=/a', '"--user-data-dir=C:\\Users\\b\\Zenium"']).userDataDir
    ).toBe('C:\\Users\\b\\Zenium')
    expect(parseCliSwitches(['--user-data-dir="/with space/"']).userDataDir).toBe('/with space/')
    expect(parseCliSwitches(['--profile-directory="Default"']).profileDirectory).toBe('Default')
  })

  it('ignores a --user-data-dir without a value, and keeps --profile-directory without one', () => {
    expect(parseCliSwitches(['--user-data-dir']).userDataDir).toBeNull()
    expect(parseCliSwitches(['--user-data-dir=']).userDataDir).toBeNull()
    expect(parseCliSwitches(['--profile-directory']).profileDirectory).toBe('')
  })

  it('does not mistake a URL or a file for a switch', () => {
    const switches = parseCliSwitches(['--kiosk.html', '/tmp/--kiosk', 'kiosk', '--kiosk-mode'])
    expect(switches.kiosk).toBe(false)
  })
})

describe('describeSwitches', () => {
  it('says nothing for a plain launch', () => {
    expect(describeSwitches(parseCliSwitches([]), '/home/u/.config/Zenium')).toEqual([])
  })

  it('names the profile in use, and that --profile-directory does nothing', () => {
    const lines = describeSwitches(
      parseCliSwitches(['--user-data-dir=/tmp/p', '--profile-directory=Profile 2']),
      '/tmp/p'
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('--user-data-dir: the profile is /tmp/p')
    expect(lines[1]).toMatch(/^--profile-directory=Profile 2 ignored: .*one profile.*\/tmp\/p/)
  })

  it('has a line for each window and session switch', () => {
    const lines = describeSwitches(
      parseCliSwitches(['--kiosk', '--start-maximized', '--restore-last-session']),
      '/tmp/p'
    )
    expect(lines.map((l) => l.split(':')[0])).toEqual([
      '--kiosk',
      '--start-maximized',
      '--restore-last-session'
    ])
  })
})

describe('droppedSecondInstanceSwitches', () => {
  it('is null when a second instance carries only URLs and window flags', () => {
    expect(
      droppedSecondInstanceSwitches(parseCliSwitches(['--new-window', 'https://example.com']))
    ).toBeNull()
    // The same user data directory reaches the same instance: nothing to name for it.
    expect(droppedSecondInstanceSwitches(parseCliSwitches(['--user-data-dir=/tmp/p']))).toBeNull()
  })

  it('names the switches the running instance does not take over', () => {
    const line = droppedSecondInstanceSwitches(
      parseCliSwitches(['--kiosk', '--restore-last-session', '--profile-directory=Default'])
    )
    expect(line).toBe(
      '--kiosk, --restore-last-session, --profile-directory from a second instance: the running instance keeps its own mode'
    )
  })
})

describe('windowLaunchState', () => {
  const plain = { chrome: 'full' as const, maximized: false }

  it('comes up as saved without switches', () => {
    expect(windowLaunchState(NO_WINDOW_SWITCHES, plain)).toEqual({ kiosk: false, maximize: false })
    expect(windowLaunchState(NO_WINDOW_SWITCHES, { ...plain, maximized: true })).toEqual({
      kiosk: false,
      maximize: true
    })
    expect(windowSwitchesOf(parseCliSwitches([]))).toEqual(NO_WINDOW_SWITCHES)
  })

  it('maximises a browser window under --start-maximized, never a popup or an app window', () => {
    const switches = windowSwitchesOf(parseCliSwitches(['--start-maximized']))
    expect(windowLaunchState(switches, plain)).toEqual({ kiosk: false, maximize: true })
    expect(windowLaunchState(switches, { chrome: 'popup', maximized: false }).maximize).toBe(false)
    expect(windowLaunchState(switches, { chrome: 'app', maximized: false }).maximize).toBe(false)
    // A popup saved maximised (it never is, but the flag is the persisted one's) still is.
    expect(windowLaunchState(switches, { chrome: 'app', maximized: true }).maximize).toBe(true)
  })

  it('makes a browser window a kiosk under --kiosk, fullscreen over any maximise', () => {
    const switches = windowSwitchesOf(parseCliSwitches(['--kiosk', '--start-maximized']))
    expect(windowLaunchState(switches, plain)).toEqual({ kiosk: true, maximize: false })
    expect(windowLaunchState(switches, { ...plain, maximized: true })).toEqual({
      kiosk: true,
      maximize: false
    })
    expect(windowLaunchState(switches, { chrome: 'popup', maximized: false })).toEqual({
      kiosk: false,
      maximize: false
    })
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_USER_MODEL_ID,
  WINDOWS_APP_ID_KEY,
  ensureWindowsAppIdRegistered,
  notificationPermissionStatus,
  windowsAppIdRegistration,
  type WindowsRegistryCommand
} from '../notifications'
import { PermissionService } from '../../../core/permissions'
import type { PermissionPromptHost, StoreIO } from '../../../core/platform'

function fakeIo(): StoreIO {
  return { readSync: () => null, write: async () => undefined, writeSync: () => undefined }
}

const NEVER_ASKED: PermissionPromptHost = {
  show: async () => {
    throw new Error('a status question must not prompt')
  },
  cancel: () => undefined
}

describe('Windows app id', () => {
  it('is the id electron-builder stamps on the installer’s shortcuts', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm'))
  })

  it('registers display name and icon under the user’s AppUserModelId class', () => {
    const { query, writes } = windowsAppIdRegistration('Zenium', 'C:\\Zenium\\icon.png')
    expect(WINDOWS_APP_ID_KEY).toBe(
      'HKCU\\Software\\Classes\\AppUserModelId\\io.github.benitbuhner.zenium'
    )
    expect(query).toEqual({
      file: 'reg.exe',
      args: ['query', WINDOWS_APP_ID_KEY, '/v', 'DisplayName']
    })
    expect(writes.map((w) => w.args)).toEqual([
      ['add', WINDOWS_APP_ID_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Zenium', '/f'],
      [
        'add',
        WINDOWS_APP_ID_KEY,
        '/v',
        'IconUri',
        '/t',
        'REG_SZ',
        '/d',
        'C:\\Zenium\\icon.png',
        '/f'
      ]
    ])
    expect(windowsAppIdRegistration('Zenium', null).writes).toHaveLength(1)
  })

  it('writes the registration once: an existing one (installer or earlier run) is left alone', async () => {
    const ran: WindowsRegistryCommand[] = []
    const registry = new Set<string>()
    const run = async (command: WindowsRegistryCommand): Promise<boolean> => {
      ran.push(command)
      if (command.args[0] === 'query') return registry.has('DisplayName')
      registry.add(command.args[3])
      return true
    }
    expect(await ensureWindowsAppIdRegistered('Zenium', null, run)).toBe(true)
    expect(ran.map((c) => c.args[0])).toEqual(['query', 'add'])
    expect(await ensureWindowsAppIdRegistered('Zenium', null, run)).toBe(false)
    expect(ran.map((c) => c.args[0])).toEqual(['query', 'add', 'query'])
  })

  it('gives up quietly when the registry refuses', async () => {
    const run = async (command: WindowsRegistryCommand): Promise<boolean> =>
      command.args[0] === 'query' ? false : false
    expect(await ensureWindowsAppIdRegistered('Zenium', 'icon.png', run)).toBe(false)
  })
})

describe('Notification.permission for a page', () => {
  it('reads default for an undecided site, granted and denied for decided ones, denied off the web', () => {
    const permissions = new PermissionService(fakeIo(), NEVER_ASKED)
    expect(notificationPermissionStatus(permissions, 'https://a.example/page')).toBe('default')
    permissions.set('notifications', 'https://a.example', 'allow')
    expect(notificationPermissionStatus(permissions, 'https://a.example/other')).toBe('granted')
    permissions.set('notifications', 'https://a.example', 'deny')
    expect(notificationPermissionStatus(permissions, 'https://a.example/')).toBe('denied')
    expect(notificationPermissionStatus(permissions, '')).toBe('denied')
    expect(notificationPermissionStatus(permissions, 'about:blank')).toBe('denied')
  })

  it('follows the user’s default for notifications', () => {
    const permissions = new PermissionService(fakeIo(), NEVER_ASKED)
    permissions.chooseDefault('notifications', 'deny')
    expect(notificationPermissionStatus(permissions, 'https://b.example/')).toBe('denied')
    permissions.chooseDefault('notifications', 'ask')
    expect(notificationPermissionStatus(permissions, 'https://b.example/')).toBe('default')
  })
})

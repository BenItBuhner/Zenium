import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_USER_MODEL_ID,
  WINDOWS_APP_ID_KEY,
  WINDOWS_APP_ID_QUERY,
  ensureWindowsAppIdRegistered,
  notificationPermissionStatus,
  parseWindowsAppIdKey,
  windowsAppIdRefresh,
  windowsAppIdValues,
  type WindowsRegistryCommand,
  type WindowsRegistryResult
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

const UNPACKED_ICON = 'D:\\a\\Zenium\\dist\\win-unpacked\\resources\\icons\\indigo\\icon.png'
const INSTALLED_ICON =
  'C:\\Users\\me\\AppData\\Local\\Programs\\zenium\\resources\\icons\\indigo\\icon.png'

/**
 * A registry of one key, answering reg.exe the way Windows does: `query` lists the values under
 * the key's header (four-space columns, CRLF) and fails when the key is absent; `add` creates the
 * key; `delete` removes one value. `ran` keeps the commands in order; `refuse` makes every
 * command fail.
 */
type FakeRegistry = {
  ran: WindowsRegistryCommand[]
  refuse: boolean
  readonly values: Record<string, string> | null
  run: (command: WindowsRegistryCommand) => Promise<WindowsRegistryResult>
}

function fakeRegistry(initial: Record<string, string> | null = null): FakeRegistry {
  let values: Map<string, string> | null = initial ? new Map(Object.entries(initial)) : null
  const ran: WindowsRegistryCommand[] = []
  const registry: FakeRegistry = {
    ran,
    refuse: false,
    get values(): Record<string, string> | null {
      return values ? Object.fromEntries(values) : null
    },
    run: async (command: WindowsRegistryCommand): Promise<WindowsRegistryResult> => {
      ran.push(command)
      if (registry.refuse) return { ok: false, stdout: '' }
      expect(command.file).toBe('reg.exe')
      expect(command.args[1]).toBe(WINDOWS_APP_ID_KEY)
      switch (command.args[0]) {
        case 'query': {
          if (!values) return { ok: false, stdout: '' }
          const lines = [...values].map(([name, data]) => `    ${name}    REG_SZ    ${data}`)
          return {
            ok: true,
            stdout: `\r\nHKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}\r\n${lines.join('\r\n')}\r\n\r\n`
          }
        }
        case 'add': {
          expect(command.args.slice(2)).toEqual([
            '/v',
            command.args[3],
            '/t',
            'REG_SZ',
            '/d',
            command.args[7],
            '/f'
          ])
          values ??= new Map()
          values.set(command.args[3], command.args[7])
          return { ok: true, stdout: 'The operation completed successfully.\r\n' }
        }
        case 'delete': {
          expect(command.args.slice(2)).toEqual(['/v', command.args[3], '/f'])
          values?.delete(command.args[3])
          return { ok: true, stdout: 'The operation completed successfully.\r\n' }
        }
        default:
          throw new Error(`unexpected reg.exe verb ${command.args[0]}`)
      }
    }
  }
  return registry
}

const verbs = (ran: WindowsRegistryCommand[]): string[] =>
  ran.map((c) => (c.args[0] === 'query' ? 'query' : `${c.args[0]} ${c.args[3]}`))

describe('Windows app id', () => {
  it('is the id electron-builder stamps on the installer’s shortcuts', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm'))
  })

  it('reads the whole key in one query and parses reg.exe’s listing', () => {
    expect(WINDOWS_APP_ID_KEY).toBe(
      'HKCU\\Software\\Classes\\AppUserModelId\\io.github.benitbuhner.zenium'
    )
    expect(WINDOWS_APP_ID_QUERY).toEqual({ file: 'reg.exe', args: ['query', WINDOWS_APP_ID_KEY] })
    const listing = [
      '',
      `HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`,
      '    DisplayName    REG_SZ    Zenium',
      '    IconUri    REG_SZ    C:\\Program Files\\Zenium\\resources\\icons\\indigo\\icon.png',
      '    Unrelated    REG_DWORD    0x1',
      '',
      ''
    ].join('\r\n')
    expect(parseWindowsAppIdKey({ ok: true, stdout: listing })).toEqual({
      DisplayName: 'Zenium',
      IconUri: 'C:\\Program Files\\Zenium\\resources\\icons\\indigo\\icon.png'
    })
    // A key without the values, and an absent key (reg.exe fails).
    expect(
      parseWindowsAppIdKey({ ok: true, stdout: `\r\nHKEY_CURRENT_USER\\...\r\n\r\n` })
    ).toEqual({ DisplayName: null, IconUri: null })
    expect(parseWindowsAppIdKey({ ok: false, stdout: '' })).toBeNull()
  })

  it('writes only what differs: nothing for an equal pair, a value per difference, a removal for an icon the build lacks', () => {
    const wanted = windowsAppIdValues('Zenium', INSTALLED_ICON)
    expect(wanted).toEqual({ DisplayName: 'Zenium', IconUri: INSTALLED_ICON })
    expect(windowsAppIdRefresh(wanted, wanted)).toEqual([])
    expect(
      windowsAppIdRefresh({ DisplayName: 'Zenium', IconUri: UNPACKED_ICON }, wanted).map(
        (c) => c.args
      )
    ).toEqual([
      ['add', WINDOWS_APP_ID_KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', INSTALLED_ICON, '/f']
    ])
    expect(
      windowsAppIdRefresh({ DisplayName: null, IconUri: null }, wanted).map((c) => c.args)
    ).toEqual([
      ['add', WINDOWS_APP_ID_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Zenium', '/f'],
      ['add', WINDOWS_APP_ID_KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', INSTALLED_ICON, '/f']
    ])
    expect(
      windowsAppIdRefresh(
        { DisplayName: 'Zenium', IconUri: UNPACKED_ICON },
        windowsAppIdValues('Zenium', null)
      ).map((c) => c.args)
    ).toEqual([['delete', WINDOWS_APP_ID_KEY, '/v', 'IconUri', '/f']])
    expect(
      windowsAppIdRefresh({ DisplayName: null, IconUri: null }, windowsAppIdValues('Zenium', null))
    ).toHaveLength(1)
  })

  it('registers an absent key: display name and icon under the user’s AppUserModelId class', async () => {
    const registry = fakeRegistry()
    expect(await ensureWindowsAppIdRegistered('Zenium', UNPACKED_ICON, registry.run)).toBe(
      'registered'
    )
    expect(verbs(registry.ran)).toEqual(['query', 'add DisplayName', 'add IconUri'])
    expect(registry.values).toEqual({ DisplayName: 'Zenium', IconUri: UNPACKED_ICON })
  })

  it('leaves an equal registration alone: one read, no write', async () => {
    const registry = fakeRegistry({ DisplayName: 'Zenium', IconUri: UNPACKED_ICON })
    expect(await ensureWindowsAppIdRegistered('Zenium', UNPACKED_ICON, registry.run)).toBe(
      'current'
    )
    expect(verbs(registry.ran)).toEqual(['query'])
    // And again: idempotent across starts.
    expect(await ensureWindowsAppIdRegistered('Zenium', UNPACKED_ICON, registry.run)).toBe(
      'current'
    )
    expect(verbs(registry.ran)).toEqual(['query', 'query'])
  })

  it('refreshes a stale registration: the installed build replaces the unpacked copy’s icon path', async () => {
    const registry = fakeRegistry({ DisplayName: 'Zenium', IconUri: UNPACKED_ICON })
    expect(await ensureWindowsAppIdRegistered('Zenium', INSTALLED_ICON, registry.run)).toBe(
      'refreshed'
    )
    expect(verbs(registry.ran)).toEqual(['query', 'add IconUri'])
    expect(registry.values).toEqual({ DisplayName: 'Zenium', IconUri: INSTALLED_ICON })
    // The next start finds its own values.
    expect(await ensureWindowsAppIdRegistered('Zenium', INSTALLED_ICON, registry.run)).toBe(
      'current'
    )
    expect(verbs(registry.ran)).toEqual(['query', 'add IconUri', 'query'])
  })

  it('refreshes a display name that changed and fills a value the key lacks', async () => {
    const registry = fakeRegistry({ DisplayName: 'Zen' })
    expect(await ensureWindowsAppIdRegistered('Zenium', INSTALLED_ICON, registry.run)).toBe(
      'refreshed'
    )
    expect(verbs(registry.ran)).toEqual(['query', 'add DisplayName', 'add IconUri'])
    expect(registry.values).toEqual({ DisplayName: 'Zenium', IconUri: INSTALLED_ICON })
  })

  it('drops an icon path when this copy ships no icon file', async () => {
    const registry = fakeRegistry({ DisplayName: 'Zenium', IconUri: UNPACKED_ICON })
    expect(await ensureWindowsAppIdRegistered('Zenium', null, registry.run)).toBe('refreshed')
    expect(verbs(registry.ran)).toEqual(['query', 'delete IconUri'])
    expect(registry.values).toEqual({ DisplayName: 'Zenium' })
    expect(await ensureWindowsAppIdRegistered('Zenium', null, registry.run)).toBe('current')
  })

  it('gives up quietly when the registry refuses', async () => {
    const registry = fakeRegistry()
    registry.refuse = true
    expect(await ensureWindowsAppIdRegistered('Zenium', 'icon.png', registry.run)).toBe('failed')
    // The query failed (read as absent), the first write failed: no second write attempted.
    expect(verbs(registry.ran)).toEqual(['query', 'add DisplayName'])
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

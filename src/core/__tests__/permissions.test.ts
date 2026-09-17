import { describe, expect, it } from 'vitest'
import type { DialogHost, StoreIO } from '../platform'
import { PermissionService, type PermissionChange } from '../permissions'

function memoryIo(): StoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
}

function service(answer = true): {
  permissions: PermissionService
  io: ReturnType<typeof memoryIo>
  prompts: string[]
} {
  const io = memoryIo()
  const prompts: string[] = []
  const dialogs = {
    confirm: async (options: { message: string }) => {
      prompts.push(options.message)
      return answer
    }
  } as unknown as DialogHost
  return { permissions: new PermissionService(io, dialogs), io, prompts }
}

describe('PermissionService content settings', () => {
  it('stores per-origin decisions without prompting, keyed origin|permission', async () => {
    const { permissions, io, prompts } = service()
    const changes: PermissionChange[] = []
    permissions.subscribe((c) => changes.push(c))

    permissions.set('ads', 'https://news.example/some/page', 'allow')
    expect(permissions.get('ads', 'https://news.example/')).toBe('allow')
    expect(permissions.get('ads', 'https://other.example/')).toBeUndefined()
    expect(permissions.check('ads', 'https://news.example/')).toBe(true)
    expect(permissions.check('ads', 'https://other.example/')).toBe(false)
    expect(prompts).toEqual([])
    expect(changes).toEqual([{ permission: 'ads', origin: 'https://news.example' }])

    // Unchanged values do not write or notify; null forgets.
    permissions.set('ads', 'https://news.example', 'allow')
    expect(changes).toHaveLength(1)
    permissions.set('ads', 'not a url', 'allow')
    permissions.set('ads', 'about:blank', 'allow')
    expect(permissions.listForPermission('ads')).toEqual([
      { origin: 'https://news.example', decision: 'allow' }
    ])
    permissions.set('ads', 'https://news.example', null)
    expect(permissions.get('ads', 'https://news.example')).toBeUndefined()
    expect(changes).toHaveLength(2)

    // The document on disk carries the same keys the site-information sheet reads.
    permissions.set('ads', 'https://a.example', 'allow')
    permissions.set('geolocation', 'https://a.example', 'deny')
    await (permissions as unknown as { store: { flush(): Promise<void> } }).store.flush()
    expect(JSON.parse(io.files.get('permissions.json') ?? '{}')).toEqual({
      version: 1,
      decisions: { 'https://a.example|ads': 'allow', 'https://a.example|geolocation': 'deny' }
    })
    expect(permissions.listForOrigin('https://a.example')).toEqual([
      { permission: 'ads', decision: 'allow' },
      { permission: 'geolocation', decision: 'deny' }
    ])
  })

  it('keeps a default per permission that origins without a decision inherit', async () => {
    const { permissions, prompts } = service(false)
    const changes: PermissionChange[] = []
    permissions.subscribe((c) => changes.push(c))
    expect(permissions.defaultFor('ads')).toBeUndefined()

    permissions.setDefault('ads', 'allow')
    expect(permissions.defaultFor('ads')).toBe('allow')
    expect(permissions.check('ads', 'https://any.example/')).toBe(true)
    expect(await permissions.decide('ads', 'https://any.example/')).toBe(true)
    expect(prompts).toEqual([])
    expect(changes).toEqual([{ permission: 'ads', origin: null }])

    // A per-origin decision beats the default; the default never shows up as an origin.
    permissions.set('ads', 'https://strict.example', 'deny')
    expect(permissions.check('ads', 'https://strict.example/')).toBe(false)
    expect(permissions.listForPermission('ads')).toEqual([
      { origin: 'https://strict.example', decision: 'deny' }
    ])
    expect(permissions.listForOrigin('https://strict.example')).toEqual([
      { permission: 'ads', decision: 'deny' }
    ])

    permissions.setDefault('ads', null)
    expect(permissions.defaultFor('ads')).toBeUndefined()
    expect(permissions.check('ads', 'https://any.example/')).toBe(false)
  })

  it('notifies subscribers when the site-information sheet resets an origin', () => {
    const { permissions } = service()
    permissions.set('ads', 'https://a.example', 'allow')
    permissions.set('camera', 'https://a.example', 'allow')
    permissions.set('ads', 'https://b.example', 'allow')
    const changes: PermissionChange[] = []
    const unsubscribe = permissions.subscribe((c) => changes.push(c))

    permissions.resetOrigin('https://a.example', 'camera')
    expect(changes).toEqual([{ permission: 'camera', origin: 'https://a.example' }])
    permissions.resetOrigin('https://a.example')
    expect(changes).toEqual([
      { permission: 'camera', origin: 'https://a.example' },
      { permission: 'ads', origin: 'https://a.example' }
    ])
    expect(permissions.listForPermission('ads')).toEqual([
      { origin: 'https://b.example', decision: 'allow' }
    ])
    // Nothing to forget: no write, no notification.
    permissions.resetOrigin('https://a.example')
    expect(changes).toHaveLength(2)

    unsubscribe()
    permissions.reset()
    expect(changes).toHaveLength(2)
    expect(permissions.listForPermission('ads')).toEqual([])
  })

  it('still prompts once for the prompted permissions and remembers the answer', async () => {
    const { permissions, prompts } = service(true)
    const changes: PermissionChange[] = []
    permissions.subscribe((c) => changes.push(c))
    expect(await permissions.decide('camera', 'https://meet.example/room')).toBe(true)
    expect(await permissions.decide('camera', 'https://meet.example/other')).toBe(true)
    expect(prompts).toEqual(['Allow https://meet.example to use your camera?'])
    expect(changes).toEqual([{ permission: 'camera', origin: 'https://meet.example' }])
    expect(permissions.get('camera', 'https://meet.example')).toBe('allow')
  })
})

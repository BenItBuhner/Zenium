import { describe, expect, it } from 'vitest'
import type { ConfirmOptions, DialogHost, StoreIO } from '../platform'
import {
  PermissionService,
  decisionKey,
  permissionPromptCopy,
  qualifiedPermission,
  schemeOf,
  type PermissionChange
} from '../permissions'

function fakeIo(initial: string | null = null): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => initial,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function dialogs(answer: boolean | ((o: ConfirmOptions) => boolean)): DialogHost & {
  asked: ConfirmOptions[]
} {
  const host = {
    asked: [] as ConfirmOptions[],
    confirm: async (options: ConfirmOptions) => {
      host.asked.push(options)
      return typeof answer === 'function' ? answer(options) : answer
    },
    pickTextFiles: async () => [],
    saveTextFile: async () => false
  }
  return host
}

const PAGE = 'https://example.com/page'

describe('PermissionService: what is asked', () => {
  it('no longer hands out file system, storage access, window management or idle detection', async () => {
    const d = dialogs(false)
    const p = new PermissionService(fakeIo(), d)
    for (const permission of [
      'fileSystem',
      'storage-access',
      'top-level-storage-access',
      'window-management',
      'idle-detection'
    ]) {
      expect(p.check(permission, 'https://example.com')).toBe(false)
      expect(await p.decide(permission, PAGE)).toBe(false)
    }
    expect(d.asked.length).toBe(5)
  })

  it('still grants the harmless set without a prompt and denies the exotic set', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('fullscreen', PAGE)).toBe(true)
    expect(await p.decide('pointerLock', PAGE)).toBe(true)
    expect(await p.decide('usb', PAGE)).toBe(false)
    expect(await p.decide('display-capture', PAGE)).toBe(false)
    expect(d.asked).toEqual([])
  })

  it('remembers the answer per origin and permission', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('idle-detection', PAGE)).toBe(true)
    expect(await p.decide('idle-detection', 'https://example.com/other')).toBe(true)
    expect(d.asked.length).toBe(1)
    expect(p.check('idle-detection', 'https://example.com')).toBe(true)
    expect(p.check('idle-detection', 'https://other.example')).toBe(false)
    expect(await p.decide('window-management', PAGE)).toBe(true)
    expect(d.asked.length).toBe(2)
  })

  it('collapses concurrent requests for the same key into one prompt', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    const [a, b] = await Promise.all([p.decide('camera', PAGE), p.decide('camera', PAGE)])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(d.asked.length).toBe(1)
  })

  it('never asks for pop-ups: they are a stored allow or nothing', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('popups', PAGE)).toBe(false)
    expect(d.asked).toEqual([])
    p.remember('popups', PAGE, 'allow')
    expect(await p.decide('popups', PAGE)).toBe(true)
    expect(p.stored('popups', 'https://example.com/')).toBe('allow')
    p.forget('popups', PAGE)
    expect(p.stored('popups', PAGE)).toBeNull()
  })

  it('refuses opaque and unparsable origins', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('camera', 'not a url')).toBe(false)
    expect(await p.decide('camera', 'data:text/html,hi')).toBe(false)
    p.remember('popups', 'about:blank', 'allow')
    expect(p.rules()).toEqual([])
  })
})

describe('PermissionService: external applications', () => {
  it('keeps one answer per scheme and forgets a refusal', async () => {
    let answer = false
    const d = dialogs(() => answer)
    const p = new PermissionService(fakeIo(), d)
    const zoom = { externalUrl: 'zoommtg://zoom.us/join?confno=1' }
    expect(await p.decide('openExternal', PAGE, zoom)).toBe(false)
    // Cancelling is not remembered: the site may ask again.
    expect(await p.decide('openExternal', PAGE, zoom)).toBe(false)
    expect(d.asked.length).toBe(2)
    answer = true
    expect(await p.decide('openExternal', PAGE, zoom)).toBe(true)
    expect(await p.decide('openExternal', PAGE, zoom)).toBe(true)
    expect(d.asked.length).toBe(3)
    // A different scheme from the same site is a new question.
    expect(await p.decide('openExternal', PAGE, { externalUrl: 'mailto:a@b.c' })).toBe(true)
    expect(d.asked.length).toBe(4)
    expect(p.rules()).toEqual([
      { origin: 'https://example.com', permission: 'openExternal:mailto', decision: 'allow' },
      { origin: 'https://example.com', permission: 'openExternal:zoommtg', decision: 'allow' }
    ])
  })

  it('names the app or the scheme in the prompt', () => {
    const named = permissionPromptCopy('openExternal', 'https://example.com', {
      externalUrl: 'intent://scan/#Intent;scheme=zxing;package=com.example.scanner;end',
      targetApp: 'Barcode Scanner'
    })
    expect(named.message).toBe('Allow example.com to open Barcode Scanner?')
    expect(named.okLabel).toBe('Open')
    expect(named.detail).toContain('Zenium')
    const scheme = permissionPromptCopy('openExternal', 'https://example.com', {
      externalUrl: 'zoommtg://zoom.us/join'
    })
    expect(scheme.message).toBe('Allow example.com to open zoommtg: links in another app?')
    expect(scheme.detail).toContain('remembered for zoommtg: links on this site')
  })
})

describe('PermissionService: qualified keys and prompt copy', () => {
  it('qualifies storage access by the embedding site', () => {
    expect(
      qualifiedPermission('storage-access', { embedderUrl: 'https://news.example/article' })
    ).toBe('storage-access:https://news.example')
    expect(qualifiedPermission('storage-access', {})).toBe('storage-access')
    expect(decisionKey('https://tracker.example', 'camera')).toBe('https://tracker.example|camera')
    expect(schemeOf('MAILTO:x@y.z')).toBe('mailto')
    expect(schemeOf('no scheme')).toBe('')
  })

  it('keeps storage access grants apart per embedder', async () => {
    const d = dialogs(true)
    const p = new PermissionService(fakeIo(), d)
    const inNews = { embedderUrl: 'https://news.example/' }
    const inShop = { embedderUrl: 'https://shop.example/' }
    expect(await p.decide('storage-access', 'https://social.example/embed', inNews)).toBe(true)
    expect(await p.decide('storage-access', 'https://social.example/embed', inNews)).toBe(true)
    expect(d.asked.length).toBe(1)
    expect(await p.decide('storage-access', 'https://social.example/embed', inShop)).toBe(true)
    expect(d.asked.length).toBe(2)
    expect(d.asked[0].message).toBe(
      'Allow social.example to use cookies and site data it has stored while you are on news.example?'
    )
    expect(p.check('storage-access', 'https://social.example', inNews)).toBe(true)
    expect(
      p.check('storage-access', 'https://social.example', { embedderUrl: 'https://x.example' })
    ).toBe(false)
  })

  it('describes file system access by file and direction', () => {
    const write = permissionPromptCopy('fileSystem', 'https://editor.example', {
      filePath: '/home/me/notes/todo.txt',
      isDirectory: false,
      fileAccessType: 'writable'
    })
    expect(write.message).toBe('Allow editor.example to save changes to "todo.txt"?')
    expect(write.okLabel).toBe('Save changes')
    const read = permissionPromptCopy('fileSystem', 'https://editor.example', {
      filePath: 'C:\\Users\\me\\Projects\\',
      isDirectory: true,
      fileAccessType: 'readable'
    })
    expect(read.message).toBe('Allow editor.example to view the files in "Projects"?')
    expect(read.okLabel).toBe('View files')
  })

  it('has labels for the newly prompted permissions', () => {
    expect(permissionPromptCopy('window-management', 'https://a.example').message).toBe(
      'Allow a.example to manage windows on all your displays?'
    )
    expect(permissionPromptCopy('idle-detection', 'https://a.example').message).toBe(
      'Allow a.example to know when you are actively using this device?'
    )
    expect(permissionPromptCopy('top-level-storage-access', 'https://a.example').message).toContain(
      'embedded in it'
    )
    expect(permissionPromptCopy('something-new', 'http://a.example').message).toBe(
      'Allow http://a.example to use "something-new"?'
    )
  })
})

describe('PermissionService: persistence and rules', () => {
  it('loads stored decisions and lists them as rules', () => {
    const io = fakeIo(
      JSON.stringify({
        version: 1,
        decisions: {
          'https://b.example|popups': 'allow',
          'https://a.example|camera': 'deny'
        }
      })
    )
    const p = new PermissionService(io, dialogs(true))
    expect(p.check('camera', 'https://a.example')).toBe(false)
    expect(p.stored('popups', 'https://b.example/x')).toBe('allow')
    expect(p.rules()).toEqual([
      { origin: 'https://a.example', permission: 'camera', decision: 'deny' },
      { origin: 'https://b.example', permission: 'popups', decision: 'allow' }
    ])
    p.forgetRule('https://a.example', 'camera')
    expect(p.rules().length).toBe(1)
    p.reset()
    expect(p.rules()).toEqual([])
  })

  it('tells listeners which decision changed', async () => {
    const p = new PermissionService(fakeIo(), dialogs(true))
    const changes: PermissionChange[] = []
    const off = p.subscribe((c) => changes.push(c))
    p.remember('popups', PAGE, 'allow')
    await p.decide('camera', PAGE)
    await p.decide('openExternal', PAGE, { externalUrl: 'tel:+15550100' })
    p.forget('popups', PAGE)
    p.forget('popups', PAGE)
    expect(changes).toEqual([
      { permission: 'popups', origin: 'https://example.com' },
      { permission: 'camera', origin: 'https://example.com' },
      { permission: 'openExternal:tel', origin: 'https://example.com' },
      { permission: 'popups', origin: 'https://example.com' }
    ])
    off()
    p.reset()
    expect(changes).toHaveLength(4)
  })

  it('keeps a permission default out of the site rules but lets it answer for a site', () => {
    const p = new PermissionService(fakeIo(), dialogs(true))
    p.setDefault('ads', 'allow')
    expect(p.rules()).toEqual([])
    expect(p.stored('ads', PAGE)).toBe('allow')
    p.remember('ads', PAGE, 'deny')
    expect(p.stored('ads', PAGE)).toBe('deny')
    expect(p.rules()).toEqual([
      { origin: 'https://example.com', permission: 'ads', decision: 'deny' }
    ])
  })
})

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
    expect(prompts).toEqual(['Allow meet.example to use your camera?'])
    expect(changes).toEqual([{ permission: 'camera', origin: 'https://meet.example' }])
    expect(permissions.get('camera', 'https://meet.example')).toBe('allow')
  })
})

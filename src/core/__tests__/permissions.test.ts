import { describe, expect, it } from 'vitest'
import type { PermissionPromptHost, StoreIO } from '../platform'
import type { PermissionPrompt, PermissionPromptAnswer } from '../../shared/types'
import {
  DISMISSALS_BEFORE_BLOCK,
  PermissionService,
  decisionKey,
  displayOrigin,
  permissionPromptCopy,
  permissionSite,
  qualifiedPermission,
  schemeOf,
  type PermissionChange,
  type PermissionRequestDetails
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

type Answer = PermissionPromptAnswer | boolean

/** The chrome's side of a prompt: records what was asked and answers as told (true = Allow). */
function prompts(
  answer: Answer | ((request: PermissionPrompt) => Answer)
): PermissionPromptHost & { asked: PermissionPrompt[] } {
  const host = {
    asked: [] as PermissionPrompt[],
    show: async (request: PermissionPrompt): Promise<PermissionPromptAnswer | null> => {
      host.asked.push(request)
      const a = typeof answer === 'function' ? answer(request) : answer
      return a === true ? 'allow' : a === false ? 'block' : a
    },
    cancel: () => undefined
  }
  return host
}

const PAGE = 'https://example.com/page'

describe('PermissionService: what is asked', () => {
  it('no longer hands out file system, storage access, window management or idle detection', async () => {
    const d = prompts(false)
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
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('fullscreen', PAGE)).toBe(true)
    expect(await p.decide('pointerLock', PAGE)).toBe(true)
    expect(await p.decide('usb', PAGE)).toBe(false)
    // Screen sharing has no prompt of its own: the picker (MW-19) is where the user decides.
    expect(await p.decide('display-capture', PAGE)).toBe(true)
    expect(await p.decide('midiSysex', PAGE)).toBe(false)
    expect(d.asked).toEqual([])
  })

  it('remembers the answer per origin and permission', async () => {
    const d = prompts(true)
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
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    const [a, b] = await Promise.all([p.decide('camera', PAGE), p.decide('camera', PAGE)])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(d.asked.length).toBe(1)
  })

  it('never asks for pop-ups: they are a stored allow or nothing', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('popups', PAGE)).toBe(false)
    expect(d.asked).toEqual([])
    p.remember('popups', PAGE, 'allow')
    expect(await p.decide('popups', PAGE)).toBe(true)
    expect(p.stored('popups', 'https://example.com/')).toBe('allow')
    p.forget('popups', PAGE)
    expect(p.stored('popups', PAGE)).toBeNull()
  })

  it('refuses opaque and unparsable origins whatever a site would be asked about', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('camera', 'not a url')).toBe(false)
    expect(await p.decide('camera', 'data:text/html,hi')).toBe(false)
    expect(await p.decide('geolocation', 'zen://settings')).toBe(false)
    expect(await p.decide('media', 'chrome-error://chromewebdata/')).toBe(false)
    expect(p.check('notifications', 'about:blank')).toBe(false)
    expect(d.asked).toEqual([])
    p.remember('popups', 'about:blank', 'allow')
    p.set('geolocation', 'zen://settings', 'allow')
    expect(p.rules()).toEqual([])
    expect(p.stored('popups', 'about:blank')).toBeNull()
  })

  it('grants pages without a site what the catalogue grants without a prompt', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    for (const url of ['zen://settings', 'chrome-error://chromewebdata/', 'about:blank']) {
      expect(await p.decide('fullscreen', url)).toBe(true)
      expect(p.check('pointerLock', url)).toBe(true)
      expect(p.resolve('keyboardLock', url)).toBe('allow')
      expect(p.check('screen-wake-lock', url)).toBe(true)
      expect(await p.decide('usb', url)).toBe(false)
    }
    // Not a URL at all: nothing, as before.
    expect(await p.decide('fullscreen', 'not a url')).toBe(false)
    expect(p.check('fullscreen', '')).toBe(false)
    // The user's default for the permission still rules such pages.
    p.chooseDefault('fullscreen', 'deny')
    expect(await p.decide('fullscreen', 'zen://settings')).toBe(false)
    expect(d.asked).toEqual([])
  })
})

describe('PermissionService: local files', () => {
  const FILE_PAGE = 'file:///home/me/pages/index.html'

  it('enters fullscreen and locks the pointer from a local file, as Chrome allows', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('fullscreen', FILE_PAGE)).toBe(true)
    expect(await p.decide('pointerLock', FILE_PAGE)).toBe(true)
    expect(await p.decide('keyboardLock', FILE_PAGE)).toBe(true)
    expect(await p.decide('clipboard-sanitized-write', FILE_PAGE)).toBe(true)
    // The engine's check handler asks with the origin URL Chromium gives a file: page.
    expect(p.check('fullscreen', 'file:///')).toBe(true)
    expect(await p.decide('usb', FILE_PAGE)).toBe(false)
    expect(d.asked).toEqual([])
    p.chooseDefault('fullscreen', 'deny')
    expect(await p.decide('fullscreen', FILE_PAGE)).toBe(false)
  })

  it('asks a local file about prompted types and remembers the answer for every local file', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('geolocation', FILE_PAGE)).toBe(true)
    expect(d.asked.length).toBe(1)
    expect(d.asked[0].origin).toBe('file://')
    expect(d.asked[0].message).toBe('Allow file:/// to know your location?')
    expect(p.check('geolocation', 'file:///')).toBe(true)
    expect(p.stored('geolocation', 'file:///tmp/other.html')).toBe('allow')
    expect(p.rules()).toEqual([{ origin: 'file://', permission: 'geolocation', decision: 'allow' }])
    expect(p.listForOrigin(FILE_PAGE)).toEqual([{ permission: 'geolocation', decision: 'allow' }])
    expect(p.listForPermission('geolocation')).toEqual([{ origin: 'file://', decision: 'allow' }])
    p.resetOrigin('file://')
    expect(p.listForOrigin(FILE_PAGE)).toEqual([])
    expect(await p.decide('geolocation', FILE_PAGE)).toBe(true)
    expect(d.asked.length).toBe(2)
  })

  it('keeps an "Allow once" while the tab stays on local files', async () => {
    const d = prompts('allow-once')
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('camera', FILE_PAGE, { tabId: 't1', mediaTypes: ['video'] })).toBe(true)
    expect(p.check('camera', 'file:///', { tabId: 't1' })).toBe(true)
    p.onTabNavigated('t1', 'file:///home/me/pages/next.html')
    expect(p.check('camera', 'file:///', { tabId: 't1' })).toBe(true)
    p.onTabNavigated('t1', 'https://example.com/')
    expect(p.check('camera', 'file:///', { tabId: 't1' })).toBe(false)
    expect(p.rules()).toEqual([])
  })
})

describe('permissionSite', () => {
  it('is the origin of a web page, one site for local files and nothing for the rest', () => {
    expect(permissionSite('https://example.com/a?b')).toBe('https://example.com')
    expect(permissionSite('http://localhost:8080/x')).toBe('http://localhost:8080')
    expect(permissionSite('file:///home/me/a.html')).toBe('file://')
    expect(permissionSite('file:///')).toBe('file://')
    expect(permissionSite('file://')).toBe('file://')
    expect(permissionSite('zen://settings')).toBeNull()
    expect(permissionSite('chrome-error://chromewebdata/')).toBeNull()
    expect(permissionSite('data:text/html,hi')).toBeNull()
    expect(permissionSite('about:blank')).toBeNull()
    expect(permissionSite('')).toBeNull()
    expect(permissionSite('not a url')).toBeNull()
  })

  it('names the local-file site the way Chrome does', () => {
    expect(displayOrigin('file://')).toBe('file:///')
    expect(displayOrigin('https://example.com')).toBe('example.com')
    expect(displayOrigin('http://example.com')).toBe('http://example.com')
  })
})

describe('PermissionService: external applications', () => {
  it('keeps one answer per scheme and forgets a refusal', async () => {
    let answer = false
    const d = prompts(() => answer)
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

  it('names the scheme in the prompt and keys the answer on it', () => {
    const scheme = permissionPromptCopy('openExternal', 'https://example.com', {
      externalUrl: 'zoommtg://zoom.us/join'
    })
    expect(scheme.message).toBe('Allow example.com to open zoommtg: links in another app?')
    expect(scheme.okLabel).toBe('Open')
    expect(scheme.detail).toContain('Zenium')
    expect(scheme.detail).toContain('zoommtg://zoom.us/join')
    expect(scheme.detail).toContain('remembered for zoommtg: links on this site')
    const bare = permissionPromptCopy('openExternal', 'https://example.com')
    expect(bare.message).toBe('Allow example.com to open another app?')
    expect(bare.detail).toContain('remembered for this site')
    expect(qualifiedPermission('openExternal', { externalUrl: 'ZoomMtg://x' })).toBe(
      'openExternal:zoommtg'
    )
    expect(qualifiedPermission('openExternal', { externalUrl: 'no scheme' })).toBe('openExternal')
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
    const d = prompts(true)
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

  it('keeps a folder view answer apart from the file editing answer', () => {
    expect(qualifiedPermission('fileSystem', { fileAccessType: 'readable' })).toBe(
      'fileSystem:read'
    )
    expect(qualifiedPermission('fileSystem', { fileAccessType: 'writable' })).toBe('fileSystem')
    expect(qualifiedPermission('fileSystem')).toBe('fileSystem')
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

describe('PermissionService: File System Access status checks', () => {
  const ORIGIN = 'https://editor.example/'
  const file = (
    fileAccessType: 'readable' | 'writable',
    extra: PermissionRequestDetails = {}
  ): PermissionRequestDetails => ({
    filePath: '/home/me/notes.txt',
    isDirectory: false,
    fileAccessType,
    ...extra
  })
  const folder = (fileAccessType: 'readable' | 'writable'): PermissionRequestDetails => ({
    filePath: '/home/me/notes',
    isDirectory: true,
    fileAccessType
  })

  it('grants reading a picked file, and reading a folder unless the site was refused', async () => {
    const d = prompts(false)
    const p = new PermissionService(fakeIo(), d)
    expect(p.check('fileSystem', ORIGIN, file('readable'))).toBe(true)
    expect(p.check('fileSystem', ORIGIN, folder('readable'))).toBe(true)
    // The folder picker's prompt (request path) is refused: folders of this site stay unreadable.
    expect(await p.decide('fileSystem', ORIGIN, folder('readable'))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, folder('readable'))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, file('readable'))).toBe(true)
    expect(p.stored('fileSystem', ORIGIN, file('writable'))).toBeNull()
    expect(p.rules()).toEqual([
      { origin: 'https://editor.example', permission: 'fileSystem:read', decision: 'deny' }
    ])
  })

  it('refuses a write it cannot ask about, and asks once the page has been interacted with', async () => {
    const d = prompts(true)
    const p = new PermissionService(fakeIo(), d)
    expect(p.check('fileSystem', ORIGIN, file('writable'))).toBe(false)
    expect(d.asked).toEqual([])
    expect(p.check('fileSystem', ORIGIN, file('writable', { pageActivated: true }))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, file('writable', { pageActivated: true }))).toBe(false)
    await Promise.resolve()
    expect(d.asked.length).toBe(1)
    expect(d.asked[0].message).toBe('Allow editor.example to save changes to "notes.txt"?')
    await new Promise((r) => setTimeout(r, 0))
    // The user said yes: the page's next attempt, on any file it is handed, goes through.
    expect(p.check('fileSystem', ORIGIN, file('writable'))).toBe(true)
    expect(p.check('fileSystem', ORIGIN, folder('writable'))).toBe(true)
    expect(p.stored('fileSystem', ORIGIN, file('writable'))).toBe('allow')
    expect(
      p.check('fileSystem', 'https://other.example', file('writable', { pageActivated: true }))
    ).toBe(false)
  })

  it('lets a file chosen in a save dialog be written for the session, that file only', () => {
    const d = prompts(false)
    const p = new PermissionService(fakeIo(), d)
    const saved = file('writable', { pickedForSaving: true })
    expect(p.check('fileSystem', ORIGIN, saved)).toBe(true)
    // Later writes to it (the file is no longer empty) still pass without a question.
    expect(p.check('fileSystem', ORIGIN, file('writable'))).toBe(true)
    expect(
      p.check('fileSystem', ORIGIN, { ...file('writable'), filePath: '/home/me/other.txt' })
    ).toBe(false)
    expect(p.check('fileSystem', 'https://other.example', file('writable'))).toBe(false)
    expect(d.asked).toEqual([])
    expect(p.rules()).toEqual([])
    p.resetOrigin(ORIGIN)
    expect(p.check('fileSystem', ORIGIN, file('writable'))).toBe(false)
  })

  it('honours a refusal over everything, and forgets session grants with the site', async () => {
    const d = prompts(false)
    const p = new PermissionService(fakeIo(), d)
    expect(await p.decide('fileSystem', ORIGIN, file('writable'))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, file('writable', { pickedForSaving: true }))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, file('writable', { pageActivated: true }))).toBe(false)
    expect(p.check('fileSystem', ORIGIN, file('readable'))).toBe(true)
    expect(d.asked.length).toBe(1)
    p.resetOrigin(ORIGIN, 'fileSystem')
    expect(p.check('fileSystem', ORIGIN, file('writable', { pickedForSaving: true }))).toBe(true)
    p.reset()
    expect(p.check('fileSystem', ORIGIN, file('writable'))).toBe(false)
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
    const p = new PermissionService(io, prompts(true))
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
    const p = new PermissionService(fakeIo(), prompts(true))
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
    const p = new PermissionService(fakeIo(), prompts(true))
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
  const host: PermissionPromptHost = {
    show: async (request) => {
      prompts.push(request.message)
      return answer ? 'allow' : 'block'
    },
    cancel: () => undefined
  }
  return { permissions: new PermissionService(io, host), io, prompts }
}

/** What `permissions.json` holds once pending writes landed. */
async function persisted(
  permissions: PermissionService,
  io: ReturnType<typeof memoryIo>
): Promise<Record<string, string>> {
  await (permissions as unknown as { store: { flush(): Promise<void> } }).store.flush()
  return JSON.parse(io.files.get('permissions.json') ?? '{}').decisions ?? {}
}

describe('PermissionService: private windows and tabs (session-12)', () => {
  const SITE = 'https://meet.example'
  const inPrivate: PermissionRequestDetails = { tabId: 'p1', private: true }
  const inRegular: PermissionRequestDetails = { tabId: 'r1' }

  it("keeps a private window's allow for the session and out of the persisted file", async () => {
    const { permissions, io, prompts } = service(true)
    expect(await permissions.decide('camera', `${SITE}/room`, inPrivate)).toBe(true)
    // The private session remembers: the same site asks no second time.
    expect(await permissions.decide('camera', `${SITE}/other`, inPrivate)).toBe(true)
    expect(permissions.check('camera', SITE, { private: true })).toBe(true)
    expect(permissions.stored('camera', SITE, { private: true })).toBe('allow')
    expect(prompts).toEqual(['Allow meet.example to use your camera?'])
    expect(await persisted(permissions, io)).toEqual({})
    expect(permissions.rules()).toEqual([])
    // A regular window knows nothing of it: it is asked, and its answer is the one written.
    expect(permissions.check('camera', SITE)).toBe(false)
    expect(await permissions.decide('camera', `${SITE}/room`, inRegular)).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(await persisted(permissions, io)).toEqual({ 'https://meet.example|camera': 'allow' })
  })

  it('forgets what the private session was answered when it ends', async () => {
    const { permissions, prompts } = service(true)
    const changes: PermissionChange[] = []
    permissions.subscribe((c) => changes.push(c))
    expect(await permissions.decide('geolocation', `${SITE}/map`, inPrivate)).toBe(true)
    expect(changes).toEqual([{ permission: 'geolocation', origin: SITE }])
    permissions.endPrivateSession()
    expect(changes).toHaveLength(2)
    expect(permissions.stored('geolocation', SITE, { private: true })).toBeNull()
    expect(await permissions.decide('geolocation', `${SITE}/map`, inPrivate)).toBe(true)
    expect(prompts).toHaveLength(2)
  })

  it("inherits the regular profile's block list but not its allows for prompted permissions", async () => {
    const { permissions, io, prompts } = service(true)
    permissions.set('camera', SITE, 'deny')
    permissions.set('geolocation', SITE, 'allow')
    permissions.set('popups', SITE, 'allow')
    permissions.setDefault('notifications', 'allow')
    // A refusal holds in the private window without a question.
    expect(await permissions.decide('camera', `${SITE}/room`, inPrivate)).toBe(false)
    expect(permissions.check('camera', SITE, { private: true })).toBe(false)
    expect(prompts).toEqual([])
    // An allow the user gave a regular window is asked for again (Chrome: inherited only if
    // less permissive); the private answer is the private session's.
    expect(permissions.check('geolocation', SITE, { private: true })).toBe(false)
    expect(permissions.stored('geolocation', SITE, { private: true })).toBeNull()
    expect(await permissions.decide('geolocation', `${SITE}/map`, inPrivate)).toBe(true)
    expect(prompts).toEqual(['Allow meet.example to know your location?'])
    // So is an allow chosen as the permission's default in Settings.
    expect(permissions.resolve('notifications', SITE, { private: true })).toBe('ask')
    expect(permissions.resolve('notifications', SITE)).toBe('allow')
    // Rows never prompted for (pop-ups, blocking) are inherited whole, as Chrome inherits them.
    expect(permissions.stored('popups', SITE, { private: true })).toBe('allow')
    expect(permissions.check('fullscreen', SITE, { private: true })).toBe(true)
    // The regular store is as the user left it.
    expect(await persisted(permissions, io)).toEqual({
      'https://meet.example|camera': 'deny',
      'https://meet.example|geolocation': 'allow',
      'https://meet.example|popups': 'allow',
      '*|notifications': 'allow'
    })
  })

  it("keeps a private window's block and its dismissal embargo out of the file too", async () => {
    let answer: PermissionPromptAnswer = 'block'
    const io = memoryIo()
    const asked: string[] = []
    const permissions = new PermissionService(io, {
      show: async (request) => {
        asked.push(request.message)
        return answer
      },
      cancel: () => undefined
    })
    expect(await permissions.decide('microphone', `${SITE}/room`, inPrivate)).toBe(false)
    expect(await permissions.decide('microphone', `${SITE}/room`, inPrivate)).toBe(false)
    expect(asked).toHaveLength(1)
    expect(permissions.stored('microphone', SITE, { private: true })).toBe('deny')
    // The regular window still gets its own question.
    expect(permissions.stored('microphone', SITE)).toBeNull()
    answer = 'dismiss'
    for (let i = 0; i < DISMISSALS_BEFORE_BLOCK; i++)
      expect(await permissions.decide('camera', `${SITE}/room`, inPrivate)).toBe(false)
    expect(permissions.stored('camera', SITE, { private: true })).toBe('deny')
    expect(asked).toHaveLength(1 + DISMISSALS_BEFORE_BLOCK)
    // Private dismissals never counted towards the regular embargo.
    expect(permissions.stored('camera', SITE)).toBeNull()
    expect(await persisted(permissions, io)).toEqual({})
  })

  it('tells a private tab from its id when a request names only the tab', async () => {
    const { permissions, io, prompts } = service(true)
    permissions.setPrivateTabs((tabId) => tabId.startsWith('private-'))
    expect(await permissions.decide('notifications', `${SITE}/`, { tabId: 'private-7' })).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(permissions.check('notifications', SITE, { tabId: 'private-7' })).toBe(true)
    expect(permissions.check('notifications', SITE, { tabId: 'regular-1' })).toBe(false)
    expect(await persisted(permissions, io)).toEqual({})
    // "Always allow pop-ups on this site" from the private tab is the private session's alone.
    permissions.remember('popups', `${SITE}/`, 'allow', { tabId: 'private-7' })
    expect(permissions.stored('popups', SITE, { tabId: 'private-7' })).toBe('allow')
    expect(permissions.stored('popups', SITE)).toBeNull()
    permissions.forget('popups', `${SITE}/`, { tabId: 'private-7' })
    expect(permissions.stored('popups', SITE, { tabId: 'private-7' })).toBeNull()
    expect(await persisted(permissions, io)).toEqual({})
  })

  it('lets the site-information sheet and a clear reset a private answer', async () => {
    const { permissions, io } = service(true)
    const changes: PermissionChange[] = []
    permissions.subscribe((c) => changes.push(c))
    expect(await permissions.decide('camera', `${SITE}/room`, inPrivate)).toBe(true)
    expect(await permissions.decide('camera', 'https://other.example/', inPrivate)).toBe(true)
    permissions.resetOrigin(SITE, 'camera')
    expect(permissions.stored('camera', SITE, { private: true })).toBeNull()
    expect(permissions.stored('camera', 'https://other.example', { private: true })).toBe('allow')
    expect(changes).toHaveLength(3)
    // Nothing of the shared store changed, so nothing was written for it.
    expect(await persisted(permissions, io)).toEqual({})
    permissions.resetSites()
    expect(permissions.stored('camera', 'https://other.example', { private: true })).toBeNull()
    expect(await permissions.decide('camera', `${SITE}/room`, inPrivate)).toBe(true)
    permissions.reset()
    expect(permissions.stored('camera', SITE, { private: true })).toBeNull()
  })
})

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

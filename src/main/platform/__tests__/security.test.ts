import { describe, expect, it, vi } from 'vitest'
import type { Certificate, WebContents } from 'electron'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from '../../../core/browser'
import type { PermissionRequestDetails } from '../../../core/permissions'
import {
  answerAuthChallenge,
  describeCertificate,
  hostOf,
  isFreshlyEmptied,
  permissionCheckDetails,
  permissionName,
  permissionRequestDetails,
  type AuthChallengeProvider
} from '../security'

vi.mock('electron', () => ({ app: { on: vi.fn() } }))

describe('answerAuthChallenge', () => {
  const authInfo = {
    isProxy: true,
    scheme: 'basic',
    host: 'proxy.vpn.example',
    port: 8080,
    realm: 'VPN'
  } as Electron.AuthInfo
  const details = { url: 'https://page.example/' }

  function browserWith(dialog: { username: string; password: string } | null): {
    browser: Pick<Browser, 'security'>
    httpAuth: ReturnType<typeof vi.fn>
  } {
    const httpAuth = vi.fn().mockResolvedValue(dialog)
    return { browser: { security: { httpAuth } } as unknown as Pick<Browser, 'security'>, httpAuth }
  }

  it("sends an extension's credentials without asking the user", async () => {
    const { browser, httpAuth } = browserWith({ username: 'user', password: 'typed' })
    const extensions: AuthChallengeProvider = {
      authRequired: vi.fn().mockResolvedValue({ credentials: { username: 'vpn', password: 'k' } })
    }
    await expect(
      answerAuthChallenge(browser, extensions, details, authInfo, 'tab-1')
    ).resolves.toEqual({ username: 'vpn', password: 'k' })
    expect(extensions.authRequired).toHaveBeenCalledWith({
      url: 'https://page.example/',
      isProxy: true,
      scheme: 'basic',
      realm: 'VPN',
      host: 'proxy.vpn.example',
      port: 8080,
      tabId: 'tab-1'
    })
    expect(httpAuth).not.toHaveBeenCalled()
  })

  it("gives the challenge up on an extension's cancel, without a dialog", async () => {
    const { browser, httpAuth } = browserWith({ username: 'user', password: 'typed' })
    const extensions: AuthChallengeProvider = {
      authRequired: vi.fn().mockResolvedValue({ cancel: true })
    }
    await expect(
      answerAuthChallenge(browser, extensions, details, authInfo, null)
    ).resolves.toBeNull()
    expect(httpAuth).not.toHaveBeenCalled()
  })

  it('falls back to the browser’s dialog when no extension answers, or none is wired', async () => {
    const { browser, httpAuth } = browserWith({ username: 'user', password: 'typed' })
    const silent: AuthChallengeProvider = { authRequired: vi.fn().mockResolvedValue(undefined) }
    await expect(answerAuthChallenge(browser, silent, details, authInfo, 'tab-1')).resolves.toEqual(
      {
        username: 'user',
        password: 'typed'
      }
    )
    expect(httpAuth).toHaveBeenCalledWith(
      {
        host: 'proxy.vpn.example',
        port: 8080,
        realm: 'VPN',
        scheme: 'basic',
        isProxy: true,
        secure: false
      },
      'tab-1'
    )
    const server = { ...authInfo, isProxy: false, host: 'page.example', port: 443 }
    await answerAuthChallenge(browser, null, details, server, 'tab-2')
    expect(httpAuth).toHaveBeenLastCalledWith(expect.objectContaining({ secure: true }), 'tab-2')
  })

  it("gives up a challenge on a request with no tab without a dialog, as Chrome's LoginHandler does", async () => {
    // An extension worker's fetch of a signed-out feed (a 401 Basic), a service worker's fetch, a
    // browser fetch: the response goes back as the server sent it and no sheet opens.
    const { browser, httpAuth } = browserWith({ username: 'user', password: 'typed' })
    const feed = {
      ...authInfo,
      isProxy: false,
      host: 'mail.google.com',
      port: 443,
      realm: 'New mail feed'
    }
    await expect(
      answerAuthChallenge(
        browser,
        null,
        { url: 'https://mail.google.com/mail/feed/atom' },
        feed,
        null
      )
    ).resolves.toBeNull()
    const silent: AuthChallengeProvider = { authRequired: vi.fn().mockResolvedValue(undefined) }
    await expect(answerAuthChallenge(browser, silent, details, authInfo, null)).resolves.toBeNull()
    expect(httpAuth).not.toHaveBeenCalled()
  })

  it("still lets an extension's onAuthRequired answer a request with no tab", async () => {
    const { browser, httpAuth } = browserWith(null)
    const extensions: AuthChallengeProvider = {
      authRequired: vi.fn().mockResolvedValue({ credentials: { username: 'vpn', password: 'k' } })
    }
    await expect(
      answerAuthChallenge(browser, extensions, details, authInfo, null)
    ).resolves.toEqual({ username: 'vpn', password: 'k' })
    expect(extensions.authRequired).toHaveBeenCalledWith(expect.objectContaining({ tabId: null }))
    expect(httpAuth).not.toHaveBeenCalled()
  })
})

describe('hostOf', () => {
  it("takes Electron's host:port as it is, and the host of a full URL", () => {
    expect(hostOf('localhost:8443')).toBe('localhost:8443')
    expect(hostOf('127.0.0.1:8443')).toBe('127.0.0.1:8443')
    expect(hostOf('[::1]:8443')).toBe('[::1]:8443')
    expect(hostOf('https://intranet.example:8443/whoami')).toBe('intranet.example:8443')
    expect(hostOf('https://intranet.example/whoami')).toBe('intranet.example')
    expect(hostOf(' intranet.example ')).toBe('intranet.example')
  })
})

describe('permissionRequestDetails', () => {
  const page = { isDestroyed: () => false, getURL: () => 'https://top.example/page' } as WebContents

  it('names the embedding page only for requests from frames', () => {
    expect(
      permissionRequestDetails(page, { isMainFrame: true, requestingUrl: 'https://top.example' })
    ).toEqual({})
    expect(
      permissionRequestDetails(page, { isMainFrame: false, requestingUrl: 'https://ad.example' })
    ).toEqual({ embedderUrl: 'https://top.example/page' })
  })

  it('passes the external URL and the file of a File System Access request through', () => {
    expect(
      permissionRequestDetails(page, {
        isMainFrame: true,
        requestingUrl: 'https://top.example',
        externalURL: 'zoommtg://zoom.us/join'
      })
    ).toEqual({ externalUrl: 'zoommtg://zoom.us/join' })
    expect(
      permissionRequestDetails(null, {
        isMainFrame: true,
        requestingUrl: 'https://top.example',
        filePath: '/home/ada/notes.md',
        isDirectory: false,
        fileAccessType: 'writable'
      })
    ).toEqual({ filePath: '/home/ada/notes.md', isDirectory: false, fileAccessType: 'writable' })
  })

  it('names the tab the prompt queues under and the devices of a media request', () => {
    expect(
      permissionRequestDetails(
        page,
        { isMainFrame: true, requestingUrl: 'https://meet.example', mediaTypes: ['video'] },
        't1'
      )
    ).toEqual({ tabId: 't1', mediaTypes: ['video'] })
    // An empty device list is not a device request (see permissionName): no rows named.
    expect(
      permissionRequestDetails(page, {
        isMainFrame: true,
        requestingUrl: 'https://meet.example',
        mediaTypes: []
      })
    ).toEqual({})
  })
})

describe('permissionName', () => {
  const at = (mediaTypes?: Array<'video' | 'audio'>): Electron.MediaAccessPermissionRequest => ({
    isMainFrame: true,
    requestingUrl: 'https://meet.example',
    ...(mediaTypes ? { mediaTypes } : {})
  })

  it("decides Electron's device-less media request (getDisplayMedia) as the screen-sharing row", () => {
    expect(permissionName('media', at([]))).toBe('display-capture')
  })

  it('leaves camera / microphone requests and every other permission alone', () => {
    expect(permissionName('media', at(['video']))).toBe('media')
    expect(permissionName('media', at(['audio', 'video']))).toBe('media')
    expect(permissionName('media', at())).toBe('media')
    expect(permissionName('notifications', at())).toBe('notifications')
    expect(permissionName('geolocation', at([]))).toBe('geolocation')
  })
})

describe('permissionCheckDetails: media', () => {
  it('turns the one device of a check into the row the core stores', () => {
    const browser = {} as Browser
    expect(
      permissionCheckDetails(
        'media',
        'https://meet.example',
        { isMainFrame: true, mediaType: 'audio' },
        browser
      )
    ).toEqual({ mediaTypes: ['audio'] })
    expect(
      permissionCheckDetails(
        'media',
        'https://meet.example',
        { isMainFrame: true, mediaType: 'unknown' },
        browser
      )
    ).toEqual({})
  })
})

describe('permissionCheckDetails', () => {
  const browserWith = (activeOrigins: string[]): Browser =>
    ({
      popups: { originHasBeenActive: (origin: string) => activeOrigins.includes(origin) }
    }) as unknown as Browser

  it('passes the embedder through and nothing else for ordinary checks', () => {
    const browser = browserWith(['https://top.example'])
    expect(
      permissionCheckDetails('notifications', 'https://top.example', { isMainFrame: true }, browser)
    ).toEqual({})
    expect(
      permissionCheckDetails(
        'storage-access',
        'https://ad.example',
        { isMainFrame: false, embeddingOrigin: 'https://top.example' },
        browser
      )
    ).toEqual({ embedderUrl: 'https://top.example' })
  })

  it('adds what Electron leaves out of a File System Access check', () => {
    const fresh = (path: string): boolean => path.endsWith('saved.txt')
    const browser = browserWith(['https://editor.example'])
    const check = (
      filePath: string,
      fileAccessType: 'writable' | 'readable',
      isDirectory = false
    ): PermissionRequestDetails =>
      permissionCheckDetails(
        'fileSystem',
        'https://editor.example',
        { isMainFrame: true, filePath, isDirectory, fileAccessType },
        browser,
        fresh
      )
    expect(check('/home/ada/saved.txt', 'writable')).toEqual({
      filePath: '/home/ada/saved.txt',
      isDirectory: false,
      fileAccessType: 'writable',
      pageActivated: true,
      pickedForSaving: true
    })
    expect(check('/home/ada/opened.txt', 'writable')).toMatchObject({ pickedForSaving: false })
    // Reads and folders are never "just saved"; a site without a gesture gets no question.
    expect(check('/home/ada/saved.txt', 'readable')).not.toHaveProperty('pickedForSaving')
    expect(check('/home/ada', 'writable', true)).not.toHaveProperty('pickedForSaving')
    expect(
      permissionCheckDetails(
        'fileSystem',
        'https://quiet.example',
        { isMainFrame: true, filePath: '/x', isDirectory: false, fileAccessType: 'writable' },
        browser,
        fresh
      )
    ).toMatchObject({ pageActivated: false })
  })
})

describe('isFreshlyEmptied', () => {
  it('recognises the empty file a save dialog just left behind, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zenium-fsa-'))
    const empty = join(dir, 'empty.txt')
    const full = join(dir, 'full.txt')
    const old = join(dir, 'old.txt')
    writeFileSync(empty, '')
    writeFileSync(full, 'content')
    writeFileSync(old, '')
    const now = Date.now()
    utimesSync(old, new Date(now - 120_000), new Date(now - 120_000))
    expect(isFreshlyEmptied(empty, now)).toBe(true)
    expect(isFreshlyEmptied(full, now)).toBe(false)
    expect(isFreshlyEmptied(old, now)).toBe(false)
    expect(isFreshlyEmptied(dir, now)).toBe(false)
    expect(isFreshlyEmptied(join(dir, 'missing.txt'), now)).toBe(false)
  })
})

describe('describeCertificate', () => {
  it('prefers the printable names and converts validity to milliseconds', () => {
    const cert = {
      fingerprint: 'sha256/abc',
      subjectName: 'Ada Lovelace (work)',
      issuerName: 'Zenium Demo CA',
      serialNumber: '01',
      validStart: 1_700_000_000,
      validExpiry: 1_800_000_000,
      subject: { commonName: 'ignored' },
      issuer: { commonName: 'ignored' }
    } as unknown as Certificate
    expect(describeCertificate(cert)).toEqual({
      fingerprint: 'sha256/abc',
      subject: 'Ada Lovelace (work)',
      issuer: 'Zenium Demo CA',
      serialNumber: '01',
      validFrom: 1_700_000_000_000,
      validTo: 1_800_000_000_000
    })
    const bare = { ...cert, subjectName: '', issuerName: '' } as unknown as Certificate
    expect(describeCertificate(bare)).toMatchObject({ subject: 'ignored', issuer: 'ignored' })
  })
})

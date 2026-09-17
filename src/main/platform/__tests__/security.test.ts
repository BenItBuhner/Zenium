import { describe, expect, it, vi } from 'vitest'
import type { Certificate, WebContents } from 'electron'
import { describeCertificate, hostOf, permissionRequestDetails } from '../security'

vi.mock('electron', () => ({ app: { on: vi.fn() } }))

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

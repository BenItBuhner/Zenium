import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  INTERRUPT_REASONS,
  chromeInterruptReasonName,
  downloadHost,
  fileExtension,
  finalName,
  interruptMessage,
  interruptReasonFrom,
  interruptReasonFromHttpStatus,
  interruptReasonFromNetError,
  isInterruptReason,
  normalizeExtension,
  resolveDownloadSettings
} from '../downloads'

describe('interrupt reasons', () => {
  it('is the closed set of 22, each with Chrome’s wording and Chrome’s spelling', () => {
    expect(INTERRUPT_REASONS).toHaveLength(22)
    expect(new Set(INTERRUPT_REASONS).size).toBe(22)
    for (const reason of INTERRUPT_REASONS) {
      expect(isInterruptReason(reason)).toBe(true)
      expect(interruptMessage(reason).length).toBeGreaterThan(0)
      expect(chromeInterruptReasonName(reason)).toMatch(/^[A-Z_]+$/)
    }
    expect(chromeInterruptReasonName('file-security-check-failed')).toBe(
      'FILE_SECURITY_CHECK_FAILED'
    )
    expect(isInterruptReason('interrupted')).toBe(false)
    expect(isInterruptReason(42)).toBe(false)
  })

  it('reads Chromium’s net errors the way its download core does', () => {
    // The cases of ConvertNetErrorToInterruptReason that land in the set.
    expect(interruptReasonFromNetError('net::ERR_TIMED_OUT')).toBe('network-timeout')
    expect(interruptReasonFromNetError('net::ERR_INTERNET_DISCONNECTED')).toBe(
      'network-disconnected'
    )
    expect(interruptReasonFromNetError('ERR_CONNECTION_FAILED')).toBe('network-server-down')
    expect(interruptReasonFromNetError('net::ERR_REQUEST_RANGE_NOT_SATISFIABLE')).toBe(
      'server-no-range'
    )
    expect(interruptReasonFromNetError('net::ERR_FILE_NO_SPACE')).toBe('file-no-space')
    expect(interruptReasonFromNetError('net::ERR_FILE_PATH_TOO_LONG')).toBe('file-name-too-long')
    expect(interruptReasonFromNetError('net::ERR_FILE_TOO_BIG')).toBe('file-too-large')
    expect(interruptReasonFromNetError('net::ERR_FILE_VIRUS_INFECTED')).toBe('file-virus-infected')
    expect(interruptReasonFromNetError('net::ERR_ACCESS_DENIED')).toBe('file-access-denied')
    expect(interruptReasonFromNetError('net::ERR_BLOCKED_BY_CLIENT')).toBe('file-blocked')
    // HandleRequestCompletionStatus: an aborted request is the user's doing.
    expect(interruptReasonFromNetError('net::ERR_ABORTED')).toBe('user-canceled')
    // Certificate and TLS errors: the site was not available (SERVER_CERT_PROBLEM's wording).
    expect(interruptReasonFromNetError('net::ERR_CERT_DATE_INVALID')).toBe('server-failed')
    expect(interruptReasonFromNetError('net::ERR_SSL_PROTOCOL_ERROR')).toBe('server-failed')
    // Everything else the stack reports is NETWORK_FAILED, as in Chromium: a refused or reset
    // connection, a name that does not resolve, an empty response, a short body, a network change.
    expect(interruptReasonFromNetError('net::ERR_CONNECTION_REFUSED')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_CONNECTION_RESET')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_NAME_NOT_RESOLVED')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_EMPTY_RESPONSE')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_CONTENT_LENGTH_MISMATCH')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_NETWORK_CHANGED')).toBe('network-failed')
    expect(interruptReasonFromNetError('net::ERR_FILE_NOT_FOUND')).toBe('network-failed')
    expect(interruptReasonFromNetError('')).toBe('network-failed')
  })

  it('reads a refusing HTTP status, and none from one a download proceeds under', () => {
    for (const ok of [200, 201, 202, 203, 206, 304]) {
      expect(interruptReasonFromHttpStatus(ok)).toBeNull()
    }
    expect(interruptReasonFromHttpStatus(204)).toBe('server-bad-content')
    expect(interruptReasonFromHttpStatus(205)).toBe('server-bad-content')
    expect(interruptReasonFromHttpStatus(404)).toBe('server-bad-content')
    expect(interruptReasonFromHttpStatus(401)).toBe('server-unauthorized')
    expect(interruptReasonFromHttpStatus(407)).toBe('server-unauthorized')
    expect(interruptReasonFromHttpStatus(403)).toBe('server-forbidden')
    expect(interruptReasonFromHttpStatus(416)).toBe('server-no-range')
    expect(interruptReasonFromHttpStatus(410)).toBe('server-failed')
    expect(interruptReasonFromHttpStatus(429)).toBe('server-failed')
    expect(interruptReasonFromHttpStatus(500)).toBe('server-failed')
    expect(interruptReasonFromHttpStatus(503)).toBe('server-failed')
  })

  it('normalises whatever a host or an older file names onto the set', () => {
    expect(interruptReasonFrom('file-no-space')).toBe('file-no-space')
    expect(interruptReasonFrom(' user-canceled ')).toBe('user-canceled')
    expect(interruptReasonFrom('shutdown')).toBe('user-shutdown')
    expect(interruptReasonFrom('file-error')).toBe('file-failed')
    expect(interruptReasonFrom('cancelled')).toBe('user-canceled')
    expect(interruptReasonFrom('NETWORK_TIMEOUT')).toBe('network-timeout')
    expect(interruptReasonFrom('DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE')).toBe('file-no-space')
    expect(interruptReasonFrom('net::ERR_INTERNET_DISCONNECTED')).toBe('network-disconnected')
    expect(interruptReasonFrom('ERR_TIMED_OUT')).toBe('network-timeout')
    expect(interruptReasonFrom('interrupted')).toBe('network-failed')
    expect(interruptReasonFrom(undefined)).toBe('network-failed')
    expect(interruptReasonFrom(null, 'crash')).toBe('crash')
    expect(interruptReasonFrom('SERVER_CERT_PROBLEM', 'server-failed')).toBe('server-failed')
    expect(interruptReasonFrom(7)).toBe('network-failed')
  })

  it('words each reason as Chrome’s download bubble does', () => {
    expect(interruptMessage('network-failed')).toBe('Check internet connection')
    expect(interruptMessage('network-disconnected')).toBe('Check internet connection')
    expect(interruptMessage('server-unreachable')).toBe('Site wasn’t available')
    expect(interruptMessage('server-bad-content')).toBe('File wasn’t available on site')
    expect(interruptMessage('file-no-space')).toBe('Out of storage space')
    expect(interruptMessage('file-virus-infected')).toBe('Virus detected')
    expect(interruptMessage('file-blocked')).toBe('Blocked by your organization')
    expect(interruptMessage('user-canceled')).toBe('Cancelled')
    expect(interruptMessage('user-shutdown')).toBe('Couldn’t finish download')
    expect(interruptMessage('crash')).toBe('Couldn’t finish download')
  })
})

describe('download settings', () => {
  it('fills in defaults for profiles from before the block existed', () => {
    expect(resolveDownloadSettings(undefined)).toEqual(DEFAULT_DOWNLOAD_SETTINGS)
    expect(resolveDownloadSettings({})).toEqual(DEFAULT_DOWNLOAD_SETTINGS)
    expect(resolveDownloadSettings({ downloads: { directory: '/x' } })).toEqual({
      ...DEFAULT_DOWNLOAD_SETTINGS,
      directory: '/x'
    })
    expect(resolveDownloadSettings({ downloads: { directory: '' } }).directory).toBeNull()
  })

  it("follows Chrome's defaults: the bubble opens on completion and is the notice", () => {
    const d = resolveDownloadSettings(undefined)
    expect(d.openPanelOnComplete).toBe(true)
    expect(d.openPanelOnStart).toBe(false)
    expect(d.notifyOnComplete).toBe(false)
    // Edge's OS notification is the switch's other position.
    expect(
      resolveDownloadSettings({ downloads: { notifyOnComplete: true } }).notifyOnComplete
    ).toBe(true)
  })

  it('mirrors the older top-level ask-where-to-save switch', () => {
    expect(resolveDownloadSettings({ askWhereToSave: true }).askWhereToSave).toBe(true)
    expect(resolveDownloadSettings({ askWhereToSave: false }).askWhereToSave).toBe(false)
  })

  it('normalises the auto-open list and ignores wrong types', () => {
    const settings = resolveDownloadSettings({
      downloads: {
        autoOpenTypes: ['.PDF', ' torrent ', 42 as unknown as string, ''],
        notifyOnComplete: 'yes' as unknown as boolean,
        openPanelOnStart: false,
        openPanelOnComplete: false
      }
    })
    expect(settings.autoOpenTypes).toEqual(['pdf', 'torrent'])
    expect(settings.notifyOnComplete).toBe(DEFAULT_DOWNLOAD_SETTINGS.notifyOnComplete)
    expect(settings.openPanelOnStart).toBe(false)
    expect(settings.openPanelOnComplete).toBe(false)
  })
})

describe('file names', () => {
  it('finds the extension, including Chromium\u2019s double ones', () => {
    expect(fileExtension('report.PDF')).toBe('pdf')
    expect(fileExtension('source.tar.gz')).toBe('tar.gz')
    expect(fileExtension('backup.tar.bz2')).toBe('tar.bz2')
    expect(fileExtension('script.user.js')).toBe('user.js')
    expect(fileExtension('photo.final.jpg')).toBe('jpg')
    expect(fileExtension('README')).toBe('')
    expect(fileExtension('.bashrc')).toBe('')
    expect(fileExtension('trailing.')).toBe('')
    expect(fileExtension('setup.exe.zeniumdownload')).toBe('exe')
  })

  it('strips the partial suffix and normalises extensions', () => {
    expect(finalName('report.pdf.zeniumdownload')).toBe('report.pdf')
    expect(finalName('report.pdf')).toBe('report.pdf')
    expect(normalizeExtension(' .TAR.GZ ')).toBe('tar.gz')
  })
})

describe('downloadHost', () => {
  it('names the source of a download for the panel', () => {
    expect(downloadHost('https://cdn.example.com/x/y.zip')).toBe('cdn.example.com')
    expect(downloadHost('data:text/plain,hi')).toBe('data URL')
    expect(downloadHost('blob:https://app.example.com/uuid')).toBe('app.example.com')
    expect(downloadHost('blob:null/uuid')).toBe('blob')
    expect(downloadHost('file:///home/x/a.txt')).toBe('this device')
    expect(downloadHost('garbage')).toBe('')
  })
})

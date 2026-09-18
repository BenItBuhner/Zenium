import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  downloadHost,
  fileExtension,
  finalName,
  normalizeExtension,
  resolveDownloadSettings
} from '../downloads'

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

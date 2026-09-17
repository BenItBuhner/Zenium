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
    expect(resolveDownloadSettings({ downloads: { location: '/x' } })).toEqual({
      ...DEFAULT_DOWNLOAD_SETTINGS,
      location: '/x'
    })
  })

  it('normalises the auto-open list and ignores wrong types', () => {
    const settings = resolveDownloadSettings({
      downloads: {
        autoOpen: ['.PDF', ' torrent ', 42 as unknown as string],
        showNotifications: 'yes' as unknown as boolean,
        openPanelOnStart: true
      }
    })
    expect(settings.autoOpen).toEqual(['pdf', 'torrent'])
    expect(settings.showNotifications).toBe(true)
    expect(settings.openPanelOnStart).toBe(true)
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

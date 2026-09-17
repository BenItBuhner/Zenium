import { describe, expect, it } from 'vitest'
import {
  SAFE,
  classifyDownload,
  fileTypePolicy,
  isInsecureDownload,
  mayAutoOpen,
  worstDanger,
  type DangerContext
} from '../downloadDanger'

function context(overrides: Partial<DangerContext>): DangerContext {
  return {
    url: 'https://cdn.example.com/file',
    referrer: 'https://example.com/page',
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    os: 'linux',
    referrerFamiliar: false,
    ...overrides
  }
}

describe('file-type policy (Chromium download_file_types)', () => {
  it('flags executables where they run', () => {
    expect(fileTypePolicy('setup.exe', 'win32')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('setup.msi', 'win32')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('Installer.dmg', 'darwin')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('tool.deb', 'linux')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('app.apk', 'android')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('run.sh', 'linux')).toBe('allow-on-user-gesture')
  })

  it('does not flag another platform\u2019s executables', () => {
    expect(fileTypePolicy('setup.exe', 'darwin')).toBe('not-dangerous')
    expect(fileTypePolicy('Installer.dmg', 'win32')).toBe('not-dangerous')
    expect(fileTypePolicy('run.sh', 'win32')).toBe('not-dangerous')
    expect(fileTypePolicy('app.apk', 'win32')).toBe('not-dangerous')
  })

  it('always warns for the DANGEROUS handful', () => {
    expect(fileTypePolicy('library.dll', 'win32')).toBe('dangerous')
    expect(fileTypePolicy('desktop.ini', 'win32')).toBe('dangerous')
    expect(fileTypePolicy('photo.dng', 'android')).toBe('dangerous')
    expect(fileTypePolicy('library.dll', 'linux')).toBe('not-dangerous')
  })

  it('flags scripts and macro documents, not documents and media', () => {
    expect(fileTypePolicy('macro.js', 'win32')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('applet.jar', 'linux')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('script.py', 'darwin')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('report.pdf', 'win32')).toBe('not-dangerous')
    expect(fileTypePolicy('archive.zip', 'win32')).toBe('not-dangerous')
    expect(fileTypePolicy('photo.jpg', 'android')).toBe('not-dangerous')
    expect(fileTypePolicy('README', 'linux')).toBe('not-dangerous')
  })

  it('looks past the partial suffix and inside double extensions', () => {
    expect(fileTypePolicy('setup.exe.zeniumdownload', 'win32')).toBe('allow-on-user-gesture')
    expect(fileTypePolicy('source.tar.gz', 'linux')).toBe('not-dangerous')
    expect(fileTypePolicy('SETUP.EXE', 'win32')).toBe('allow-on-user-gesture')
  })

  it('never auto-opens flagged types', () => {
    expect(mayAutoOpen('report.pdf', 'win32')).toBe(true)
    expect(mayAutoOpen('setup.exe', 'win32')).toBe(false)
    expect(mayAutoOpen('library.dll', 'win32')).toBe(false)
  })
})

describe('classifyDownload', () => {
  it('leaves ordinary files alone', () => {
    expect(classifyDownload(context({ filename: 'report.pdf' }))).toEqual(SAFE)
  })

  it('marks runnable files dangerous and code-carrying documents suspicious', () => {
    expect(classifyDownload(context({ filename: 'setup.exe', os: 'win32' }))).toEqual({
      level: 'dangerous',
      reason: 'file-type'
    })
    expect(classifyDownload(context({ filename: 'macros.xml', os: 'win32' }))).toEqual({
      level: 'suspicious',
      reason: 'file-type'
    })
    expect(classifyDownload(context({ filename: 'library.dll', os: 'win32' }))).toEqual({
      level: 'dangerous',
      reason: 'file-type'
    })
  })

  it('skips the warning for installers from a familiar site, like Chromium\u2019s user-gesture rule', () => {
    expect(
      classifyDownload(context({ filename: 'setup.exe', os: 'win32', referrerFamiliar: true }))
    ).toEqual(SAFE)
    // The DANGEROUS handful warns regardless of familiarity.
    expect(
      classifyDownload(context({ filename: 'library.dll', os: 'win32', referrerFamiliar: true }))
    ).toEqual({ level: 'dangerous', reason: 'file-type' })
  })

  it('flags an http download from an https page (mixed content)', () => {
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', 'https://example.com/')).toBe(true)
    expect(isInsecureDownload('https://cdn.example.com/a.pdf', 'https://example.com/')).toBe(false)
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', 'http://example.com/')).toBe(false)
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', '')).toBe(false)
    expect(
      classifyDownload(
        context({ url: 'http://cdn.example.com/report.pdf', referrer: 'https://example.com/x' })
      )
    ).toEqual({ level: 'suspicious', reason: 'insecure' })
  })

  it('takes the worse of two verdicts and drops a stale Keep', () => {
    expect(
      worstDanger(
        { level: 'suspicious', reason: 'file-type', kept: true },
        { level: 'dangerous', reason: 'url' }
      )
    ).toEqual({ level: 'dangerous', reason: 'url' })
    expect(worstDanger({ level: 'dangerous', reason: 'file-type' }, SAFE)).toEqual({
      level: 'dangerous',
      reason: 'file-type'
    })
  })
})

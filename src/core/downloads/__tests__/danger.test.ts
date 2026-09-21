import { describe, expect, it } from 'vitest'
import {
  DangerVerdictRegistry,
  INSECURE_BLOCKED_MESSAGE,
  SAFE,
  classifyDownload,
  dangerMessage,
  dangerReasonFor,
  fileTypePolicy,
  insecureDownload,
  isInsecureDownload,
  isPotentiallyTrustworthy,
  makeDanger,
  mayAutoOpen,
  worstDanger,
  type DangerContext
} from '../danger'

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

  it('marks programs and scripts dangerous and the rest of the list suspicious, with a sentence', () => {
    expect(classifyDownload(context({ filename: 'setup.exe', os: 'win32' }))).toEqual({
      level: 'dangerous',
      reason: 'executable',
      message: 'This type of file can harm your device.'
    })
    expect(classifyDownload(context({ filename: 'run.sh', os: 'linux' }))).toEqual({
      level: 'dangerous',
      reason: 'script',
      message: 'This type of file can run code on your device.'
    })
    expect(classifyDownload(context({ filename: 'macros.xml', os: 'win32' }))).toEqual({
      level: 'suspicious',
      reason: 'file-type',
      message: 'This type of file is uncommon and could be unsafe.'
    })
    expect(classifyDownload(context({ filename: 'Installer.dmg', os: 'darwin' }))).toEqual({
      level: 'suspicious',
      reason: 'archive',
      message: 'This disk image can contain programs that harm your device.'
    })
    expect(classifyDownload(context({ filename: 'db.accdb', os: 'win32' }))).toEqual({
      level: 'suspicious',
      reason: 'office-macro',
      message: 'This document type can contain macros that harm your device.'
    })
    expect(classifyDownload(context({ filename: 'library.dll', os: 'win32' }))).toMatchObject({
      level: 'dangerous',
      reason: 'executable'
    })
  })

  it('names the category of an extension regardless of platform', () => {
    expect(dangerReasonFor('tool.deb')).toBe('executable')
    expect(dangerReasonFor('app.apk')).toBe('executable')
    expect(dangerReasonFor('script.py')).toBe('script')
    expect(dangerReasonFor('setup.exe.zeniumdownload')).toBe('executable')
    expect(dangerReasonFor('weird.cfg')).toBe('file-type')
    expect(dangerMessage('none', 'safe')).toBe('')
    expect(makeDanger('safe', 'executable')).toEqual(SAFE)
    expect(makeDanger('dangerous', 'url-verdict').message).toBe(
      'Zenium found this file may be dangerous.'
    )
    expect(makeDanger('dangerous', 'url-verdict', 'Blocked by policy.').message).toBe(
      'Blocked by policy.'
    )
  })

  it('skips the warning for installers from a familiar site, like Chromium\u2019s user-gesture rule', () => {
    expect(
      classifyDownload(context({ filename: 'setup.exe', os: 'win32', referrerFamiliar: true }))
    ).toEqual(SAFE)
    // The DANGEROUS handful warns regardless of familiarity.
    expect(
      classifyDownload(context({ filename: 'library.dll', os: 'win32', referrerFamiliar: true }))
    ).toMatchObject({ level: 'dangerous', reason: 'executable' })
  })

  it('judges the file type alone: the mixed-content rule is a state now, not a verdict', () => {
    expect(
      classifyDownload(
        context({ url: 'http://cdn.example.com/report.pdf', referrer: 'https://example.com/x' })
      )
    ).toEqual(SAFE)
    expect(
      classifyDownload(
        context({
          url: 'http://cdn.example.com/setup.exe',
          filename: 'setup.exe',
          referrer: 'https://example.com/x',
          os: 'win32'
        })
      ).level
    ).toBe('dangerous')
  })

  it('tiers: .iso and .img are suspicious disk images, archives stay safe as in Chromium', () => {
    expect(classifyDownload(context({ filename: 'ubuntu.iso', os: 'win32' })).level).toBe(
      'suspicious'
    )
    expect(classifyDownload(context({ filename: 'ubuntu.iso', os: 'darwin' })).level).toBe(
      'suspicious'
    )
    expect(classifyDownload(context({ filename: 'disk.img', os: 'win32' })).level).toBe(
      'suspicious'
    )
    expect(classifyDownload(context({ filename: 'ubuntu.iso', os: 'linux' })).level).toBe('safe')
    for (const name of ['photos.zip', 'src.tar.gz', 'a.rar', 'a.7z'])
      expect(classifyDownload(context({ filename: name, os: 'win32' })).level).toBe('safe')
  })

  it('takes the worse of two verdicts', () => {
    expect(
      worstDanger(
        makeDanger('suspicious', 'file-type'),
        makeDanger('dangerous', 'url-verdict', 'Nope.')
      )
    ).toEqual({ level: 'dangerous', reason: 'url-verdict', message: 'Nope.' })
    expect(worstDanger(makeDanger('dangerous', 'executable'), SAFE)).toEqual(
      makeDanger('dangerous', 'executable')
    )
  })
})

describe('the insecure-download rule (Chrome, HB-44)', () => {
  it('blocks a plain http download a secure page started, and only that', () => {
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', 'https://example.com/')).toBe(true)
    expect(isInsecureDownload('https://cdn.example.com/a.pdf', 'https://example.com/')).toBe(false)
    // An insecure page has nothing to protect: Chrome blocks nothing there.
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', 'http://example.com/')).toBe(false)
    // No initiator (typed address, an extension, a resume after a restart of an old row).
    expect(isInsecureDownload('http://cdn.example.com/a.pdf', '')).toBe(false)
    expect(insecureDownload(['http://cdn.example.com/a.pdf'], 'https://example.com/')).toBe(true)
  })

  it('judges every hop of the redirect chain, not just the final URL', () => {
    const referrer = 'https://example.com/'
    // https → http → https: the bytes could have been swapped on the plaintext hop.
    expect(
      insecureDownload(
        ['https://a.example/dl', 'http://b.example/dl', 'https://c.example/file.zip'],
        referrer
      )
    ).toBe(true)
    // https → https → http: the final hop is plain.
    expect(
      insecureDownload(
        ['https://a.example/dl', 'https://b.example/dl', 'http://c.example/f'],
        referrer
      )
    ).toBe(true)
    expect(
      insecureDownload(
        ['https://a.example/dl', 'https://b.example/dl', 'https://c.example/f'],
        referrer
      )
    ).toBe(false)
    // An empty chain is a host's mistake (the core always passes at least the URL): the rule
    // fails closed rather than let an unjudged transfer through.
    expect(insecureDownload([], referrer)).toBe(true)
  })

  it('counts the machine itself, data:, blob: and file: as secure (potentially trustworthy)', () => {
    expect(isPotentiallyTrustworthy('http://localhost:8080/f')).toBe(true)
    expect(isPotentiallyTrustworthy('http://dev.localhost/f')).toBe(true)
    expect(isPotentiallyTrustworthy('http://127.0.0.1/f')).toBe(true)
    expect(isPotentiallyTrustworthy('http://127.9.9.9/f')).toBe(true)
    expect(isPotentiallyTrustworthy('http://[::1]/f')).toBe(true)
    expect(isPotentiallyTrustworthy('http://10.0.0.1/f')).toBe(false)
    expect(isPotentiallyTrustworthy('http://example.com/f')).toBe(false)
    expect(isPotentiallyTrustworthy('ftp://example.com/f')).toBe(false)
    expect(isPotentiallyTrustworthy('ws://example.com/f')).toBe(false)
    expect(isPotentiallyTrustworthy('wss://example.com/f')).toBe(true)
    expect(isPotentiallyTrustworthy('data:text/plain,hi')).toBe(true)
    expect(isPotentiallyTrustworthy('blob:https://example.com/uuid')).toBe(true)
    expect(isPotentiallyTrustworthy('file:///tmp/a')).toBe(true)
    expect(isPotentiallyTrustworthy('not a url')).toBe(false)
    expect(insecureDownload(['http://localhost:3000/a.zip'], 'https://example.com/')).toBe(false)
    expect(insecureDownload(['data:text/plain,hi'], 'https://example.com/')).toBe(false)
    expect(insecureDownload(['ftp://files.example/a.zip'], 'https://example.com/')).toBe(true)
  })

  it('the initiator is secure by the same measure: a page on the machine itself or a local file counts', () => {
    expect(insecureDownload(['http://cdn.example/a'], 'http://localhost/')).toBe(true)
    expect(insecureDownload(['http://cdn.example/a'], 'file:///page.html')).toBe(true)
    expect(insecureDownload(['http://cdn.example/a'], 'http://10.0.0.5/page')).toBe(false)
    expect(insecureDownload(['http://cdn.example/a'], 'about:blank')).toBe(false)
    expect(insecureDownload(['http://cdn.example/a'], 'garbage')).toBe(false)
  })

  it('offers Chrome\u2019s sentence for the row', () => {
    expect(INSECURE_BLOCKED_MESSAGE).toBe('This file can’t be downloaded securely.')
  })
})

describe('DangerVerdictRegistry', () => {
  it('registers providers and hands back their unregister', () => {
    const registry = new DangerVerdictRegistry()
    const provider = { verdict: async (): Promise<null> => null }
    const off = registry.register(provider)
    registry.register(provider)
    expect(registry.all()).toEqual([provider])
    expect(registry.size).toBe(1)
    off()
    expect(registry.size).toBe(0)
  })
})

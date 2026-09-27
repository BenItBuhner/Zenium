import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

const fake = {
  version: '0.5.9',
  packaged: true,
  translated: false
}

vi.mock('electron', () => ({
  app: {
    getVersion: () => fake.version,
    get isPackaged() {
      return fake.packaged
    },
    get runningUnderARM64Translation() {
      return fake.translated
    }
  }
}))

const { desktopVersionFacts, processorVariation, readDesktopVersionInput } =
  await import('../versionFacts')

const INPUT = {
  version: '0.5.9',
  packaged: true,
  platform: 'linux',
  arch: 'x64',
  translated: false,
  chrome: '152.0.7977.89',
  electron: '44.0.0',
  v8: '15.2.100.1',
  osType: 'Linux',
  osRelease: '6.12.0',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
  argv: ['/opt/zenium/zenium', '--no-sandbox'],
  execPath: '/opt/zenium/zenium',
  profilePath: '/home/u/.config/zenium/zen'
}

describe('desktopVersionFacts (SET-66)', () => {
  it("lays the process's facts out as Chrome's chrome://version rows", () => {
    expect(desktopVersionFacts(INPUT)).toEqual({
      // Chrome on Linux x86_64: "<version> (Official Build) (x86_64)".
      app: '0.5.9 (Official Build) (x86_64)',
      engine: 'Chromium 152.0.7977.89 (Electron 44.0.0)',
      os: 'Linux 6.12.0',
      javascript: 'V8 15.2.100.1',
      userAgent: INPUT.userAgent,
      commandLine: '/opt/zenium/zenium --no-sandbox',
      executablePath: '/opt/zenium/zenium',
      profilePath: '/home/u/.config/zenium/zen'
    })
  })

  it('names an unpackaged run a Developer Build and the OS by its common name', () => {
    expect(
      desktopVersionFacts({ ...INPUT, packaged: false, osType: 'Darwin', osRelease: '23.2.0' }).app
    ).toBe('0.5.9 (Developer Build) (x86_64)')
    expect(desktopVersionFacts({ ...INPUT, osType: 'Darwin', osRelease: '23.2.0' }).os).toBe(
      'macOS 23.2.0'
    )
    expect(
      desktopVersionFacts({ ...INPUT, osType: 'Windows_NT', osRelease: '10.0.22631' }).os
    ).toBe('Windows 10.0.22631')
    expect(desktopVersionFacts({ ...INPUT, osType: 'FreeBSD', osRelease: '' }).os).toBe('FreeBSD')
  })

  it("follows VersionUI::VersionProcessorVariation's words per platform and processor", () => {
    expect(processorVariation('linux', 'x64')).toBe('(x86_64)')
    expect(processorVariation('linux', 'arm64')).toBe('(arm64)')
    expect(processorVariation('linux', 'ia32')).toBe('(32-bit)')
    expect(processorVariation('darwin', 'arm64')).toBe('(arm64)')
    expect(processorVariation('darwin', 'x64')).toBe('(x86_64)')
    expect(processorVariation('darwin', 'x64', true)).toBe('(x86_64 translated)')
    expect(processorVariation('win32', 'x64')).toBe('(64-bit)')
    expect(processorVariation('win32', 'x64', true)).toBe('(64-bit emulated)')
    expect(processorVariation('win32', 'ia32')).toBe('(32-bit)')
    expect(processorVariation('win32', 'ia32', true)).toBe('(32-bit emulated)')
    expect(processorVariation('win32', 'arm64')).toBe('(arm64)')
    expect(processorVariation('freebsd', 'x64')).toBe('(64-bit)')
  })

  it('reads the primitives from Electron, the process and the session as the page is requested', () => {
    const ses = { getUserAgent: () => 'UA of the session' } as unknown as Session
    const input = readDesktopVersionInput(ses, '/profile/zen')
    expect(input).toMatchObject({
      version: '0.5.9',
      packaged: true,
      platform: process.platform,
      arch: process.arch,
      translated: false,
      v8: process.versions.v8,
      userAgent: 'UA of the session',
      argv: process.argv,
      execPath: process.execPath,
      profilePath: '/profile/zen'
    })
    expect(input.osType).not.toBe('')
    // Read again after a change: nothing is kept from the first read.
    fake.packaged = false
    fake.translated = true
    expect(readDesktopVersionInput(ses, '/profile/zen')).toMatchObject({
      packaged: false,
      translated: true
    })
  })
})

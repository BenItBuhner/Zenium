import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  setAsDefaultProtocolClient: vi.fn<(scheme: string) => boolean>(),
  isDefaultProtocolClient: vi.fn<(scheme: string) => boolean>(),
  getApplicationInfoForProtocol: vi.fn<(url: string) => Promise<{ name: string; path: string }>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  /** `reg.exe query` (Windows registration) and the xdg tools: command → exit ok, stdout. */
  execFile: vi.fn<(command: string, args: string[]) => { ok: boolean; stdout: string }>(),
  release: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: (scheme: string) => fake.setAsDefaultProtocolClient(scheme),
    isDefaultProtocolClient: (scheme: string) => fake.isDefaultProtocolClient(scheme),
    getApplicationInfoForProtocol: (url: string) => fake.getApplicationInfoForProtocol(url)
  },
  shell: { openExternal: (url: string) => fake.openExternal(url) }
}))

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    const r = fake.execFile(command, args)
    callback(r.ok ? null : new Error(`${command} failed`), r.stdout, '')
  }
}))

vi.mock('node:os', () => ({ release: () => fake.release() }))

import { ElectronDefaultBrowser } from '../defaultBrowser'

function onPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true })
}

/** A host whose wait for the user's choice runs `rounds` instant polls. */
function host(rounds = 3): ElectronDefaultBrowser {
  return new ElectronDefaultBrowser({ pollMs: 0, pollRounds: rounds, wait: async () => undefined })
}

let restore: () => void
afterEach(() => {
  restore()
  vi.clearAllMocks()
})

describe('ElectronDefaultBrowser on macOS', () => {
  beforeEach(() => {
    restore = onPlatform('darwin')
    fake.isDefaultProtocolClient.mockReturnValue(false)
  })

  it('asks LaunchServices for http only and resolves unknown while the prompt is unanswered', async () => {
    fake.setAsDefaultProtocolClient.mockReturnValue(true)
    expect(await host().request()).toBeNull()
    expect(fake.setAsDefaultProtocolClient.mock.calls.map(([s]) => s)).toEqual(['http'])
  })

  it('resolves true once the user chooses Zenium, then claims https, and only once', async () => {
    fake.setAsDefaultProtocolClient.mockReturnValue(true)
    let polls = 0
    fake.isDefaultProtocolClient.mockImplementation((scheme) => {
      // The prompt is answered on the second look.
      if (scheme === 'http') return polls++ >= 1
      return false
    })
    const h = host(5)
    expect(await h.request()).toBe(true)
    // http (the request), then https once the user had said yes; LaunchServices did not carry
    // https along on its own.
    expect(fake.setAsDefaultProtocolClient.mock.calls.map(([s]) => s)).toEqual(['http', 'https'])
    expect(await h.isDefault()).toBe(true)
    expect(fake.setAsDefaultProtocolClient).toHaveBeenCalledTimes(2)
  })

  it('is done at once when the user had already chosen Zenium, filling in https if it lags', async () => {
    fake.setAsDefaultProtocolClient.mockReturnValue(true)
    fake.isDefaultProtocolClient.mockImplementation((scheme) => scheme === 'http')
    expect(await host().request()).toBe(true)
    expect(fake.setAsDefaultProtocolClient.mock.calls.map(([s]) => s)).toEqual(['https'])
    fake.setAsDefaultProtocolClient.mockClear()
    fake.isDefaultProtocolClient.mockReturnValue(true)
    expect(await host().request()).toBe(true)
    expect(fake.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('answers false only when the http request itself is refused', async () => {
    fake.setAsDefaultProtocolClient.mockReturnValue(false)
    expect(await host().request()).toBe(false)
  })

  it('reads the status from the http handler alone, like Chrome', async () => {
    fake.isDefaultProtocolClient.mockImplementation((scheme) => scheme === 'http')
    expect(await host().isDefault()).toBe(true)
    expect(fake.isDefaultProtocolClient.mock.calls.map(([s]) => s)).toEqual(['http'])
  })
})

describe('ElectronDefaultBrowser on Windows', () => {
  const exe = 'C:\\Users\\bennett\\AppData\\Local\\Programs\\zenium\\zenium.exe'
  const edge = { name: 'Microsoft Edge', path: 'msedge.exe' }
  let execPath: string

  beforeEach(() => {
    restore = onPlatform('win32')
    execPath = process.execPath
    Object.defineProperty(process, 'execPath', { value: exe, configurable: true })
    fake.release.mockReturnValue('10.0.26100')
    fake.execFile.mockReturnValue({ ok: true, stdout: '' })
    fake.openExternal.mockResolvedValue(undefined)
  })
  afterEach(() =>
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true })
  )

  it("reads the shell's handler for http and https, comparing paths loosely", async () => {
    fake.getApplicationInfoForProtocol.mockResolvedValue({
      name: 'Zenium',
      path: `"${exe.replace(/\\/g, '/').toUpperCase()}"`
    })
    expect(await host().isDefault()).toBe(true)
    fake.getApplicationInfoForProtocol.mockResolvedValue({
      name: 'Microsoft Edge',
      path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    })
    expect(await host().isDefault()).toBe(false)
  })

  it("opens Zenium's own Default apps page on Windows 11 and waits for the user's choice", async () => {
    fake.getApplicationInfoForProtocol.mockResolvedValue(edge)
    expect(await host().request()).toBeNull()
    expect(fake.execFile).toHaveBeenCalledWith('reg.exe', [
      'query',
      'HKCU\\Software\\RegisteredApplications',
      '/v',
      'Zenium'
    ])
    expect(fake.openExternal.mock.calls.map(([u]) => u)).toEqual([
      'ms-settings:defaultapps?registeredAppUser=Zenium'
    ])
  })

  it('resolves true the moment the user picks Zenium in Settings', async () => {
    let looks = 0
    fake.getApplicationInfoForProtocol.mockImplementation(async () =>
      looks++ >= 4 ? { name: 'Zenium', path: exe } : edge
    )
    expect(await host(10).request()).toBe(true)
  })

  it('falls back to the Default apps list when the deep link is refused, and on Windows 10', async () => {
    fake.getApplicationInfoForProtocol.mockResolvedValue(edge)
    fake.openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await host().request()).toBeNull()
    expect(fake.openExternal.mock.calls.map(([u]) => u)).toEqual([
      'ms-settings:defaultapps?registeredAppUser=Zenium',
      'ms-settings:defaultapps'
    ])
    fake.openExternal.mockClear()
    fake.release.mockReturnValue('10.0.19045')
    expect(await host().request()).toBeNull()
    expect(fake.openExternal.mock.calls.map(([u]) => u)).toEqual(['ms-settings:defaultapps'])
  })

  it('answers false without opening Settings when the installer never registered Zenium', async () => {
    fake.getApplicationInfoForProtocol.mockResolvedValue(edge)
    fake.execFile.mockReturnValue({ ok: false, stdout: '' })
    expect(await host().request()).toBe(false)
    expect(fake.openExternal).not.toHaveBeenCalled()
  })

  it('is done at once when Zenium already handles both schemes', async () => {
    fake.getApplicationInfoForProtocol.mockResolvedValue({ name: 'Zenium', path: exe })
    expect(await host().request()).toBe(true)
    expect(fake.openExternal).not.toHaveBeenCalled()
  })
})

describe('ElectronDefaultBrowser on Linux', () => {
  beforeEach(() => {
    restore = onPlatform('linux')
  })

  it('asks xdg-settings and accepts an AppImage integrator prefix', async () => {
    fake.execFile.mockReturnValue({ ok: true, stdout: 'zenium.desktop\n' })
    expect(await host().isDefault()).toBe(true)
    expect(fake.execFile).toHaveBeenCalledWith('xdg-settings', ['get', 'default-web-browser'])
    fake.execFile.mockReturnValue({ ok: true, stdout: 'appimagekit_abc123-zenium.desktop\n' })
    expect(await host().isDefault()).toBe(true)
    fake.execFile.mockReturnValue({ ok: true, stdout: 'firefox.desktop\n' })
    expect(await host().isDefault()).toBe(false)
  })

  it('sets the browser and the MIME defaults, then reports what the desktop says', async () => {
    fake.execFile.mockImplementation((command, args) =>
      command === 'xdg-settings' && args[0] === 'get'
        ? { ok: true, stdout: 'zenium.desktop\n' }
        : { ok: true, stdout: '' }
    )
    expect(await host().request()).toBe(true)
    const calls = fake.execFile.mock.calls.map(([c, a]) => [c, a.slice(0, 2).join(' ')])
    expect(calls).toEqual([
      ['xdg-settings', 'set default-web-browser'],
      ['xdg-mime', 'default zenium.desktop'],
      ['xdg-settings', 'get default-web-browser']
    ])
  })

  it('answers false when the desktop still names another browser afterwards', async () => {
    fake.execFile.mockImplementation((command, args) =>
      command === 'xdg-settings' && args[0] === 'get'
        ? { ok: true, stdout: 'firefox.desktop\n' }
        : { ok: false, stdout: '' }
    )
    expect(await host().request()).toBe(false)
  })
})

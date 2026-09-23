import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The extension preload's decision to install the `chrome.*` shim: it asks the host for its
 * options first (`zen-ext:toggles`, synchronous); the host's null names a context of an extension
 * it never loaded – the engine's own component extensions, Chromium's PDF viewer among them –
 * and the shim stays out so Chromium's `chrome.*` keeps working there.
 */
const electron = vi.hoisted(() => ({
  sendSync: vi.fn(),
  executeInMainWorld: vi.fn()
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    sendSync: electron.sendSync,
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn()
  },
  contextBridge: { executeInMainWorld: electron.executeInMainWorld }
}))

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'
const OWN_EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html'

async function loadPreloadAt(url: string): Promise<void> {
  vi.resetModules()
  Object.defineProperty(globalThis, 'location', { value: { href: url }, configurable: true })
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../extension')
}

function installs(): number {
  return electron.executeInMainWorld.mock.calls.filter(
    ([call]) => typeof call === 'object' && call !== null && 'args' in call
  ).length
}

describe('extension preload: whether the shim installs', () => {
  beforeEach(() => {
    electron.sendSync.mockReset()
    electron.executeInMainWorld.mockReset()
  })
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'location')
  })

  it('installs into a context of an extension the host loaded, with the options it sent', async () => {
    electron.sendSync.mockReturnValue({
      toggles: { userScripts: true },
      storagePrelude: null,
      withheld: null,
      granted: ['storage']
    })
    await loadPreloadAt(OWN_EXTENSION)
    expect(electron.sendSync).toHaveBeenCalledWith('zen-ext:toggles')
    expect(installs()).toBe(1)
    const [call] = electron.executeInMainWorld.mock.calls.find(
      ([c]) => 'args' in (c as object)
    ) as [{ args: unknown[] }]
    expect(call.args[2]).toEqual({ toggles: { userScripts: true }, granted: ['storage'] })
  })

  it('leaves a context the host does not know alone (Chromium’s PDF viewer keeps its own chrome.*)', async () => {
    electron.sendSync.mockReturnValue(null)
    await loadPreloadAt(PDF_VIEWER)
    expect(electron.sendSync).toHaveBeenCalledWith('zen-ext:toggles')
    expect(installs()).toBe(0)
  })

  it('installs with every toggle off when the host cannot be asked', async () => {
    electron.sendSync.mockImplementation(() => {
      throw new Error('no host')
    })
    await loadPreloadAt(OWN_EXTENSION)
    expect(installs()).toBe(1)
    const [call] = electron.executeInMainWorld.mock.calls.find(
      ([c]) => 'args' in (c as object)
    ) as [{ args: unknown[] }]
    expect(call.args[2]).toEqual({ toggles: { userScripts: false } })
  })

  it('does nothing at all in a web page', async () => {
    electron.sendSync.mockReturnValue(null)
    await loadPreloadAt('https://example.com/')
    expect(electron.sendSync).not.toHaveBeenCalled()
    expect(installs()).toBe(0)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import type { DownloadDestination } from '@core/agent/nativePrompts'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

function fakeBridge(): { bridge: Bridge; sent: Array<{ method: string; args: unknown }> } {
  const sent: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      sent.push({ method, args })
      return null
    },
    send: (method: string, args: unknown) => {
      sent.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, sent }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The transfer Kotlin announces for a download whose save dialog would ask where it goes. */
const STARTED = {
  token: 'dl_1',
  url: 'https://files.example/report',
  referrer: '',
  filename: 'report',
  totalBytes: 10,
  mimeType: 'application/pdf',
  savePath: '',
  sourceTabId: 'tab_1',
  canResume: false,
  containerId: 'default',
  saveAs: true
}

/**
 * A browser with the little the `download.started` handler reads: a store with one record, the
 * ask-where-to-save setting on, and an agent that answers the destination when told to.
 */
function downloadsBrowser(): {
  browser: Browser
  record: { id: string; state: string; private: boolean }
  answer: (destination: DownloadDestination) => void
  removed: string[]
} {
  const record = { id: 'd1', state: 'in_progress', private: false }
  const removed: string[] = []
  let answer: (destination: DownloadDestination) => void = () => {}
  const browser = {
    state: { settings: { askWhereToSave: true } },
    downloads: {
      begin: () => record,
      item: (id: string) => (removed.includes(id) ? undefined : record),
      remove: (id: string) => {
        removed.push(id)
      }
    },
    agents: {
      downloadDestination: () =>
        new Promise<DownloadDestination>((resolve) => {
          answer = resolve
        })
    },
    onDownloadStarted: vi.fn()
  } as unknown as Browser
  return { browser, record, answer: (d) => answer(d), removed }
}

describe("an agent's download on Android: the save dialog's question goes to the agent (platform.ts)", () => {
  it("binds a saved download without the dialog, under the agent's name", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const { browser, answer } = downloadsBrowser()
    platform.bind(browser)
    platform.hostEvent('download.started', STARTED)
    expect(sent).toEqual([])
    answer({ kind: 'save', filename: 'quarterly.pdf' })
    await flush()
    expect(sent).toEqual([
      {
        method: 'download.bind',
        args: {
          token: 'dl_1',
          id: 'd1',
          destination: { mode: 'default', agent: { filename: 'quarterly.pdf' } },
          private: false,
          insecureAccepted: false
        }
      }
    ])
  })

  it('refuses the transfer and drops the record when the agent cancels', async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const { browser, answer, removed } = downloadsBrowser()
    platform.bind(browser)
    platform.hostEvent('download.started', STARTED)
    answer({ kind: 'cancel' })
    await flush()
    expect(sent).toEqual([{ method: 'download.refuse', args: { token: 'dl_1' } }])
    expect(removed).toEqual(['d1'])
  })

  it("refuses the transfer when the record went while the agent was asked, so Kotlin's live set does not keep it", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const { browser, record, answer, removed } = downloadsBrowser()
    platform.bind(browser)
    platform.hostEvent('download.started', STARTED)
    record.state = 'cancelled'
    answer({ kind: 'save', filename: 'quarterly.pdf' })
    await flush()
    expect(sent).toEqual([{ method: 'download.refuse', args: { token: 'dl_1' } }])
    // The user's own cancel removed what it wanted removed; nothing more is touched.
    expect(removed).toEqual([])
  })
})

describe("an agent's client certificate on Android (platform.ts)", () => {
  const REQUEST = {
    requestId: 'cert_1',
    tabId: 'tab_1',
    host: 'intranet.example',
    port: 443,
    certificates: [
      {
        fingerprint: 'sha256/a',
        subject: 'Ada',
        issuer: 'Analytical CA',
        serialNumber: '1f',
        validFrom: 1,
        validTo: 2
      }
    ]
  }

  it("answers `user` for a tab that is not an agent's, without asking the chooser", () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const clientCertificate = vi.fn()
    platform.bind({
      agents: { takesPrompt: () => false, refuseClientCertificate: vi.fn() },
      security: { clientCertificate }
    } as unknown as Browser)
    platform.hostEvent('certificate.request', REQUEST)
    expect(sent).toEqual([
      { method: 'certificate.respond', args: { requestId: 'cert_1', user: true } }
    ])
    expect(clientCertificate).not.toHaveBeenCalled()
  })

  it("routes the described certificates through the core's chooser and answers with its index, once", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const refuse = vi.fn()
    const clientCertificate = vi.fn(async () => 0)
    platform.bind({
      agents: { takesPrompt: () => true, refuseClientCertificate: refuse },
      security: { clientCertificate }
    } as unknown as Browser)
    platform.hostEvent('certificate.request', REQUEST)
    await flush()
    expect(clientCertificate).toHaveBeenCalledWith(
      'intranet.example',
      [
        {
          fingerprint: 'sha256/a',
          subject: 'Ada',
          issuer: 'Analytical CA',
          serialNumber: '1f',
          validFrom: 1,
          validTo: 2
        }
      ],
      'tab_1'
    )
    expect(refuse).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { method: 'certificate.respond', args: { requestId: 'cert_1', index: 0 } }
    ])
  })

  it('with nothing to offer, tells the agent why and continues without a certificate', async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const refuse = vi.fn()
    platform.bind({
      agents: { takesPrompt: () => true, refuseClientCertificate: refuse },
      security: { clientCertificate: vi.fn(async () => null) }
    } as unknown as Browser)
    platform.hostEvent('certificate.request', { ...REQUEST, certificates: [] })
    await flush()
    expect(refuse).toHaveBeenCalledWith('tab_1', 'intranet.example')
    expect(sent).toEqual([
      { method: 'certificate.respond', args: { requestId: 'cert_1', index: null } }
    ])
  })
})

describe("a view's word for the agent driving its tab (AndroidTabViewHost.agentNotices)", () => {
  it("reaches the driving session's notices once the core is bound, and no one before", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const notices: string[] = []
    platform.views.createView(
      { id: 'tab_1', containerId: 'default', url: 'https://example.com' } as never,
      {
        onFileChooser: async () => ({
          kind: 'files',
          files: [{ path: '/data/data/app.zen.chromium/x' }]
        })
      } as never
    )
    platform.viewEvent('tab_1', 'fileChooser', { requestId: 'fc_1' })
    await flush()
    expect(notices).toEqual([])
    platform.bind({
      agents: { driver: (tabId: string) => (tabId === 'tab_1' ? { notices } : undefined) }
    } as unknown as Browser)
    platform.viewEvent('tab_1', 'fileChooser', { requestId: 'fc_2' })
    await flush()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('/data/data/app.zen.chromium/x')
    expect(sent.filter((c) => c.method === 'view.fileChooserAnswer')).toEqual([
      {
        method: 'view.fileChooserAnswer',
        args: { tabId: 'tab_1', requestId: 'fc_1', kind: 'cancel' }
      },
      {
        method: 'view.fileChooserAnswer',
        args: { tabId: 'tab_1', requestId: 'fc_2', kind: 'cancel' }
      }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
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

const CONFIRM = {
  dialogId: 'pd_1',
  kind: 'confirm',
  message: 'Delete everything?',
  frameUrl: 'https://example.com/a',
  pageUrl: 'https://example.com/a'
}

describe("an agent-driven tab's page dialogs on Android (platform.ts, OS-40 part B)", () => {
  it('advertises browser_handle_dialog: Android routes page dialogs to the agent', () => {
    const { bridge } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    expect(platform.capabilities.agentDialogs).toBe(true)
  })

  it("asks the core's agents whether the tab's dialogs are theirs, and answers Kotlin with the agent's word", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const takesDialog = vi.fn((tabId: string) => tabId === 'tab_1')
    const dismissAgentDialog = vi.fn()
    platform.views.createView(
      { id: 'tab_1', containerId: 'default', url: 'https://example.com' } as never,
      { onDialog: async () => ({ accepted: true, value: null }) } as never
    )
    platform.bind({ agents: { takesDialog, dismissAgentDialog } } as unknown as Browser)
    platform.viewEvent('tab_1', 'pageDialog', CONFIRM)
    await flush()
    expect(takesDialog).toHaveBeenCalledWith('tab_1')
    expect(sent.filter((c) => c.method === 'view.pageDialogAnswer')).toEqual([
      {
        method: 'view.pageDialogAnswer',
        args: { tabId: 'tab_1', dialogId: 'pd_1', user: false, accepted: true, value: null }
      }
    ])
    expect(dismissAgentDialog).not.toHaveBeenCalled()
  })

  it("leaves the dialog to Kotlin's own sheet while no core is bound, and when the tab is the user's", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const onDialog = vi.fn(async () => ({ accepted: true, value: null }))
    platform.views.createView(
      { id: 'tab_1', containerId: 'default', url: 'https://example.com' } as never,
      { onDialog } as never
    )
    platform.viewEvent('tab_1', 'pageDialog', CONFIRM)
    platform.bind({
      agents: { takesDialog: () => false, dismissAgentDialog: vi.fn() }
    } as unknown as Browser)
    platform.viewEvent('tab_1', 'pageDialog', { ...CONFIRM, dialogId: 'pd_2' })
    await flush()
    expect(onDialog).not.toHaveBeenCalled()
    expect(sent.filter((c) => c.method === 'view.pageDialogAnswer')).toEqual([
      { method: 'view.pageDialogAnswer', args: { tabId: 'tab_1', dialogId: 'pd_1', user: true } },
      { method: 'view.pageDialogAnswer', args: { tabId: 'tab_1', dialogId: 'pd_2', user: true } }
    ])
  })

  it("tells the core's agents when Kotlin cancelled a held dialog because the tab stopped being agent-driven", async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    const dismissAgentDialog = vi.fn()
    let answer: (response: { accepted: boolean; value: string | null }) => void = () => {}
    platform.views.createView(
      { id: 'tab_1', containerId: 'default', url: 'https://example.com' } as never,
      {
        onDialog: () =>
          new Promise<{ accepted: boolean; value: string | null }>((resolve) => {
            answer = resolve
          })
      } as never
    )
    platform.bind({
      agents: { takesDialog: () => true, dismissAgentDialog }
    } as unknown as Browser)
    platform.viewEvent('tab_1', 'pageDialog', CONFIRM)
    platform.viewEvent('tab_1', 'pageDialogGone', { dialogId: 'pd_1' })
    expect(dismissAgentDialog).toHaveBeenCalledWith('tab_1')
    answer({ accepted: true, value: null })
    await flush()
    expect(sent.filter((c) => c.method === 'view.pageDialogAnswer')).toEqual([])
  })
})

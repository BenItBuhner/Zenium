import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
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

const bridge = {
  call: async () => null,
  callSync: () => null,
  send: () => undefined
} as unknown as Bridge

/** A platform with a window and a browser that records what the host event made it do. */
function platformWithBrowser(): {
  platform: AndroidPlatform
  emit: ReturnType<typeof vi.fn>
  handleCommand: ReturnType<typeof vi.fn>
  win: ZenWindow
} {
  const platform = new AndroidPlatform(bridge, BOOT)
  const win = { id: 1 } as unknown as ZenWindow
  ;(platform as unknown as { zenWindow: ZenWindow }).zenWindow = win
  const emit = vi.fn()
  const handleCommand = vi.fn()
  platform.bind({ emit, handleCommand } as unknown as Browser)
  return { platform, emit, handleCommand, win }
}

/**
 * Paste and go / Paste and search touched in the omnibox field's floating toolbar (OMN-23):
 * Kotlin's `FieldActionMode` sends `urlbar.paste` with the action its item carried and the tab
 * the field was editing for, and the platform runs the command the chrome context menu's item
 * runs (#119's `urlbar.pasteAndGo` / `urlbar.pasteAndSearch`) after closing the bar, as that
 * item does. The clipboard is read by the command, once, not here.
 */
describe('the urlbar.paste host event', () => {
  it('closes the bar and runs Paste and Go for the tab the field was editing for', () => {
    const { platform, emit, handleCommand, win } = platformWithBrowser()
    platform.hostEvent('urlbar.paste', { action: 'go', tabId: 'tab_1' })
    expect(emit).toHaveBeenCalledWith('urlbar.close', undefined, win)
    expect(handleCommand).toHaveBeenCalledWith(win, 'urlbar.pasteAndGo', { tabId: 'tab_1' })
    // The bar closes before the command loads anything, as a submit's order is.
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(handleCommand.mock.invocationCallOrder[0])
  })

  it('runs Paste and Search for text the system read as no link', () => {
    const { platform, handleCommand, win } = platformWithBrowser()
    platform.hostEvent('urlbar.paste', { action: 'search', tabId: 'tab_1' })
    expect(handleCommand).toHaveBeenCalledWith(win, 'urlbar.pasteAndSearch', { tabId: 'tab_1' })
  })

  it('names no tab for the new-tab bar’s field, so the command opens a new tab', () => {
    const { platform, handleCommand, win } = platformWithBrowser()
    platform.hostEvent('urlbar.paste', { action: 'go', tabId: null })
    expect(handleCommand).toHaveBeenCalledWith(win, 'urlbar.pasteAndGo', { tabId: null })
    // Kotlin's JSON may leave the tab out altogether, or hand something that is not a tab id.
    platform.hostEvent('urlbar.paste', { action: 'go' } as never)
    platform.hostEvent('urlbar.paste', { action: 'go', tabId: 7 } as never)
    expect(handleCommand).toHaveBeenCalledTimes(3)
    expect(handleCommand.mock.calls.every((call) => call[2].tabId === null)).toBe(true)
  })

  it('runs nothing, and keeps the bar, for an action that is neither', () => {
    const { platform, emit, handleCommand } = platformWithBrowser()
    platform.hostEvent('urlbar.paste', { action: 'paste', tabId: 'tab_1' } as never)
    platform.hostEvent('urlbar.paste', { tabId: 'tab_1' } as never)
    platform.hostEvent('urlbar.paste', null as never)
    expect(emit).not.toHaveBeenCalled()
    expect(handleCommand).not.toHaveBeenCalled()
  })

  // The command the event runs reads the clipboard through `ClipboardHost.readText` and does
  // nothing for a host without one (core/browser.ts `pasteAndGo`): the phone has it, on the same
  // host read as the clipboard row's reveal (ClipboardPeek.read).
  it('gives the core the clipboard read that Paste and go runs on', async () => {
    const call = vi.fn(async (name: string) =>
      name === 'clipboard.read' ? ' http://a.example/ ' : null
    )
    const platform = new AndroidPlatform({ ...bridge, call } as unknown as Bridge, BOOT)
    expect(platform.clipboard.readText).toBeTypeOf('function')
    await expect(platform.clipboard.readText!()).resolves.toBe(' http://a.example/ ')
    expect(call).toHaveBeenCalledWith('clipboard.read', {})
  })
})

import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidTabView } from '../views'

function fakeBridge(): { bridge: Bridge; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      return null
    },
    send: (method: string, args: unknown) => {
      calls.push({ method, args })
    }
  } as unknown as Bridge
  return { bridge, calls }
}

describe('AndroidTabView.executeJavaScript', () => {
  it('passes expressions through and wraps statement lists into a function', async () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    await view.executeJavaScript('document.title')
    await view.executeJavaScript('(() => { for (const el of []) el.remove(); return true })()')
    await view.executeJavaScript(
      "for (const el of document.querySelectorAll('x')) el.style.visibility = 'hidden'"
    )
    await view.executeJavaScript("history.forward(); 'forwarded'")
    const codes = calls.map((c) => (c.args as { code: string }).code)
    expect(codes[0]).toBe('document.title')
    expect(codes[1]).toBe('(() => { for (const el of []) el.remove(); return true })()')
    expect(codes[2]).toMatch(/^\(\(\) => \{ for \(const el of/)
    expect(codes[3]).toMatch(/^\(\(\) => \{ history\.forward\(\); 'forwarded'/)
  })

  it('sends capture requests with the mode, region and format', async () => {
    const { bridge, calls } = fakeBridge()
    const view = new AndroidTabView('tab_1', bridge)
    await view.capture({
      mode: 'region',
      format: 'png',
      region: { x: 1, y: 2, width: 3, height: 4 }
    })
    await view.capture({ mode: 'fullPage', format: 'jpeg' })
    expect(calls[0]).toEqual({
      method: 'view.capture',
      args: {
        tabId: 'tab_1',
        mode: 'region',
        region: { x: 1, y: 2, width: 3, height: 4 },
        format: 'png'
      }
    })
    expect(calls[1]).toEqual({
      method: 'view.capture',
      args: { tabId: 'tab_1', mode: 'fullPage', region: null, format: 'jpeg' }
    })
  })
})

import { describe, expect, it } from 'vitest'
import { CAPTURE_QUOTA_ERROR } from '@core/extensions/api/capture'
import { type Harness, ID, backgroundUp, call, harness, manifest, record } from './runtimeHarness'

async function withExtension(h: Harness, overrides: Record<string, unknown> = {}): Promise<void> {
  await h.runtime.attach(
    record(
      h,
      {},
      manifest({
        permissions: ['tabs', 'activeTab', 'storage'],
        host_permissions: ['<all_urls>'],
        ...overrides
      })
    )
  )
  backgroundUp(h, 'bg1')
}

describe('chrome.tabs.captureVisibleTab', () => {
  it('captures the active tab through view.capture as a data: URL, JPEG at Chrome quality by default', async () => {
    const h = harness()
    await withExtension(h)
    const reply = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(reply.ok).toBe(true)
    expect(reply.result).toBe('data:image/jpeg;base64,AAAA')
    const shots = h.kt.calledWith('view.capture')
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({
      tabId: 't1',
      mode: 'viewport',
      format: 'jpeg',
      quality: 90
    })
  })

  it('passes the format and quality the extension asked for, and accepts the current window id', async () => {
    const h = harness()
    await withExtension(h)
    const png = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [-2, { format: 'png' }])
    expect(png.result).toBe('data:image/png;base64,AAAA')
    const jpeg = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [
      1,
      { format: 'jpeg', quality: 40 }
    ])
    expect(jpeg.ok).toBe(true)
    const shots = h.kt.calledWith('view.capture')
    expect(shots.map((s) => [s.format, s.quality])).toEqual([
      ['png', 90],
      ['jpeg', 40]
    ])
  })

  it('rejects bad options with the binding error and unknown windows', async () => {
    const h = harness()
    await withExtension(h)
    const bad = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [undefined, { format: 'gif' }])
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toContain(
      "Error at property 'format': Value must be one of jpeg, png."
    )
    const quality = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [undefined, { quality: 101 }])
    expect(String(quality.error)).toContain('Value must not be greater than 100.')
    const noWindow = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [7])
    expect(noWindow.ok).toBe(false)
    expect(noWindow.error).toBe('No window with id: 7.')
    expect(h.kt.calledWith('view.capture')).toHaveLength(0)
  })

  it('enforces the two calls per second quota per extension, on the runtime clock', async () => {
    const h = harness()
    await withExtension(h)
    expect((await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])).ok).toBe(true)
    expect((await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])).ok).toBe(true)
    const third = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(third.ok).toBe(false)
    expect(third.error).toBe(CAPTURE_QUOTA_ERROR)
    h.clock.now += 1000
    expect((await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])).ok).toBe(true)
  })

  it('needs <all_urls> or an activeTab grant on the tab', async () => {
    const h = harness()
    await withExtension(h, { host_permissions: ['https://example.com/*'] })
    const denied = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(denied.ok).toBe(false)
    expect(denied.error).toBe("Either the '<all_urls>' or 'activeTab' permission is required.")
    // The toolbar click grants activeTab on the tab the user is looking at.
    h.runtime.openPopup(ID)
    const granted = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(granted.ok).toBe(true)
    expect(granted.result).toBe('data:image/jpeg;base64,AAAA')
  })

  it("<all_urls> alone stops at the browser's own pages and, without file access, file: pages", async () => {
    const h = harness()
    await withExtension(h, { permissions: ['tabs', 'storage'] })
    h.tabs.t1.url = 'zen://settings'
    const internal = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(internal.error).toBe('Cannot access a zen:// URL')
    h.tabs.t1.url = 'file:///sdcard/page.html'
    const file = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(String(file.error)).toContain('Cannot access contents of url "file:///sdcard/page.html"')
    // The quota counts refused calls too (Chrome checks it before the page).
    h.clock.now += 1000
    // Its own pages are always capturable; another extension's are not.
    h.tabs.t1.url = `chrome-extension://${ID}/popup.html`
    expect((await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])).ok).toBe(true)
    h.tabs.t1.url = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup.html'
    const other = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(other.error).toBe('Cannot access a chrome-extension:// URL of different extension')
  })

  it('reports a view that cannot be copied, a missing active tab and a failed copy the way Chrome does', async () => {
    const h = harness()
    await withExtension(h)
    h.kt.capture = () => null
    const invisible = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(invisible.error).toBe('Failed to capture tab: view is invisible')
    h.kt.capture = () => {
      throw new Error('PixelCopy failed')
    }
    const failed = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(failed.error).toBe('Failed to capture tab: unknown error')
    h.active.id = null
    h.kt.capture = () => ({ data: 'AAAA', mimeType: 'image/jpeg' })
    // Two calls went out already this second; the clock moves on for the next.
    h.clock.now += 1000
    const none = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(none.error).toBe('Failed to capture tab: view is invisible')
  })

  it('a private tab the extension may not see is no active tab', async () => {
    const h = harness()
    await withExtension(h)
    h.tabs.t1.containerId = 'private'
    const hidden = await call(h, 'bg1', 'tabs', 'captureVisibleTab', [])
    expect(hidden.error).toBe('Failed to capture tab: view is invisible')
    expect(h.kt.calledWith('view.capture')).toHaveLength(0)
  })
})

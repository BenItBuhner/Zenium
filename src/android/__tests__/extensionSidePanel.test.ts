import { describe, expect, it } from 'vitest'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  events,
  harness,
  hello,
  manifest,
  record
} from './runtimeHarness'

const PANEL_URL = `https://${ID}.ext.zenium.invalid/panel.html`

/** Tag Assistant's shape: a `side_panel.default_path`, the permission, an action with no popup. */
async function withPanel(h: Harness, overrides: Record<string, unknown> = {}): Promise<void> {
  await h.runtime.attach(
    record(
      h,
      {},
      manifest({
        permissions: ['sidePanel', 'tabs'],
        side_panel: { default_path: 'panel.html' },
        action: { default_title: 'Tag Assistant' },
        ...overrides
      })
    )
  )
  backgroundUp(h, 'bg1', ['action.onClicked', 'sidePanel.onOpened', 'sidePanel.onClosed'])
  // Chrome tab ids are handed out as extensions meet the tabs; the query gives the one tab id 1.
  await call(h, 'bg1', 'tabs', 'query', [{}])
}

function sheets(h: Harness): Record<string, unknown>[] {
  return h.kt.calledWith('ext.popup.open')
}

describe('chrome.sidePanel on the phone: the panel document in the runtime sheet', () => {
  it('opens the manifest panel for the active tab as a sidePanel sheet and fires onOpened / onClosed', async () => {
    const h = harness()
    await withPanel(h)
    const opened = await call(h, 'bg1', 'sidePanel', 'open', [{ tabId: 1 }])
    expect(opened.ok).toBe(true)
    expect(sheets(h)).toEqual([
      { id: ID, url: PANEL_URL, context: 'sidePanel', title: 'Runtime test' }
    ])
    expect(h.runtime.api.sidePanel.showing()).toBe(ID)
    const onOpened = events(h, 'bg1', 'sidePanel.onOpened')
    expect(onOpened).toHaveLength(1)
    // The global panel: Chrome's info names the page and the window, no tab.
    expect(onOpened[0].args).toEqual([{ path: 'panel.html', windowId: 1 }])
    // The user dismissed the sheet: Kotlin says so, the extension hears onClosed.
    h.runtime.onPopupClosed()
    expect(h.runtime.api.sidePanel.showing()).toBeNull()
    expect(events(h, 'bg1', 'sidePanel.onClosed')[0].args).toEqual([
      { path: 'panel.html', windowId: 1 }
    ])
  })

  it('the action tap opens the panel when setPanelBehavior asks for it, and toggles it closed; action.openPopup from the API keeps the popup', async () => {
    const h = harness()
    await withPanel(h)
    // Without the behaviour the tap is an onClicked (no popup declared).
    h.runtime.openPopup(ID)
    expect(events(h, 'bg1', 'action.onClicked')).toHaveLength(1)
    expect(sheets(h)).toHaveLength(0)
    const behavior = await call(h, 'bg1', 'sidePanel', 'setPanelBehavior', [
      { openPanelOnActionClick: true }
    ])
    expect(behavior.ok).toBe(true)
    expect((await call(h, 'bg1', 'sidePanel', 'getPanelBehavior', [])).result).toEqual({
      openPanelOnActionClick: true
    })
    h.runtime.openPopup(ID)
    expect(sheets(h)).toHaveLength(1)
    expect(sheets(h)[0]).toMatchObject({ context: 'sidePanel', url: PANEL_URL })
    expect(events(h, 'bg1', 'action.onClicked')).toHaveLength(1)
    // The tap again while the panel shows: the sheet goes (Chrome's toggle).
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    expect(events(h, 'bg1', 'sidePanel.onClosed')).toHaveLength(1)
    // `action.openPopup()` from the API is the popup's (here: none, so onClicked), not the panel's.
    h.runtime.openPopup(ID, true)
    expect(events(h, 'bg1', 'action.onClicked')).toHaveLength(2)
    expect(sheets(h)).toHaveLength(1)
    // The behaviour outlives the session, as on the desktop.
    const saved = h.saved('extensions-runtime.json')
    expect(saved.sidePanelOnActionClick).toEqual({ [ID]: true })
    const next = harness({ files: h.files })
    await withPanel(next)
    expect(next.runtime.api.sidePanel.opensOnActionClick(next.runtime.attached(ID)!)).toBe(true)
  })

  it('answers with Chrome messages: no permission, no target, no tab, no panel for the tab or window', async () => {
    const h = harness()
    await withPanel(h)
    expect((await call(h, 'bg1', 'sidePanel', 'open', [{}])).error).toBe(
      'At least one of `windowId` or `tabId` must be specified.'
    )
    expect((await call(h, 'bg1', 'sidePanel', 'open', [{ tabId: 99 }])).error).toBe(
      'No tab with id: 99.'
    )
    expect((await call(h, 'bg1', 'sidePanel', 'open', [{ windowId: 7 }])).error).toBe(
      'No window with id: 7.'
    )
    // The panel switched off for the tab: nothing to open there, the global one still on the window.
    await call(h, 'bg1', 'sidePanel', 'setOptions', [{ tabId: 1, enabled: false }])
    expect((await call(h, 'bg1', 'sidePanel', 'open', [{ tabId: 1 }])).error).toBe(
      'No active side panel for tabId: 1'
    )
    expect((await call(h, 'bg1', 'sidePanel', 'open', [{ windowId: -2 }])).error).toBe(
      'No active side panel for windowId: -2'
    )
    expect((await call(h, 'bg1', 'sidePanel', 'getLayout', [])).result).toEqual({ side: 'right' })

    const without = harness()
    await without.runtime.attach(
      record(
        without,
        {},
        manifest({ permissions: ['tabs'], side_panel: { default_path: 'p.html' } })
      )
    )
    backgroundUp(without, 'bg1')
    expect((await call(without, 'bg1', 'sidePanel', 'open', [{ tabId: 1 }])).error).toBe(
      "The extension does not have the 'sidePanel' permission."
    )
  })

  it('tab-specific options: their own page, the tab in onOpened, close(tabId) semantics, gone with the tab', async () => {
    const h = harness()
    await withPanel(h)
    await call(h, 'bg1', 'sidePanel', 'setOptions', [{ tabId: 1, path: 'tab.html' }])
    expect((await call(h, 'bg1', 'sidePanel', 'getOptions', [{ tabId: 1 }])).result).toEqual({
      tabId: 1,
      path: 'tab.html'
    })
    expect((await call(h, 'bg1', 'sidePanel', 'getOptions', [])).result).toEqual({
      path: 'panel.html',
      enabled: true
    })
    await call(h, 'bg1', 'sidePanel', 'open', [{ tabId: 1, windowId: -2 }])
    expect(sheets(h)[0]).toMatchObject({ url: `https://${ID}.ext.zenium.invalid/tab.html` })
    expect(events(h, 'bg1', 'sidePanel.onOpened')[0].args).toEqual([
      { path: 'tab.html', windowId: 1, tabId: 1 }
    ])
    // `close` with a tab that shows the global panel only is refused; the tab-specific one closes.
    const closed = await call(h, 'bg1', 'sidePanel', 'close', [{ tabId: 1 }])
    expect(closed.ok).toBe(true)
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    expect(events(h, 'bg1', 'sidePanel.onClosed')).toHaveLength(1)
    // Closing what is not open is a no-op.
    expect((await call(h, 'bg1', 'sidePanel', 'close', [{ windowId: 1 }])).ok).toBe(true)
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    // The tab closes: its options go with it (a tab reusing the id starts from the defaults).
    h.runtime.api.tabRemoved(1)
    expect((await call(h, 'bg1', 'sidePanel', 'getOptions', [{ tabId: 1 }])).result).toEqual({
      path: 'panel.html',
      enabled: true
    })
  })

  it('setOptions while the panel shows: a disabled panel closes the sheet, another popup or options sheet closes it too', async () => {
    const h = harness()
    await withPanel(h, { options_ui: { page: 'options.html' } })
    await call(h, 'bg1', 'sidePanel', 'open', [{ windowId: 1 }])
    await call(h, 'bg1', 'sidePanel', 'setOptions', [{ enabled: false }])
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    expect(events(h, 'bg1', 'sidePanel.onClosed')).toHaveLength(1)
    await call(h, 'bg1', 'sidePanel', 'setOptions', [{ enabled: true }])
    await call(h, 'bg1', 'sidePanel', 'open', [{ windowId: 1 }])
    expect(h.runtime.api.sidePanel.showing()).toBe(ID)
    // The options page takes the sheet: the panel is closed to its extension.
    h.runtime.openOptions(ID)
    expect(h.runtime.api.sidePanel.showing()).toBeNull()
    expect(events(h, 'bg1', 'sidePanel.onClosed')).toHaveLength(2)
    expect(sheets(h).map((s) => s.context)).toEqual(['sidePanel', 'sidePanel', 'options'])
  })

  it('a sidePanel document is a shown, focused service worker client with the SIDE_PANEL context type', async () => {
    const h = harness()
    await withPanel(h)
    await call(h, 'bg1', 'sidePanel', 'open', [{ windowId: 1 }])
    hello(h, 'panel1', 'sidePanel', { url: PANEL_URL })
    const contexts = await call(h, 'bg1', 'runtime', 'getContexts', [{}])
    const kinds = (contexts.result as Array<Record<string, unknown>>).map((c) => c.contextType)
    expect(kinds).toContain('SIDE_PANEL')
  })
})

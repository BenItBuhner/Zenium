import { describe, expect, it, vi } from 'vitest'
import type { TabView, TabViewEvents } from '../../../core/platform'
import type { ZenWindow } from '../../../core/window'
import type { Tab, WindowKind } from '../../../shared/types'
import { popupWindowOpenTicket, type PopupOpenerHost } from '../extensionPopupOpen'

/** Secure Shell's connection dialog: `lib.f.openWindow(url, '', features)` in libdot. */
const NASSH_FEATURES =
  'chrome=no,close=yes,resize=yes,scrollbars=yes,minimizable=yes,top=0,left=0,height=600,width=900'

interface World {
  win: ZenWindow
  made: ZenWindow
  view: TabView
  adopted: { tab: Tab; events: TabViewEvents }
  createWindow: ReturnType<typeof vi.fn>
  adoptView: ReturnType<typeof vi.fn>
  host: PopupOpenerHost
}

function world(kind: WindowKind = 'synced', windowsCapable = true): World {
  const win = { id: 'w1', kind } as unknown as ZenWindow
  const made = { id: 'w2', kind: 'unsynced' } as unknown as ZenWindow
  const view = { id: 'guest' } as unknown as TabView
  const adopted = { tab: { id: 'ignored' } as Tab, events: {} as TabViewEvents }
  const createWindow = vi.fn(() => made)
  const adoptView = vi.fn(() => adopted)
  const host: PopupOpenerHost = {
    win,
    activeTabId: 't1',
    windowsCapable,
    createWindow,
    adoptView
  }
  return { win, made, view, adopted, createWindow, adoptView, host }
}

describe('popupWindowOpenTicket', () => {
  it("gives window.open() with no URL (libdot's noopener idiom) a page at about:blank in a sized window, as Chrome does", () => {
    const w = world()
    const ticket = popupWindowOpenTicket('about:blank', 'new-window', NASSH_FEATURES, w.host)
    expect(ticket).toMatchObject({ action: 'window', url: 'about:blank' })
    expect(ticket?.adopt(w.view)).toBe(w.adopted)
    expect(w.createWindow).toHaveBeenCalledWith({
      kind: 'unsynced',
      from: w.win,
      chrome: 'popup',
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      empty: true
    })
    expect(w.adoptView).toHaveBeenCalledWith(
      w.view,
      { tabId: expect.stringMatching(/^tab/), parentTabId: null, active: true },
      w.made
    )
  })

  it('opens a URL without features as a tab next to the active one, in the popup’s window', () => {
    const w = world()
    const ticket = popupWindowOpenTicket('https://example.net/', 'foreground-tab', '', w.host)
    expect(ticket).toMatchObject({ action: 'tab', url: 'https://example.net/' })
    ticket?.adopt(w.view)
    expect(w.createWindow).not.toHaveBeenCalled()
    expect(w.adoptView).toHaveBeenCalledWith(
      w.view,
      { tabId: expect.stringMatching(/^tab/), parentTabId: 't1', active: true },
      w.win
    )
  })

  it('opens an empty window.open() without features as a tab too', () => {
    const w = world()
    const ticket = popupWindowOpenTicket('about:blank', 'foreground-tab', '', w.host)
    expect(ticket?.action).toBe('tab')
    ticket?.adopt(w.view)
    expect(w.adoptView).toHaveBeenCalledWith(
      w.view,
      expect.objectContaining({ parentTabId: 't1' }),
      w.win
    )
  })

  it('keeps a sized open in a tab on a host without windows of its own', () => {
    const w = world('synced', false)
    const ticket = popupWindowOpenTicket('about:blank', 'new-window', NASSH_FEATURES, w.host)
    expect(ticket?.action).toBe('tab')
    ticket?.adopt(w.view)
    expect(w.createWindow).not.toHaveBeenCalled()
    expect(w.adoptView).toHaveBeenCalledWith(
      w.view,
      expect.objectContaining({ parentTabId: 't1' }),
      w.win
    )
  })

  it('keeps a private popup’s new window private', () => {
    const w = world('private')
    popupWindowOpenTicket('about:blank', 'new-window', NASSH_FEATURES, w.host)?.adopt(w.view)
    expect(w.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'private', chrome: 'popup' })
    )
  })

  it("refuses the browser's own documents, as the tab path does", () => {
    const w = world()
    expect(popupWindowOpenTicket('zen://settings', 'foreground-tab', '', w.host)).toBeNull()
    expect(
      popupWindowOpenTicket('zenium://history', 'new-window', NASSH_FEATURES, w.host)
    ).toBeNull()
    expect(popupWindowOpenTicket('javascript:alert(1)', 'foreground-tab', '', w.host)).toBeNull()
  })
})

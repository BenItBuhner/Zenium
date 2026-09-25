import { describe, expect, it, vi } from 'vitest'
import type { HandlerDetails, WebContents } from 'electron'
import type { TabView, TabViewEvents, WindowOpenTicket } from '../../../core/platform'
import type { ZenWindow } from '../../../core/window'
import type { Tab } from '../../../shared/types'
import {
  extensionPageOpenHandler,
  type ExtensionPageOpenHost,
  type TicketViews
} from '../extensionPopupOpen'

const PANEL_URL = 'chrome-extension://iodihamcpbpeioajjeobimgagajmlibd/html/nassh_panel.html'
/** Secure Shell's connection dialog: `lib.f.openWindow(url, '', features)` in libdot. */
const NASSH_FEATURES =
  'chrome=no,close=yes,resize=yes,scrollbars=yes,minimizable=yes,top=0,left=0,height=600,width=900'

interface World {
  win: ZenWindow
  made: ZenWindow
  active: Tab
  openerView: { id: string }
  guest: WebContents
  opened: ReturnType<typeof vi.fn>
  fellBack: ReturnType<typeof vi.fn>
  createTab: ReturnType<typeof vi.fn>
  createWindow: ReturnType<typeof vi.fn>
  adoptView: ReturnType<typeof vi.fn>
  openTicket: ReturnType<typeof vi.fn>
  tickets: WindowOpenTicket[]
  host: ExtensionPageOpenHost
}

function world(opts: { views?: boolean; window?: boolean; activeView?: boolean } = {}): World {
  const win = { id: 'w1', kind: 'synced', isPrivate: false } as unknown as ZenWindow
  const made = { id: 'w2', kind: 'unsynced' } as unknown as ZenWindow
  const active = { id: 't1', url: 'https://example.com/' } as Tab
  const openerView = { id: 'opener-view' }
  const guest = { id: 77 } as unknown as WebContents
  const tickets: WindowOpenTicket[] = []
  const openTicket = vi.fn((ticket: WindowOpenTicket, _opener: unknown, page: WebContents) => {
    tickets.push(ticket)
    ticket.adopt({ id: 'adopted-view' } as unknown as TabView)
    return page
  })
  const views =
    opts.views === false
      ? undefined
      : ({
          viewForTab: (tabId: string) =>
            tabId === active.id && opts.activeView !== false ? openerView : undefined,
          openTicket
        } as unknown as TicketViews)
  const opened = vi.fn()
  const fellBack = vi.fn()
  const createTab = vi.fn()
  const createWindow = vi.fn(() => made)
  const adoptView = vi.fn(() => ({ tab: { id: 'adopted' } as Tab, events: {} as TabViewEvents }))
  const host: ExtensionPageOpenHost = {
    views,
    windowFor: () => (opts.window === false ? undefined : win),
    browser: {
      tabs: { activeTabFor: (w) => (w === win ? active : undefined), createTab, adoptView },
      state: { capabilities: { windows: true } },
      createWindow
    },
    opened,
    fellBack
  }
  return {
    win,
    made,
    active,
    openerView,
    guest,
    opened,
    fellBack,
    createTab,
    createWindow,
    adoptView,
    openTicket,
    tickets,
    host
  }
}

function details(url: string, features = '', disposition = 'new-window'): HandlerDetails {
  return {
    url,
    frameName: '',
    features,
    disposition: disposition as HandlerDetails['disposition'],
    referrer: { url: PANEL_URL, policy: 'default' }
  }
}

describe('extensionPageOpenHandler (side panel, API popup window, action popup)', () => {
  it("gives a sized window.open() with no URL (libdot's noopener idiom) a real page in a toolbar-only window, then reports the open a tick later", async () => {
    const w = world()
    const handler = extensionPageOpenHandler(w.host)
    const answer = handler(details('about:blank', NASSH_FEATURES))
    expect(answer).toMatchObject({ action: 'allow', outlivesOpener: true })
    expect(w.fellBack).not.toHaveBeenCalled()
    const create = (answer as { createWindow: (o: unknown) => WebContents }).createWindow
    expect(create({ webContents: w.guest })).toBe(w.guest)
    expect(w.openTicket).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'window', url: 'about:blank' }),
      w.openerView,
      w.guest,
      { httpReferrer: { url: PANEL_URL, policy: 'default' } }
    )
    expect(w.createWindow).toHaveBeenCalledWith({
      kind: 'unsynced',
      from: w.win,
      chrome: 'popup',
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      empty: true
    })
    expect(w.adoptView).toHaveBeenCalledWith(
      { id: 'adopted-view' },
      { tabId: expect.stringMatching(/^tab/), parentTabId: null, active: true },
      w.made
    )
    expect(w.createTab).not.toHaveBeenCalled()
    expect(w.opened).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 1))
    expect(w.opened).toHaveBeenCalledTimes(1)
  })

  it('opens a URL without features as a tab next to the active tab of the window the page hangs from', () => {
    const w = world()
    const answer = extensionPageOpenHandler(w.host)(
      details('https://example.net/', '', 'foreground-tab')
    )
    expect(answer.action).toBe('allow')
    ;(answer as { createWindow: (o: unknown) => WebContents }).createWindow({
      webContents: w.guest
    })
    expect(w.tickets[0]).toMatchObject({ action: 'tab', url: 'https://example.net/' })
    expect(w.createWindow).not.toHaveBeenCalled()
    expect(w.adoptView).toHaveBeenCalledWith(
      { id: 'adopted-view' },
      { tabId: expect.stringMatching(/^tab/), parentTabId: 't1', active: true },
      w.win
    )
  })

  it('without the tab path (no Electron views) a site URL still opens as a tab of the window and the call is refused', () => {
    const w = world({ views: false })
    const answer = extensionPageOpenHandler(w.host)(details('https://example.net/'))
    expect(answer).toEqual({ action: 'deny' })
    expect(w.createTab).toHaveBeenCalledWith({ url: 'https://example.net/', active: true }, w.win)
    expect(w.fellBack).toHaveBeenCalledTimes(1)
    expect(w.opened).not.toHaveBeenCalled()
  })

  it('without a view for the active tab an extension page opens as a tab; without a window the tab goes to the browser’s default', () => {
    const noView = world({ activeView: false })
    const url = 'chrome-extension://iodihamcpbpeioajjeobimgagajmlibd/html/nassh.html'
    expect(extensionPageOpenHandler(noView.host)(details(url))).toEqual({ action: 'deny' })
    expect(noView.createTab).toHaveBeenCalledWith({ url, active: true }, noView.win)
    const noWindow = world({ window: false })
    expect(extensionPageOpenHandler(noWindow.host)(details(url))).toEqual({ action: 'deny' })
    expect(noWindow.createTab).toHaveBeenCalledWith({ url, active: true }, undefined)
    expect(noWindow.openTicket).not.toHaveBeenCalled()
  })

  it('refuses the browser’s own documents and javascript: without opening anything', () => {
    for (const url of ['zen://settings', 'zenium://history', 'javascript:alert(1)']) {
      const w = world()
      expect(extensionPageOpenHandler(w.host)(details(url, NASSH_FEATURES))).toEqual({
        action: 'deny'
      })
      expect(w.createTab).not.toHaveBeenCalled()
      expect(w.openTicket).not.toHaveBeenCalled()
      expect(w.fellBack).toHaveBeenCalledTimes(1)
    }
  })
})

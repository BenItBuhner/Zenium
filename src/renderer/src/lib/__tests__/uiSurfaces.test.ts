import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { UIState, WebAppInstallPrompt } from '@shared/types'
import { cmd, run } from '../api'
import {
  browserStore,
  chromeNeedsKeyboard,
  closeClearBrowsingData,
  closeImportDialog,
  closeMediaSheet,
  openClearBrowsingData,
  openImportDialog,
  openInstallSheet,
  openMediaSheet,
  overlayCoversContent,
  panelAloneOverContent,
  uiStore,
  type UiState
} from '../ui'
import { viewportStore } from '../formFactor'
import { openImportSurface } from '../pages'

const idle = (): UiState => uiStore.get()

afterEach(() => {
  uiStore.set({
    overlay: 'none',
    siteInfoOpen: false,
    permissionPromptOpen: false,
    clearBrowsingDataOpen: false,
    barMenuOpen: false,
    starDialog: null,
    snapshot: null,
    snapshotTabId: null,
    install: null,
    mediaSheet: null,
    importDialog: null,
    overlaySection: null
  })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

const INSTALL_PROMPT: WebAppInstallPrompt = {
  tabId: 't1',
  title: 'Sketch',
  url: 'https://sketch.example/',
  origin: 'sketch.example',
  icon: null,
  info: null,
  tint: null,
  surface: 'homeScreen'
}

describe('the install sheet', () => {
  it('opens for a Home-screen prompt and for a desktop one alike, over the page with the chrome focused', async () => {
    // One store entry serves both chromes: the phone's `InstallLayer` shows a sheet for it, the
    // desktop's `InstallDialogLayer` a dialog – each on its own host only.
    await openInstallSheet({ ...INSTALL_PROMPT, surface: 'desktop' })
    expect(idle().install?.surface).toBe('desktop')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    uiStore.set({ install: null })
    vi.mocked(run).mockClear()
    await openInstallSheet(INSTALL_PROMPT)
    expect(idle().install?.tabId).toBe('t1')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })
})

describe('the media sheet', () => {
  it('holds a picture of the tab on screen, not of the media’s tab, and shows the media’s tab', async () => {
    vi.mocked(cmd).mockResolvedValueOnce('data:image/jpeg;base64,AAAA' as never)
    // The media plays in t1 while t2 is on screen: the recede starts on t2's page, and the
    // capture is named for it, so the host hides that view and no other.
    await openMediaSheet('t1', 't2')
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't2' })
    expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(idle().snapshotTabId).toBe('t2')
    expect(idle().mediaSheet).toBe('t1')
    expect(overlayCoversContent(idle())).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    closeMediaSheet()
    expect(idle().mediaSheet).toBeNull()
  })
})

describe('chrome surfaces over the content', () => {
  it('counts the Clear browsing data dialog as a surface that covers the page and holds the keyboard', () => {
    expect(overlayCoversContent(idle())).toBe(false)
    expect(chromeNeedsKeyboard()).toBe(false)
    uiStore.set({ clearBrowsingDataOpen: true })
    expect(overlayCoversContent(idle())).toBe(true)
    expect(chromeNeedsKeyboard()).toBe(true)
    // A dialog dims the page: it is not a lone panel.
    expect(panelAloneOverContent(idle())).toBe(false)
  })

  it('treats site information and the permission prompt as panels that draw no dim of their own', () => {
    // A popover on a mouse (no scrim, §9.5), a chassis sheet on a phone whose own scrim is the
    // one dim over the page (§11.5): either way the capture behind them shows undimmed.
    uiStore.set({ siteInfoOpen: true })
    expect(panelAloneOverContent(idle())).toBe(true)
    uiStore.set({ siteInfoOpen: false, permissionPromptOpen: true })
    expect(panelAloneOverContent(idle())).toBe(true)
    // Over Settings the popover is not alone: the overlay dims.
    uiStore.set({ overlay: 'settings' })
    expect(panelAloneOverContent(idle())).toBe(false)
  })

  it('a menu the renderer draws – the desktop app menu under ⋯ – leaves the page under it undimmed (§6 "Menus", §9.20)', () => {
    const menu = { id: 'm1', source: 'app' as const, items: [], x: null, y: null }
    uiStore.set({ menu })
    try {
      expect(overlayCoversContent(idle())).toBe(true)
      expect(chromeNeedsKeyboard()).toBe(true)
      expect(panelAloneOverContent(idle())).toBe(true)
      // Over a dialog it is not alone: the dialog's dim stays.
      uiStore.set({ clearBrowsingDataOpen: true })
      expect(panelAloneOverContent(idle())).toBe(false)
    } finally {
      uiStore.set({ menu: null, clearBrowsingDataOpen: false })
    }
  })

  it('opens Clear browsing data once, taking the keyboard, and gives it back on close', async () => {
    await openClearBrowsingData(null)
    expect(idle().clearBrowsingDataOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    vi.mocked(run).mockClear()
    await openClearBrowsingData(null)
    expect(run).not.toHaveBeenCalled()
    closeClearBrowsingData()
    expect(idle().clearBrowsingDataOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    vi.mocked(run).mockClear()
    closeClearBrowsingData()
    expect(run).not.toHaveBeenCalled()
  })

  it('the import dialog is a dialog over the page in the same way, opened once with its preselected source (ID-23)', async () => {
    expect(overlayCoversContent(idle())).toBe(false)
    await openImportDialog(null, 'chrome:Default')
    expect(idle().importDialog).toEqual({ source: 'chrome:Default' })
    expect(overlayCoversContent(idle())).toBe(true)
    expect(chromeNeedsKeyboard()).toBe(true)
    expect(panelAloneOverContent(idle())).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    vi.mocked(run).mockClear()
    // A second ask while it is up changes nothing (the menu pressed twice).
    await openImportDialog(null, null)
    expect(idle().importDialog).toEqual({ source: 'chrome:Default' })
    expect(run).not.toHaveBeenCalled()
    closeImportDialog()
    expect(idle().importDialog).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('the import surface is Settings on Import with the dialog over it on a mouse – the tab where the host has page tabs, the overlay where not – and the category alone on a phone', async () => {
    // A host without page tabs: the overlay on the section asked for, the dialog over it.
    browserStore.set({
      state: { capabilities: { pageTabs: false } } as unknown as UIState
    })
    await openImportSurface('t1', 'firefox:abcd', 'sync')
    expect(idle().overlay).toBe('settings')
    expect(idle().overlaySection).toBe('sync')
    expect(idle().importDialog).toEqual({ source: 'firefox:abcd' })
    expect(run).not.toHaveBeenCalledWith('page.open', expect.anything())
    uiStore.set({ overlay: 'none', overlaySection: null, importDialog: null })
    vi.mocked(run).mockClear()

    // The desktop, Settings a tab (#193): the tab on the section, the dialog over it. The first
    // run ends over the new tab page with the URL bar up in its new-tab mode: it closes first,
    // or it would float over the tab and the dialog.
    browserStore.set({
      state: { capabilities: { pageTabs: true } } as unknown as UIState
    })
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await openImportSurface('t1', 'chrome:Default')
    expect(idle().overlay).toBe('none')
    expect(idle().urlbar.open).toBe(false)
    expect(run).toHaveBeenCalledWith('page.open', { id: 'settings', section: 'import' })
    expect(idle().importDialog).toEqual({ source: 'chrome:Default' })
    uiStore.set({ importDialog: null })
    vi.mocked(run).mockClear()

    // A phone: the category alone, and on Import whatever section was asked for – its rows
    // import from files, there being no other browser's profile to read.
    viewportStore.set({ formFactor: 'phone' })
    await openImportSurface('t1', 'chrome:Default', 'sync')
    expect(run).toHaveBeenCalledWith('page.open', { id: 'settings', section: 'import' })
    expect(idle().importDialog).toBeNull()
    expect(idle().overlay).toBe('none')
    viewportStore.set({ formFactor: 'desktop' })
    browserStore.set({ state: null })
  })
})

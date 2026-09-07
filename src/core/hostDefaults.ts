/* eslint-disable @typescript-eslint/no-empty-function -- deliberate no-op host services */
import type { ExtensionInfo, Rect, ResourceSnapshot, SyncScope, SyncStatus } from '../shared/types'
import { emptyResourceSnapshot } from '../shared/defaults'
import type { Browser } from './browser'
import type { ExtensionHost, Governor, SyncHost, TabView } from './platform'
import type { ZenWindow } from './window'

/**
 * Governor for hosts without process metrics or a DevTools protocol (Android). Background loads
 * start immediately, nothing is ever frozen or throttled; only Zen's plain tab-unloading timeout
 * is honoured, the same way it was before the governor existed.
 */
export class NoopGovernor implements Governor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly browser: Browser) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.browser.tabs.unloadInactive(), 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  watchWindow(): void {}

  requestLoad(tabId: string, windowId: string | undefined): boolean {
    const win = windowId ? this.browser.windows.get(windowId) : undefined
    this.browser.tabs.load(tabId, win?.alive ? win : undefined)
    return true
  }

  trackLoad(): void {}
  makeRoomFor(): void {}
  onViewCreated(): void {}
  onViewDestroyed(): void {}
  onTabRemoved(): void {}
  onLoadFinished(): void {}
  onMedia(): void {}
  wakeVisible(): void {}
  onSettingsChanged(): void {}
  record(): void {}

  async thaw(): Promise<void> {}
  async freezeTab(): Promise<void> {}
  async wakeTab(): Promise<void> {}
  async freezeOthers(): Promise<void> {}
  async wakeAll(): Promise<void> {}

  async sample(): Promise<ResourceSnapshot> {
    const snapshot = emptyResourceSnapshot()
    snapshot.loadedTabs = this.browser.tabs.loadedCount()
    return snapshot
  }

  async trim(): Promise<void> {
    // Free what we can without process metrics: unload every hidden page.
    const visible = this.browser.tabs.allVisibleTabIds()
    for (const [id] of [...this.browser.tabs.allViews()]) {
      const tab = this.browser.tabs.tab(id)
      if (tab && !visible.has(id) && !tab.audible) this.browser.tabs.discard(id)
    }
  }

  relaunch(): void {
    this.browser.platform.app.relaunch()
  }
}

/** Hosts that cannot run Chromium extensions. */
export class NoExtensions implements ExtensionHost {
  constructor(private readonly browser: Browser) {}

  async start(): Promise<void> {}

  list(): ExtensionInfo[] {
    return []
  }

  async addFromDialog(win: ZenWindow): Promise<void> {
    this.browser.toast('Extensions are not available on this device.', 'info', win)
  }

  remove(): void {}
  async setEnabled(): Promise<void> {}
  openPopup(_id: string, _anchor: Rect, win: ZenWindow): void {
    this.browser.toast('Extensions are not available on this device.', 'info', win)
  }
  closePopup(): void {}
  flushSync(): void {}
}

const DEFAULT_SCOPE: SyncScope = {
  spaces: true,
  folders: true,
  pinnedTabs: true,
  essentials: true,
  openTabs: false,
  containers: true,
  bookmarks: true,
  settings: true,
  shortcuts: true,
  boosts: true
}

/** Hosts without a shared-folder sync transport. */
export class NoSync implements SyncHost {
  constructor(private readonly browser: Browser) {}

  start(): void {}

  status(): SyncStatus {
    return {
      enabled: false,
      folder: null,
      deviceId: '',
      deviceName: '',
      scope: { ...DEFAULT_SCOPE },
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: [],
      pendingMerge: false
    }
  }

  async chooseFolder(win: ZenWindow): Promise<string | null> {
    this.browser.toast('Sync is not available on this device yet.', 'info', win)
    return null
  }

  async setup(_opts: unknown, win: ZenWindow): Promise<void> {
    this.browser.toast('Sync is not available on this device yet.', 'info', win)
  }

  setScope(): void {}
  setDeviceName(): void {}
  async syncNow(): Promise<void> {}
  async confirmMerge(): Promise<void> {}
  disconnect(): void {}
  flushSync(): void {}
}

/** Type guard hosts can use to tell the real view from a stand-in. */
export function isLiveView(view: TabView | undefined): view is TabView {
  return Boolean(view) && !view!.isDestroyed()
}

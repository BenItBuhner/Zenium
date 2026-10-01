import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import type { Browser } from '../../core/browser'
import type { ZenWindow } from '../../core/window'
import { appBadgeDescription, appBadgeLabel, type AppBadge } from '../../shared/appBadge'
import { badgeOverlayPng } from './badgeOverlay'
import type { DockBadge } from './dockBadge'
import type { ElectronWindow } from './window'

/**
 * The desktop's drawing of installed apps' badges (MW-51), from the core's `WebAppService`
 * (`onBadgeChange`: what each app's page set through `navigator.setAppBadge`):
 *  - Windows: each of the app's windows has a taskbar button of its own (an app window carries
 *    the app's AppUserModelID, `window.ts`), and the badge is an overlay on that button –
 *    `BrowserWindow.setOverlayIcon` with the image `badgeOverlay.ts` draws and the accessible
 *    description a screen reader gives the button (`appBadgeDescription`), cleared with the
 *    badge. A window of the app that opens while its badge stands gets the overlay as it shows.
 *  - macOS and Linux: the app's badge goes to the dock icon through `DockBadge`, the one owner
 *    of the badge it shares with the downloads count (`downloadsShell.ts`).
 * Nothing is persisted and nothing is asked of the page: the badge is drawn as it comes.
 */
export class ElectronAppBadges {
  /** The overlay image for each label, drawn once. */
  private readonly images = new Map<string, NativeImage>()
  /** The label each window's button shows ('' for none), so a button is redrawn on a change alone. */
  private readonly drawn = new WeakMap<BrowserWindow, string>()

  constructor(
    private readonly browser: Browser,
    private readonly dock: DockBadge,
    private readonly platform: () => NodeJS.Platform = () => process.platform
  ) {
    browser.webApps.onBadgeChange((appId, badge) => {
      this.dock.setApp(appId, badge)
      this.refresh()
    })
    // A second window of a badged app: its button gets the overlay once the window is up (the
    // core's record of the window is complete by then).
    app.on('browser-window-created', (_event, bw) => {
      bw.once('show', () => this.refresh())
    })
  }

  /** Every app window's taskbar overlay follows its app's badge (Windows; nothing elsewhere). */
  refresh(): void {
    if (this.platform() !== 'win32') return
    for (const win of this.browser.allWindows()) {
      const bw = browserWindowOf(win)
      if (!bw) continue
      const appId = win.app?.appId
      const badge = appId ? this.browser.webApps.badgeOf(appId) : null
      const label = badge ? appBadgeLabel(badge) : ''
      if ((this.drawn.get(bw) ?? '') === label) continue
      this.drawn.set(bw, label)
      if (badge) bw.setOverlayIcon(this.imageFor(badge, label), appBadgeDescription(badge))
      else bw.setOverlayIcon(null, '')
    }
  }

  private imageFor(badge: AppBadge, label: string): NativeImage {
    let image = this.images.get(label)
    if (!image) {
      image = nativeImage.createFromBuffer(badgeOverlayPng(badge))
      this.images.set(label, image)
    }
    return image
  }
}

function browserWindowOf(win: ZenWindow): BrowserWindow | undefined {
  const host = win.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}

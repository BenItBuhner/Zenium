import { app } from 'electron'
import { APP_BADGE_FLAG_GLYPH, APP_BADGE_MAX_SHOWN, type AppBadge } from '../../shared/appBadge'

/**
 * The one owner of the dock badge (macOS, `app.dock.setBadge`) and the launcher count (Linux,
 * `app.setBadgeCount` – the Unity API that GNOME's dock extensions, KDE and Unity read), which
 * two features share one icon for: downloads' count of completions the user has not seen yet
 * (`downloadsShell.ts`: finished while no window was focused, cleared when one takes focus) and
 * installed apps' badges (MW-51, `appBadges.ts`: what each app's page set through
 * `navigator.setAppBadge`). Each side keeps its own figure here, and the arbiter decides what
 * the icon shows, so neither writes over the other's:
 *  - the downloads count while it is above zero – the newer signal of the two and a short-lived
 *    one (the next focus clears it), after which the apps' badge is back as it was;
 *  - otherwise the apps' counts summed – one icon stands for every app window, as the dock has
 *    no tile per installed app – "99+" past Chrome's `kMaxBadgeContent` on macOS (the Linux
 *    launcher takes a number and formats it itself);
 *  - otherwise, when some app set a flag, "•" on macOS (Chrome's glyph for a flag) and 1 on
 *    Linux, whose launcher shows numbers alone – the spec's "closest representation" for a
 *    platform without flags, which must not read as no badge;
 *  - nothing when there is nothing.
 * Windows has no app-wide badge: the taskbar carries each app window's own overlay
 * (`appBadges.ts`) and the downloads' progress bar. Nothing here draws on Windows.
 */
export class DockBadge {
  private downloads = 0
  private readonly apps = new Map<string, AppBadge>()
  /** The last figure written, so the same one is not set twice (null: nothing written yet). */
  private shown: string | null = null

  constructor(private readonly platform: () => NodeJS.Platform = () => process.platform) {}

  /** Downloads finished while no window was focused, 0 once a window took focus. */
  setDownloads(count: number): void {
    this.downloads = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    this.apply()
  }

  /** An installed app's badge (null: cleared). */
  setApp(appId: string, badge: AppBadge | null): void {
    if (badge) this.apps.set(appId, badge)
    else this.apps.delete(appId)
    this.apply()
  }

  /** What the macOS dock badge reads: the rule above; '' for no badge. */
  label(): string {
    if (this.downloads > 0) return String(this.downloads)
    const total = this.appsTotal()
    if (total > 0) return total > APP_BADGE_MAX_SHOWN ? `${APP_BADGE_MAX_SHOWN}+` : String(total)
    return this.appsFlagged() ? APP_BADGE_FLAG_GLYPH : ''
  }

  /** What the Linux launcher counts: the rule above; 0 for no badge. */
  count(): number {
    if (this.downloads > 0) return this.downloads
    const total = this.appsTotal()
    if (total > 0) return total
    return this.appsFlagged() ? 1 : 0
  }

  private appsTotal(): number {
    let total = 0
    for (const badge of this.apps.values()) if (badge.kind === 'count') total += badge.value
    return total
  }

  private appsFlagged(): boolean {
    for (const badge of this.apps.values()) if (badge.kind === 'flag') return true
    return false
  }

  private apply(): void {
    const platform = this.platform()
    if (platform === 'darwin') {
      const label = this.label()
      // An icon that never showed a badge shows none: clearing nothing writes nothing.
      if (label === (this.shown ?? '')) return
      this.shown = label
      app.dock?.setBadge(label)
    } else if (platform === 'linux') {
      const count = String(this.count())
      if (count === (this.shown ?? '0')) return
      this.shown = count
      app.setBadgeCount(Number(count))
    }
  }
}

import type { DefaultBrowserOutcome, DefaultBrowserStatus } from '../shared/types'
import type { Browser } from './browser'
import type { DefaultBrowserHost } from './platform'

/** Window-focus checks are cheap but not free (`xdg-settings` spawns a process): rate-limit them. */
const FOCUS_REFRESH_MIN_MS = 5_000
/** After Windows opened Settings → Default apps: how often and how long to look for the answer. */
const SETTINGS_POLL_MS = 3_000
const SETTINGS_POLL_ROUNDS = 40

/**
 * Whether Zenium handles http/https links for the current user, and the request to become that
 * browser. The OS answers asynchronously, so the status starts unknown (`null`); the Settings row
 * and the "Make Zenium your default browser" strip follow `state.defaultBrowser` and repaint when
 * an answer arrives. Hosts without the capability keep the status at `null` forever.
 */
export class DefaultBrowserService {
  private current: DefaultBrowserStatus = { isDefault: null }
  private lastRefreshAt = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly browser: Browser) {}

  status(): DefaultBrowserStatus {
    return this.current
  }

  private get host(): DefaultBrowserHost | null {
    return this.browser.platform.defaultBrowser ?? null
  }

  start(): void {
    if (this.host) void this.refresh()
  }

  stop(): void {
    this.stopPolling()
  }

  /** Ask the OS again; resolves with the answer (or the last one when the host failed). */
  async refresh(): Promise<boolean | null> {
    const host = this.host
    if (!host) return null
    this.lastRefreshAt = Date.now()
    try {
      this.set(await host.isDefault())
    } catch (error) {
      console.warn('[zen] default browser: status check failed:', error)
    }
    return this.current.isDefault
  }

  /** The user may have picked a browser in the OS meanwhile: look again, throttled. */
  onWindowFocused(): void {
    if (!this.host || Date.now() - this.lastRefreshAt < FOCUS_REFRESH_MIN_MS) return
    void this.refresh()
  }

  async makeDefault(): Promise<DefaultBrowserOutcome> {
    const host = this.host
    if (!host) return 'failed'
    let outcome: DefaultBrowserOutcome
    try {
      outcome = await host.makeDefault()
    } catch (error) {
      console.warn('[zen] default browser: request failed:', error)
      outcome = 'failed'
    }
    if (outcome === 'settings-opened') this.pollWhileChoosing()
    else await this.refresh()
    return outcome
  }

  /** "Not now" on the strip: it stays away until the next feature release. */
  dismissPrompt(): void {
    this.browser.state.settings.defaultBrowserPromptDismissed = this.browser.platform.info.version
    this.browser.state.commit()
  }

  /**
   * Windows lets the user pick in Settings, outside the app; poll for a couple of minutes so the
   * row and the strip update the moment Zenium is chosen, then fall back to focus checks.
   */
  private pollWhileChoosing(): void {
    this.stopPolling()
    let rounds = 0
    const tick = (): void => {
      this.pollTimer = null
      void this.refresh().then((isDefault) => {
        if (isDefault || ++rounds >= SETTINGS_POLL_ROUNDS) return
        this.pollTimer = setTimeout(tick, SETTINGS_POLL_MS)
      })
    }
    this.pollTimer = setTimeout(tick, SETTINGS_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private set(isDefault: boolean): void {
    if (this.current.isDefault === isDefault) return
    this.current = { isDefault }
    this.browser.state.commitVolatile()
  }
}

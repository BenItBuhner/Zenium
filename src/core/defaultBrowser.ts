import type {
  DefaultBrowserPrompt,
  DefaultBrowserRequestSource,
  DefaultBrowserStatus
} from '../shared/types'
import {
  beginSession,
  decidePrompt,
  dismissPrompt,
  markBannerShown,
  markRequested,
  markSheetShown
} from '../shared/defaultBrowser'
import type { Browser } from './browser'

/**
 * Whether the chrome has surfaces that render `prompt` – the promo sheet and the banner
 * (`components/defaultbrowser`). Off, the campaign stays inert: sessions are still counted, but
 * nothing is decided, marked as shown or dismissed, since a showing with nothing on screen would
 * burn the user's turn. On since the surfaces landed.
 */
export const PROMPT_SURFACES = true

export interface DefaultBrowserServiceOptions {
  /** The chrome can show a sheet and a banner (`PROMPT_SURFACES` unless a test says otherwise). */
  promptSurfaces?: boolean
}

/**
 * The default-browser role, host-neutral half. Counts sessions, asks the host whether Zenium
 * holds the role (at start and whenever the app returns to the foreground, since the user may
 * have changed it in the system settings), and turns the rules in `shared/defaultBrowser.ts`
 * into the one `DefaultBrowserStatus` the chrome renders: the settings row reads `isDefault`,
 * the promo sheet and the banner read `prompt` (`PROMPT_SURFACES`). Hosts without the capability
 * keep it inert.
 */
export class DefaultBrowserService {
  private isDefault: boolean | null = null
  private prompt: DefaultBrowserPrompt = null
  private checking: Promise<boolean | null> | null = null
  private readonly promptSurfaces: boolean

  constructor(
    private readonly browser: Browser,
    options: DefaultBrowserServiceOptions = {}
  ) {
    this.promptSurfaces = options.promptSurfaces ?? PROMPT_SURFACES
  }

  status(): DefaultBrowserStatus {
    return { isDefault: this.isDefault, prompt: this.prompt }
  }

  private get supported(): boolean {
    return this.browser.state.capabilities.defaultBrowser === true
  }

  /** The app started: one more session (once onboarding is behind the user), then decide. */
  start(): void {
    if (!this.supported) return
    const { settings } = this.browser.state
    if (settings.onboardingDone)
      settings.defaultBrowserPromo = beginSession(settings.defaultBrowserPromo)
    void this.refresh()
  }

  /** Onboarding just finished: this is the first session. */
  onOnboardingDone(): void {
    if (!this.supported) return
    const { settings } = this.browser.state
    settings.defaultBrowserPromo = beginSession(settings.defaultBrowserPromo)
    void this.refresh()
  }

  /** Back in the foreground: the role may have changed under us. */
  onForeground(): void {
    if (!this.supported) return
    void this.refresh()
  }

  /** Ask the host for the role and re-evaluate the prompts; resolves with the answer. */
  refresh(): Promise<boolean | null> {
    if (!this.supported) return Promise.resolve(null)
    if (this.checking) return this.checking
    this.checking = Promise.resolve()
      .then(() => this.browser.platform.app.isDefaultBrowser())
      .catch(() => null)
      .then((isDefault) => {
        this.checking = null
        this.apply(isDefault)
        return isDefault
      })
    return this.checking
  }

  /**
   * "Set as default" from any surface: hand over to the system, then read the role again. A
   * request from the sheet, banner or settings ends the campaign; onboarding's own step does not
   * (nobody has been nagged yet, and the system dialog is easy to swipe away by accident).
   */
  async request(source: DefaultBrowserRequestSource): Promise<boolean | null> {
    if (!this.supported) return null
    const { settings } = this.browser.state
    if (source !== 'onboarding') {
      settings.defaultBrowserPromo = markRequested(settings.defaultBrowserPromo)
    }
    this.setPrompt(null)
    this.browser.state.commit()
    let result: boolean | null = null
    try {
      result = await this.browser.platform.app.requestDefaultBrowser()
    } catch {
      result = null
    }
    // The role dialog answers with the outcome; the settings screen (API 26–28) does not.
    if (result === null) result = await this.refresh()
    else this.apply(result)
    return result
  }

  dismiss(prompt: 'sheet' | 'banner'): void {
    // Nothing was up to dismiss without a surface: the counter would give up a turn for nothing.
    if (!this.supported || !this.promptSurfaces) return
    const { settings } = this.browser.state
    settings.defaultBrowserPromo = dismissPrompt(settings.defaultBrowserPromo, prompt)
    this.setPrompt(null)
    this.browser.state.commit()
  }

  private apply(isDefault: boolean | null): void {
    const { settings } = this.browser.state
    this.isDefault = isDefault
    // A prompt already up stays up (unless the role is now held); otherwise see what is due –
    // only where the chrome can show it, or the showing would be spent on nothing.
    let prompt = this.prompt
    if (isDefault !== false) prompt = null
    else if (prompt === null) {
      prompt =
        this.promptSurfaces && settings.onboardingDone
          ? decidePrompt(settings.defaultBrowserPromo, isDefault)
          : null
      if (prompt === 'sheet')
        settings.defaultBrowserPromo = markSheetShown(settings.defaultBrowserPromo)
      if (prompt === 'banner')
        settings.defaultBrowserPromo = markBannerShown(settings.defaultBrowserPromo)
    }
    this.prompt = prompt
    this.browser.state.commit()
  }

  private setPrompt(prompt: DefaultBrowserPrompt): void {
    this.prompt = prompt
  }
}

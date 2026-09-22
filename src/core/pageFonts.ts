import type { Browser } from './browser'
import { sanitizeFontSettings, type PageFontSettings } from '../shared/fonts'

/**
 * The page fonts (Settings › Appearance › Customize fonts; Chrome's chrome://settings/fonts,
 * CT-25). The core keeps the setting (`Settings.fonts`, synced with the settings) and hands it
 * to the host whenever it stands differently from what the host has: at boot, on a Settings
 * row, on a sync merge. The host does what its engine allows – the Electron host builds every
 * new page view's web preferences from it and applies it live to open pages whose debugger is
 * free; the Android host sets every tab WebView's `WebSettings` – and the Settings copy says
 * where a change waits for the next load. Hosts without page fonts (`Platform.pageFonts`
 * absent) keep the engine's own.
 */
export class PageFontsService {
  /** What the host was last given (one string per setting), so a broadcast without a change is free. */
  private applied = ''

  constructor(private readonly browser: Browser) {}

  start(): void {
    this.apply()
    // A sync merge writes the settings without `updateSettings`: the state's broadcast is the
    // one path every change takes.
    this.browser.state.subscribe(() => this.apply())
  }

  /** The setting changed under the service (a settings patch, a sync merge). */
  onSettingsChanged(): void {
    this.apply()
  }

  get fonts(): PageFontSettings {
    return this.browser.state.settings.fonts
  }

  /** Change the setting (a Settings row's value); the host follows at once. */
  update(patch: Partial<PageFontSettings>): void {
    const s = this.browser.state.settings
    s.fonts = sanitizeFontSettings({ ...s.fonts, ...patch })
    this.apply()
    this.browser.state.commit()
  }

  private apply(): void {
    const fonts = this.fonts
    const key = JSON.stringify(fonts)
    if (key === this.applied) return
    this.applied = key
    this.browser.platform.pageFonts?.apply(fonts)
  }
}

import type { Browser } from './browser'
import { acceptLanguageHeader, languagesKey, sanitizeLanguages } from '../shared/languages'

/**
 * The preferred languages (Settings › Languages; Chrome's chrome://settings/languages, CT-41):
 * `Settings.languages`, BCP 47 tags most preferred first, synced with the settings. The core
 * keeps the list and, whenever it stands differently from what was applied (boot, a Settings
 * row, a sync merge), hands it on:
 *
 * - to the host, which puts it into the pages' `Accept-Language` where its engine allows
 *   (`Platform.languages`: every desktop session through `session.setUserAgent`; Android's
 *   WebView follows the system locales, `capabilities.pageLanguages` says so);
 * - to translate, whose languages-you-read list (the default target first, the never-offer
 *   set) is this list reduced to the models' codes;
 * - to spellcheck, which checks a profile that chose no dictionary in the first of these that
 *   has one.
 */
export class LanguagesService {
  /** The list last applied (`languagesKey`), so a broadcast without a change is free. */
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

  /** The list as it stands, most preferred first. */
  get list(): readonly string[] {
    return this.browser.state.settings.languages
  }

  /** Whether pages on this host receive the list (else the OS's languages). */
  get pagesFollow(): boolean {
    return this.browser.platform.languages !== undefined
  }

  /**
   * The `Accept-Language` header the list makes (Chrome's expansion and weights): what the
   * desktop's sessions send, shown in Settings and checked by the proof.
   */
  acceptLanguage(): string {
    return acceptLanguageHeader(this.list)
  }

  /**
   * Replace the list (a Settings row's reorder, add or remove). Tags are canonicalised and
   * deduplicated; a list with nothing valid leaves the current one standing, as Chrome keeps
   * its last language from being removed.
   */
  set(languages: readonly string[]): void {
    const s = this.browser.state.settings
    const next = sanitizeLanguages(languages, s.languages)
    if (languagesKey(next) === languagesKey(s.languages)) return
    s.languages = next
    this.apply()
    this.browser.state.commit()
  }

  private apply(): void {
    const list = this.list
    const key = languagesKey(list)
    if (key === this.applied) return
    const first = this.applied === ''
    this.applied = key
    this.browser.platform.languages?.apply(list)
    // At boot translate and spellcheck read the list as they start; from then on they follow it.
    if (first) return
    this.browser.translate.onLanguagesChanged()
    this.browser.spellcheck.onSettingsChanged()
  }
}

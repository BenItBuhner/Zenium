import type { Browser } from './browser'
import type { SpellcheckHost, TabView } from './platform'
import {
  UNAVAILABLE_SPELLCHECK,
  orderSpellcheckLanguages,
  resolveSpellcheckLanguages,
  spellcheckLanguageName,
  withSpellcheckLanguage,
  type SpellcheckDictionaryStatus,
  type SpellcheckStatus
} from '../shared/spellcheck'

/**
 * Spell checking of text fields (Chrome's Settings › Languages › Spell check, CT-07 / CT-19).
 * The core keeps the setting – on / off and the dictionary languages – and resolves it against
 * what the host offers (`resolveSpellcheckLanguages`): the chosen languages the host has a
 * dictionary for, or the UI language's dictionary in a profile that never chose any. The host
 * checks in that list in every session; what each dictionary is doing (downloading, ready,
 * failed) comes back through `onDictionaryStatus` and shows next to the language in Settings.
 *
 * Hosts without a spellchecker of their own (Android, where the system's checker does it) have
 * no `SpellcheckHost`; the service then reports `UNAVAILABLE_SPELLCHECK` and the commands do
 * nothing, and Settings shows the limit instead of a list.
 */
export class SpellcheckService {
  private readonly host: SpellcheckHost | undefined
  private readonly dictionaries = new Map<string, SpellcheckDictionaryStatus>()
  /** The languages the host checks in right now (the resolved setting). */
  private current: string[] = []

  constructor(private readonly browser: Browser) {
    this.host = browser.platform.spellcheck
    this.host?.onDictionaryStatus((code, status) => {
      if (this.dictionaries.get(code) === status) return
      this.dictionaries.set(code, status)
      this.browser.state.commitVolatile()
    })
  }

  start(): void {
    this.apply()
  }

  /** The setting changed under the service (a sync merge, a settings patch). */
  onSettingsChanged(): void {
    this.apply()
  }

  /** Whether this host checks spelling at all. */
  get available(): boolean {
    return this.host !== undefined
  }

  /** The languages the fields are checked in right now (empty: off, or none available). */
  languages(): readonly string[] {
    return this.browser.state.settings.spellcheck.enabled ? this.current : []
  }

  uiState(): SpellcheckStatus {
    if (!this.host) return UNAVAILABLE_SPELLCHECK
    const uiLocale = this.host.locales[0] ?? 'en'
    const available = this.host.availableLanguages()
    const enabled = new Set(this.current)
    // The checked languages lead in the order they are checked (the setting's order); the rest
    // follow by name (`orderSpellcheckLanguages` keeps the first group's order).
    const codes = [...this.current, ...available.filter((code) => !enabled.has(code))]
    const languages = codes.map((code) => ({
      code,
      name: spellcheckLanguageName(code, uiLocale),
      enabled: enabled.has(code),
      status: this.dictionaries.get(code) ?? 'unknown'
    }))
    return {
      available: true,
      systemLanguages: this.host.systemLanguages,
      languages: orderSpellcheckLanguages(languages)
    }
  }

  /** Chrome's "Check the spelling of text fields". */
  setEnabled(enabled: boolean): void {
    const s = this.browser.state.settings
    if (s.spellcheck.enabled === enabled) return
    s.spellcheck = { ...s.spellcheck, enabled }
    this.apply()
    this.browser.state.commit()
  }

  /**
   * Check (or stop checking) in `code`. Turning a language on in a profile at the limit does
   * nothing (Chrome greys the toggle); turning the last one off leaves the checker on with no
   * language, which checks nothing – as in Chrome, where the toggle then reads "off".
   */
  setLanguage(code: string, on: boolean): void {
    if (!this.host || this.host.systemLanguages) return
    const s = this.browser.state.settings
    if (!this.host.availableLanguages().includes(code)) return
    const next = withSpellcheckLanguage(s.spellcheck, this.current, code, on)
    if (next === s.spellcheck) return
    s.spellcheck = next
    this.apply()
    this.browser.state.commit()
  }

  /** The custom dictionary, sorted the way Chrome's "Customize spell check" lists it. */
  async words(): Promise<string[]> {
    if (!this.host) return []
    const words = await this.host.listWords()
    return [...new Set(words)].sort((a, b) => a.localeCompare(b))
  }

  /**
   * "Add to Dictionary": the profile's custom dictionary (every session) on a host with a
   * spellchecker; `view`'s own session where the host has no service for it.
   */
  async addWord(word: string, view?: TabView): Promise<boolean> {
    const trimmed = word.trim()
    if (!trimmed || /\s/.test(trimmed)) return false
    if (this.host) return this.host.addWord(trimmed)
    view?.addWordToDictionary(trimmed)
    return view !== undefined
  }

  async removeWord(word: string): Promise<boolean> {
    if (!this.host) return false
    return this.host.removeWord(word.trim())
  }

  /** Android: the keyboard settings, where the system's spell checker is set. */
  openKeyboardSettings(): void {
    this.browser.platform.shell.openKeyboardSettings?.()
  }

  private apply(): void {
    if (!this.host) return
    const settings = this.browser.state.settings.spellcheck
    const available = this.host.availableLanguages()
    // Languages that are no longer checked forget their dictionary state: a language switched
    // back on starts from "unknown" until Chromium reports on its dictionary again.
    const next = this.host.systemLanguages
      ? []
      : resolveSpellcheckLanguages(settings, available, this.host.locales)
    for (const code of this.current) if (!next.includes(code)) this.dictionaries.delete(code)
    this.current = next
    this.host.apply(settings.enabled, next)
  }
}

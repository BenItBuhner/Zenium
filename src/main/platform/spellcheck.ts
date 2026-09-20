import { app, type Session } from 'electron'
import type { SpellcheckHost } from '../../core/platform'
import type { SpellcheckDictionaryStatus } from '../../shared/spellcheck'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import type { SessionManager } from './sessions'

type DictionaryListener = (code: string, status: SpellcheckDictionaryStatus) => void

/**
 * Chromium's spellchecker, per session (CT-07 / CT-19): every container's session and the private
 * one check in the same languages, on and off together, so the setting reads as one for the
 * profile, like Chrome's. On Windows and Linux the checker is Hunspell with one dictionary per
 * language, downloaded from Chromium's CDN on the language's first use – the download and
 * initialisation events are relayed to the core, which shows them next to the language. macOS
 * uses the system's checker and its own language list (`setSpellCheckerLanguages` is a no-op
 * there), which `systemLanguages` says.
 *
 * The custom dictionary ("Add to Dictionary") is Chromium's per-partition file; a word is added to
 * every session and a session created later (a container's first tab) copies the default's, so
 * the profile has one dictionary as far as the user can tell.
 */
export class ElectronSpellcheck implements SpellcheckHost {
  readonly systemLanguages = process.platform === 'darwin'
  readonly locales: readonly string[]
  private enabled = true
  private languages: string[] = []
  /** `apply` has run: sessions created from now on take the setting at once. */
  private applied = false
  private readonly listeners: DictionaryListener[] = []

  constructor(private readonly sessions: SessionManager) {
    this.locales = uiLocales()
    sessions.configure((ses, containerId) => this.attach(ses, containerId))
  }

  availableLanguages(): string[] {
    return [...this.sessions.get(DEFAULT_CONTAINER_ID).availableSpellCheckerLanguages]
  }

  apply(enabled: boolean, languages: readonly string[]): void {
    this.enabled = enabled
    this.languages = [...languages]
    this.applied = true
    for (const ses of this.sessions.all()) this.applyTo(ses)
  }

  onDictionaryStatus(listener: DictionaryListener): void {
    this.listeners.push(listener)
  }

  async listWords(): Promise<string[]> {
    return this.sessions.get(DEFAULT_CONTAINER_ID).listWordsInSpellCheckerDictionary()
  }

  async addWord(word: string): Promise<boolean> {
    let added = false
    for (const ses of this.sessions.all())
      added = ses.addWordToSpellCheckerDictionary(word) || added
    return added
  }

  async removeWord(word: string): Promise<boolean> {
    let removed = false
    for (const ses of this.sessions.all())
      removed = ses.removeWordFromSpellCheckerDictionary(word) || removed
    return removed
  }

  private applyTo(ses: Session): void {
    if (!this.applied) return
    if (!this.systemLanguages) {
      try {
        ses.setSpellCheckerLanguages(this.languages)
      } catch {
        // A code Chromium does not know (the list is filtered against the available ones, so
        // only a build whose dictionary set shrank gets here): keep what the session had.
      }
    }
    // Electron's `setSpellCheckerLanguages` flips the checker on (off for an empty list) as a
    // side effect, so the switch goes last or "off" would not hold.
    ses.setSpellCheckerEnabled(this.enabled)
  }

  private attach(ses: Session, containerId: string): void {
    ses.on('spellcheck-dictionary-download-begin', (_e, code) => this.report(code, 'downloading'))
    ses.on('spellcheck-dictionary-download-success', (_e, code) => this.report(code, 'ready'))
    ses.on('spellcheck-dictionary-download-failure', (_e, code) => this.report(code, 'failed'))
    ses.on('spellcheck-dictionary-initialized', (_e, code) => this.report(code, 'ready'))
    this.applyTo(ses)
    if (containerId !== DEFAULT_CONTAINER_ID) void this.copyWords(ses)
  }

  /** A new session takes the profile's custom words (the default session's file). */
  private async copyWords(ses: Session): Promise<void> {
    const source = this.sessions.get(DEFAULT_CONTAINER_ID)
    if (source === ses) return
    try {
      for (const word of await source.listWordsInSpellCheckerDictionary())
        ses.addWordToSpellCheckerDictionary(word)
    } catch {
      /* the session is gone already */
    }
  }

  private report(code: string, status: SpellcheckDictionaryStatus): void {
    for (const listener of this.listeners) listener(code, status)
  }
}

/** The UI languages, most preferred first (the seed of a fresh profile's dictionary). */
function uiLocales(): string[] {
  try {
    const languages = app.getPreferredSystemLanguages()
    if (languages.length > 0) return languages
  } catch {
    /* not available before ready on some platforms */
  }
  return [app.getLocale() || 'en']
}

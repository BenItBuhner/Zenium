import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SessionManager } from '../sessions'
import { ElectronSpellcheck } from '../spellcheck'

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en-US', 'de-DE'],
    getLocale: () => 'en-US'
  }
}))

/**
 * A session's spellchecker as Electron exposes it, including the side effect that matters:
 * `setSpellCheckerLanguages` turns the checker on for a non-empty list and off for an empty one
 * (`kSpellCheckEnable = !languages.empty()`), so the order the host applies the two in decides
 * whether "off" holds.
 */
class FakeSession extends EventEmitter {
  enabled = true
  languages: string[] = []
  words = new Set<string>()
  readonly availableSpellCheckerLanguages = ['en-US', 'de', 'fr']
  readonly log: string[] = []
  setSpellCheckerEnabled(on: boolean): void {
    this.enabled = on
    this.log.push(`enabled:${on}`)
  }
  setSpellCheckerLanguages(codes: string[]): void {
    for (const code of codes)
      if (!this.availableSpellCheckerLanguages.includes(code))
        throw new Error(`Invalid language code provided: "${code}"`)
    this.languages = [...codes]
    this.enabled = codes.length > 0
    this.log.push(`languages:${codes.join(',')}`)
  }
  getSpellCheckerLanguages(): string[] {
    return this.languages
  }
  isSpellCheckerEnabled(): boolean {
    return this.enabled
  }
  async listWordsInSpellCheckerDictionary(): Promise<string[]> {
    return [...this.words]
  }
  addWordToSpellCheckerDictionary(word: string): boolean {
    if (this.words.has(word)) return false
    this.words.add(word)
    return true
  }
  removeWordFromSpellCheckerDictionary(word: string): boolean {
    return this.words.delete(word)
  }
}

/** The session manager's three calls the host uses: the hook, the default session, all of them. */
function fakeSessions(): {
  manager: SessionManager
  sessions: Map<string, FakeSession>
  open(id: string): FakeSession
} {
  const sessions = new Map<string, FakeSession>()
  const hooks: Array<(ses: FakeSession, id: string) => void> = []
  const open = (id: string): FakeSession => {
    let ses = sessions.get(id)
    if (ses) return ses
    ses = new FakeSession()
    sessions.set(id, ses)
    for (const hook of hooks) hook(ses, id)
    return ses
  }
  const manager = {
    configure: (hook: (ses: FakeSession, id: string) => void) => {
      hooks.push(hook)
      for (const [id, ses] of sessions) hook(ses, id)
    },
    get: (id: string) => open(id),
    all: () => [...sessions.values()]
  } as unknown as SessionManager
  return { manager, sessions, open }
}

describe('ElectronSpellcheck', () => {
  it('keeps the checker off after setting the languages (Electron turns it on for a non-empty list)', () => {
    const { manager, open } = fakeSessions()
    const ses = open('default')
    const host = new ElectronSpellcheck(manager)
    host.apply(true, ['en-US'])
    expect(ses.isSpellCheckerEnabled()).toBe(true)
    expect(ses.getSpellCheckerLanguages()).toEqual(['en-US'])

    host.apply(false, ['en-US'])
    expect(ses.isSpellCheckerEnabled()).toBe(false)
    expect(ses.getSpellCheckerLanguages()).toEqual(['en-US'])
    expect(ses.log.slice(-2)).toEqual(['languages:en-US', 'enabled:false'])
  })

  it('applies the same setting to every session, existing and created later', () => {
    const { manager, open } = fakeSessions()
    const first = open('default')
    const host = new ElectronSpellcheck(manager)
    host.apply(true, ['en-US', 'de'])
    const later = open('work')
    expect(first.getSpellCheckerLanguages()).toEqual(['en-US', 'de'])
    expect(later.getSpellCheckerLanguages()).toEqual(['en-US', 'de'])
    host.apply(false, ['de'])
    expect(first.isSpellCheckerEnabled()).toBe(false)
    expect(later.isSpellCheckerEnabled()).toBe(false)
    expect(later.getSpellCheckerLanguages()).toEqual(['de'])
  })

  it('leaves a session untouched until the core has applied the setting once', () => {
    const { manager, open } = fakeSessions()
    const ses = open('default')
    new ElectronSpellcheck(manager)
    expect(ses.log).toEqual([])
  })

  it('keeps the languages a session had when a code is refused, and still applies the switch', () => {
    const { manager, open } = fakeSessions()
    const ses = open('default')
    const host = new ElectronSpellcheck(manager)
    host.apply(true, ['en-US'])
    host.apply(false, ['xx-YY'])
    expect(ses.getSpellCheckerLanguages()).toEqual(['en-US'])
    expect(ses.isSpellCheckerEnabled()).toBe(false)
  })

  it('adds a custom word to every session and copies the dictionary into a new one', async () => {
    const { manager, open } = fakeSessions()
    const first = open('default')
    const host = new ElectronSpellcheck(manager)
    expect(await host.addWord('zenium')).toBe(true)
    expect(await host.listWords()).toEqual(['zenium'])
    const later = open('work')
    await new Promise((r) => setTimeout(r, 0))
    expect([...later.words]).toEqual(['zenium'])
    expect(await host.removeWord('zenium')).toBe(true)
    expect(first.words.size).toBe(0)
    expect(later.words.size).toBe(0)
  })

  it('relays the dictionary events as statuses next to the language', () => {
    const { manager, open } = fakeSessions()
    const ses = open('default')
    const host = new ElectronSpellcheck(manager)
    const seen: string[] = []
    host.onDictionaryStatus((code, status) => seen.push(`${code}:${status}`))
    ses.emit('spellcheck-dictionary-download-begin', {}, 'de')
    ses.emit('spellcheck-dictionary-download-failure', {}, 'de')
    ses.emit('spellcheck-dictionary-download-success', {}, 'fr')
    ses.emit('spellcheck-dictionary-initialized', {}, 'en-US')
    expect(seen).toEqual(['de:downloading', 'de:failed', 'fr:ready', 'en-US:ready'])
    expect(host.availableLanguages()).toEqual(['en-US', 'de', 'fr'])
    expect(host.locales).toEqual(['en-US', 'de-DE'])
  })
})

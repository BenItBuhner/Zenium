import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Every `session.fromPartition`, by partition, with what `setUserAgent` was last given. */
const { partitions, made } = vi.hoisted(() => {
  const made: Array<{ partition: string; ua: string; languages: string | undefined }> = []
  const partitions = new Map<string, { setUserAgent: (ua: string, languages?: string) => void }>()
  return { partitions, made }
})

vi.mock('electron', () => ({
  app: {
    userAgentFallback: '',
    getLocale: () => 'de-DE',
    getPreferredSystemLanguages: () => ['de-DE', 'en-GB'],
    getName: () => 'Zenium'
  },
  session: {
    fromPartition: (partition: string) => {
      const existing = partitions.get(partition)
      if (existing) return existing
      const ses = {
        setUserAgent: (ua: string, languages?: string) => {
          made.push({ partition, ua, languages })
        }
      }
      partitions.set(partition, ses)
      return ses
    }
  }
}))

import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import { SessionManager, buildAcceptLanguages, systemLocales } from '../sessions'

const UA = 'Mozilla/5.0 Chrome/140.0.0.0'

/**
 * The preferred languages (Settings › Languages, CT-41) as every session's `Accept-Language`:
 * `session.setUserAgent(ua, acceptLanguages)`, at each session's creation and again for every
 * session present when the list changes – the private one included.
 */
describe('SessionManager.setAcceptLanguages', () => {
  beforeEach(() => {
    partitions.clear()
    made.length = 0
  })

  it('starts from the OS languages, the UI locale first, as Chrome does before a profile exists', () => {
    expect(systemLocales()).toEqual(['de-DE', 'de-DE', 'en-GB'])
    expect(buildAcceptLanguages()).toBe('de-DE,de,en-GB,en')
    const sessions = new SessionManager(UA)
    sessions.get('default')
    expect(made).toEqual([
      { partition: 'persist:zen-default', ua: UA, languages: 'de-DE,de,en-GB,en' }
    ])
  })

  it('gives every open session the list at once, and every later one as it is made', () => {
    const sessions = new SessionManager(UA, 'en-US,en')
    sessions.get('default')
    sessions.get(PRIVATE_CONTAINER_ID)
    made.length = 0
    sessions.setAcceptLanguages('fr-FR,fr,en')
    expect(sessions.acceptLanguages).toBe('fr-FR,fr,en')
    expect(made.map((m) => [m.partition, m.languages])).toEqual([
      ['persist:zen-default', 'fr-FR,fr,en'],
      ['zen-private', 'fr-FR,fr,en']
    ])
    sessions.get('work')
    expect(made.at(-1)).toEqual({
      partition: 'persist:zen-container-work',
      ua: UA,
      languages: 'fr-FR,fr,en'
    })
  })

  it('sends nothing for the same list again, or for an empty one', () => {
    const sessions = new SessionManager(UA, 'en-US,en')
    sessions.get('default')
    made.length = 0
    sessions.setAcceptLanguages('en-US,en')
    sessions.setAcceptLanguages('')
    expect(made).toEqual([])
    expect(sessions.acceptLanguages).toBe('en-US,en')
  })
})

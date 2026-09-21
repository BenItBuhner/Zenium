import { describe, expect, it } from 'vitest'
import { emptyPasswordsStatus } from '../../../shared/defaults'
import type { CheckupSummary, PasswordsStatus } from '../../../shared/types'
import { emptyCheckupSummary } from '../../../shared/types'
import { composeSafetyCheck, type SafetyCheckInput } from '../../privacy'
import { lookupBreachCount, runCheckup } from '../checkup'
import { sha1Hex } from '../crypto'
import {
  WELL_KNOWN_CHANGE_PASSWORD,
  WELL_KNOWN_NOT_EXIST,
  changePasswordUrl,
  decideLeakCheck,
  savedLoginFor,
  withLiveCompromised
} from '../leak'
import { credential } from './fakes'

/** SHA-1 of "password" and the padded range its prefix returns (see checkup.test.ts). */
const PASSWORD_SHA1 = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8'
const RANGE_5BAA6 = [
  '003D68EB55068C33ACE09247EE4C639306B:3',
  '1E4C9B93F3F0682250B6CF8331B7EE68FD8:10434004',
  '1F2B668E8AABEF1C59E9EC6F82E3F3CD786:0',
  ''
].join('\r\n')

describe('the sign-in leak check: which saved login carries the memory', () => {
  const candidate = { origin: 'https://example.com', username: 'Ada', password: 'pw' }

  it('is the login with the same password and username, the exact origin first', () => {
    const sibling = credential({
      origin: 'https://accounts.example.com',
      username: 'ada',
      password: 'pw'
    })
    const exact = credential({ origin: 'https://example.com', username: 'ada', password: 'pw' })
    const other = credential({ origin: 'https://example.com', username: 'ada', password: 'other' })
    expect(savedLoginFor(candidate, [other, sibling, exact])).toBe(exact)
    expect(savedLoginFor(candidate, [other, sibling])).toBe(sibling)
    expect(savedLoginFor(candidate, [other])).toBeNull()
  })

  it('takes the most recently used sibling when none is exact, and any user for a form without a username', () => {
    const older = credential({
      origin: 'https://a.example.com',
      username: 'ada',
      password: 'pw',
      lastUsedAt: 10
    })
    const newer = credential({
      origin: 'https://b.example.com',
      username: 'ada',
      password: 'pw',
      lastUsedAt: 20
    })
    expect(savedLoginFor(candidate, [older, newer])).toBe(newer)
    const bob = credential({ origin: 'https://example.com', username: 'bob', password: 'pw' })
    expect(savedLoginFor({ ...candidate, username: '' }, [bob])).toBe(bob)
    expect(savedLoginFor(candidate, [bob])).toBeNull()
  })
})

describe('the sign-in leak check: when it runs', () => {
  const base = { enabled: true, isPrivate: false, saved: null }

  it('runs for an unsaved sign-in with nothing to remember on, and not without a password or with the setting off', () => {
    expect(decideLeakCheck({ password: 'pw' }, base)).toEqual({ kind: 'check', credentialId: null })
    expect(decideLeakCheck({ password: '' }, base)).toEqual({ kind: 'skip', reason: 'empty' })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, enabled: false })).toEqual({
      kind: 'skip',
      reason: 'disabled'
    })
  })

  it('remembers on the saved login, once per password value, never after Ignore', () => {
    const fresh = credential({ id: 'c1' })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, saved: fresh })).toEqual({
      kind: 'check',
      credentialId: 'c1'
    })
    const warned = credential({ id: 'c2', breached: 5, checkedAt: 1, leakWarnedAt: 1 })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, saved: warned })).toEqual({
      kind: 'skip',
      reason: 'warned'
    })
    const ignored = credential({
      id: 'c3',
      breached: 5,
      checkedAt: 1,
      leakWarnedAt: 1,
      leakIgnoredAt: 2
    })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, saved: ignored })).toEqual({
      kind: 'skip',
      reason: 'ignored'
    })
    // Checked clean earlier: a fresh lookup may find it breached now, so it runs and may warn.
    const clean = credential({ id: 'c4', breached: 0, checkedAt: 1 })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, saved: clean })).toEqual({
      kind: 'check',
      credentialId: 'c4'
    })
  })

  it('checks in a private tab but remembers nothing there, still honouring an earlier Ignore', () => {
    const fresh = credential({ id: 'c1' })
    expect(decideLeakCheck({ password: 'pw' }, { ...base, isPrivate: true, saved: fresh })).toEqual(
      {
        kind: 'check',
        credentialId: null
      }
    )
    const ignored = credential({ id: 'c3', breached: 5, leakIgnoredAt: 2 })
    expect(
      decideLeakCheck({ password: 'pw' }, { ...base, isPrivate: true, saved: ignored })
    ).toEqual({
      kind: 'skip',
      reason: 'ignored'
    })
  })
})

describe('the sign-in leak check: the range lookup', () => {
  it('sends the five-character prefix only and reads the count off the padded range', async () => {
    const requests: string[] = []
    const count = await lookupBreachCount(
      'password',
      {
        async fetchRange(prefix) {
          requests.push(prefix)
          return RANGE_5BAA6
        }
      },
      new AbortController().signal
    )
    expect(count).toBe(10_434_004)
    expect(requests).toEqual([PASSWORD_SHA1.slice(0, 5)])
    expect(requests[0]).toHaveLength(5)
  })

  it('reports a clean password as 0 and a network failure as null after the retries', async () => {
    const clean = await lookupBreachCount(
      'a-password-nobody-has-used-before-7a9f',
      {
        async fetchRange() {
          return RANGE_5BAA6
        }
      },
      new AbortController().signal
    )
    expect(clean).toBe(0)
    let attempts = 0
    const failed = await lookupBreachCount(
      'password',
      {
        async fetchRange() {
          attempts++
          return null
        }
      },
      new AbortController().signal
    )
    expect(failed).toBeNull()
    expect(attempts).toBe(3)
    expect(
      await lookupBreachCount(
        '',
        {
          async fetchRange() {
            return ''
          }
        },
        new AbortController().signal
      )
    ).toBeNull()
  })

  it('the checkup hands back every looked-up login\u2019s count, clean ones as 0', async () => {
    const strong = 'a-strong-unique-passphrase-of-length'
    const strongSha = (await sha1Hex(strong)).toUpperCase()
    const result = await runCheckup(
      [
        credential({ id: 'pw', password: 'password' }),
        credential({ id: 'ok', password: strong }),
        credential({ id: 'lost', password: 'unreachable-prefix-password' })
      ],
      {
        async fetchRange(prefix) {
          if (prefix === '5BAA6') return RANGE_5BAA6
          if (prefix === strongSha.slice(0, 5)) return 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDE:1\r\n'
          return null
        },
        async score() {
          return 4
        }
      },
      () => undefined,
      new AbortController().signal
    )
    expect([...result.breachCounts]).toEqual([
      ['pw', 10_434_004],
      ['ok', 0]
    ])
    expect(result.unchecked).toEqual(['lost'])
  })
})

describe('the sign-in leak check: where Change password goes', () => {
  const origin = 'https://accounts.example.com'
  const probe = (answers: Record<string, boolean>) => async (url: string) => answers[url] ?? false

  it('opens the well-known change-password page when the site serves one and answers the probe with an error', async () => {
    const url = await changePasswordUrl(
      origin,
      probe({
        [`${origin}${WELL_KNOWN_CHANGE_PASSWORD}`]: true,
        [`${origin}${WELL_KNOWN_NOT_EXIST}`]: false
      })
    )
    expect(url).toBe('https://accounts.example.com/.well-known/change-password')
  })

  it('falls back to the site when the page is missing, when the site answers 200 to anything, or when the probes fail', async () => {
    expect(await changePasswordUrl(origin, probe({}))).toBe('https://accounts.example.com/')
    expect(
      await changePasswordUrl(
        origin,
        probe({
          [`${origin}${WELL_KNOWN_CHANGE_PASSWORD}`]: true,
          [`${origin}${WELL_KNOWN_NOT_EXIST}`]: true
        })
      )
    ).toBe('https://accounts.example.com/')
    expect(
      await changePasswordUrl(origin, async () => {
        throw new Error('offline')
      })
    ).toBe('https://accounts.example.com/')
    expect(await changePasswordUrl('not an origin', probe({}))).toBe('not an origin')
  })
})

describe('the checkup summary', () => {
  const summary: CheckupSummary = { compromised: 2, weak: 1, reused: 4, checkedAt: 1_000 }

  it('takes the live compromised count off an open vault and leaves a locked one alone', () => {
    expect(withLiveCompromised(summary, { unlocked: () => false, compromisedCount: () => 0 })).toBe(
      summary
    )
    expect(withLiveCompromised(summary, { unlocked: () => true, compromisedCount: () => 2 })).toBe(
      summary
    )
    expect(
      withLiveCompromised(summary, { unlocked: () => true, compromisedCount: () => 3 })
    ).toEqual({
      ...summary,
      compromised: 3
    })
  })

  function input(passwords: Partial<PasswordsStatus> | null): SafetyCheckInput {
    return {
      now: 2_000,
      updates: null,
      safeBrowsing: { configured: false, enabled: null },
      passwords:
        passwords === null
          ? null
          : { ...emptyPasswordsStatus(), locked: false, count: 3, ...passwords },
      rules: [],
      lastVisitByOrigin: new Map(),
      notificationsShown: [],
      extensions: null
    }
  }

  it('Safety Check reads the summary: never run offers the checkup, a run speaks by its counts', () => {
    const never = composeSafetyCheck(input({})).passwords
    expect(never).toMatchObject({ state: 'info', known: false, checkedAt: null })
    expect(never.summary).toMatch(/Run Password Checkup/)

    const clean = composeSafetyCheck(
      input({ checkupSummary: { ...emptyCheckupSummary(), checkedAt: 1_000 } })
    ).passwords
    expect(clean).toMatchObject({ state: 'safe', known: true, checkedAt: 1_000, compromised: 0 })

    const bad = composeSafetyCheck(input({ checkupSummary: summary })).passwords
    expect(bad).toMatchObject({
      state: 'warning',
      compromised: 2,
      weak: 1,
      reused: 4,
      checkedAt: 1_000
    })
    expect(bad.summary).toBe('2 compromised passwords found; change them now')

    const soft = composeSafetyCheck(
      input({ checkupSummary: { ...summary, compromised: 0 } })
    ).passwords
    expect(soft).toMatchObject({ state: 'info', summary: '1 weak password, 4 reused passwords' })
  })

  it('a sign-in leak counts before any checkup ran, and a locked vault still shows the last run', () => {
    const leak = composeSafetyCheck(
      input({ checkupSummary: { ...emptyCheckupSummary(), compromised: 1 } })
    ).passwords
    expect(leak).toMatchObject({ state: 'warning', compromised: 1, known: true, checkedAt: null })

    const locked = composeSafetyCheck(input({ locked: true, checkupSummary: summary })).passwords
    expect(locked).toMatchObject({
      state: 'warning',
      compromised: 2,
      known: true,
      checkedAt: 1_000
    })
    const lockedNever = composeSafetyCheck(input({ locked: true })).passwords
    expect(lockedNever).toMatchObject({ state: 'info', known: false })
    expect(lockedNever.summary).toMatch(/Unlock the password vault/)
    expect(composeSafetyCheck(input({ count: 0 })).passwords).toMatchObject({
      state: 'safe',
      known: true
    })
  })
})

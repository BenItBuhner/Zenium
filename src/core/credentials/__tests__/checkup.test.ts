import { describe, expect, it } from 'vitest'
import {
  HIBP_RANGE_URL,
  RANGE_CONCURRENCY,
  WEAK_SCORE_THRESHOLD,
  breachCount,
  findReused,
  findWeak,
  parseRange,
  runCheckup,
  zxcvbnScorer,
  type CheckupDeps
} from '../checkup'
import { sha1Hex } from '../crypto'
import { credential } from './fakes'

/** SHA-1 of "password", the most breached string there is. */
const PASSWORD_SHA1 = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8'

/**
 * A padded range response as api.pwnedpasswords.com/range/5BAA6 returns it with `Add-Padding`:
 * real suffixes with counts, padding suffixes with count 0, CR LF line endings.
 */
const RANGE_5BAA6 = [
  '003D68EB55068C33ACE09247EE4C639306B:3',
  '1E4C9B93F3F0682250B6CF8331B7EE68FD8:10434004',
  '1F2B668E8AABEF1C59E9EC6F82E3F3CD786:0',
  '2ACB3C5A3D9CB8CBF6C9C1A4D8F4E7B2A11:0',
  'e4c9b93f3f0682250b6cf8331b7ee68fd8x:1',
  'garbage line',
  ''
].join('\r\n')

describe('HIBP range parsing', () => {
  it('reads suffix counts and drops padding and junk', () => {
    const range = parseRange(RANGE_5BAA6)
    expect(range.size).toBe(2)
    expect(range.get('003D68EB55068C33ACE09247EE4C639306B')).toBe(3)
    expect(range.get('1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(10_434_004)
    expect(range.has('1F2B668E8AABEF1C59E9EC6F82E3F3CD786')).toBe(false)
  })

  it('accepts LF endings and lowercase hex', () => {
    const range = parseRange('1e4c9b93f3f0682250b6cf8331b7ee68fd8:7\n')
    expect(range.get('1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(7)
    expect(parseRange('')).toEqual(new Map())
  })

  it('looks a hash up by its suffix', () => {
    const range = parseRange(RANGE_5BAA6)
    expect(breachCount(PASSWORD_SHA1, range)).toBe(10_434_004)
    expect(breachCount(PASSWORD_SHA1.toLowerCase(), range)).toBe(10_434_004)
    expect(breachCount('5BAA6' + 'F'.repeat(35), range)).toBe(0)
  })

  it('points at the k-anonymity endpoint', () => {
    expect(HIBP_RANGE_URL).toBe('https://api.pwnedpasswords.com/range/')
    expect(RANGE_CONCURRENCY).toBeLessThanOrEqual(4)
  })
})

describe('reuse and weakness', () => {
  it('groups logins sharing a password', async () => {
    const a = credential({ id: 'a', password: 'shared' })
    const b = credential({ id: 'b', password: 'shared' })
    const c = credential({ id: 'c', password: 'unique' })
    const d = credential({ id: 'd', password: 'shared' })
    const e = credential({ id: 'e', password: '' })
    const f = credential({ id: 'f', password: '' })
    expect(await findReused([a, b, c, d, e, f])).toEqual([['a', 'b', 'd']])
    expect(await findReused([c])).toEqual([])
  })

  it('flags scores under the threshold and empty passwords, scoring each password once', async () => {
    const scores: Record<string, number> = { weak: 1, fine: 3, strong: 4, borderline: 2 }
    let calls = 0
    const score = async (pw: string): Promise<number> => {
      calls++
      return scores[pw] ?? 0
    }
    const weak = await findWeak(
      [
        credential({ id: 'a', password: 'weak' }),
        credential({ id: 'b', password: 'fine' }),
        credential({ id: 'c', password: 'strong' }),
        credential({ id: 'd', password: 'borderline' }),
        credential({ id: 'e', password: '' }),
        credential({ id: 'f', password: 'weak' })
      ],
      score
    )
    expect(weak).toEqual(['a', 'd', 'e', 'f'])
    expect(calls).toBe(4)
    expect(WEAK_SCORE_THRESHOLD).toBe(3)
  })

  it('scores with zxcvbn the way Chrome draws the line', async () => {
    const score = await zxcvbnScorer()
    expect(score('password')).toBeLessThan(WEAK_SCORE_THRESHOLD)
    expect(score('qwerty123')).toBeLessThan(WEAK_SCORE_THRESHOLD)
    expect(score('Password1!')).toBeLessThan(WEAK_SCORE_THRESHOLD)
    expect(score('correct horse battery staple')).toBeGreaterThanOrEqual(WEAK_SCORE_THRESHOLD)
    expect(score('xK9#mQ2$vL8@pR4&wN7!')).toBeGreaterThanOrEqual(WEAK_SCORE_THRESHOLD)
  }, 20_000)
})

describe('checkup run', () => {
  function deps(ranges: Record<string, string | null>): CheckupDeps & { requests: string[] } {
    const requests: string[] = []
    return {
      requests,
      async fetchRange(prefix) {
        requests.push(prefix)
        return ranges[prefix] ?? ''
      },
      async score(pw) {
        return pw.length >= 16 ? 4 : 1
      }
    }
  }

  it('finds compromised, weak and reused logins from fixtures, one request per prefix', async () => {
    const strong = 'a-strong-unique-passphrase-of-length'
    const strongSha = (await sha1Hex(strong)).toUpperCase()
    const logins = [
      credential({ id: 'pw1', password: 'password' }),
      credential({ id: 'pw2', password: 'password' }),
      credential({ id: 'ok', password: strong }),
      credential({ id: 'empty', password: '' })
    ]
    const d = deps({
      '5BAA6': RANGE_5BAA6,
      [strongSha.slice(0, 5)]: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDE:1\r\n'
    })
    const progress: Array<{ checked: number; total: number }> = []
    const result = await runCheckup(
      logins,
      d,
      (p) => progress.push(p),
      new AbortController().signal
    )
    expect(result.compromised).toEqual(['pw1', 'pw2'])
    expect(result.weak).toEqual(['pw1', 'pw2', 'empty'])
    expect(result.reused).toEqual([['pw1', 'pw2']])
    expect(result.unchecked).toEqual([])
    expect(result.offline).toBe(false)
    expect(d.requests.sort()).toEqual(['5BAA6', strongSha.slice(0, 5)].sort())
    expect(progress[0]).toEqual({ checked: 1, total: 4 })
    expect(progress.at(-1)).toEqual({ checked: 4, total: 4 })
  })

  it('never sends more than the five-character prefix', async () => {
    const d = deps({})
    await runCheckup(
      [credential({ password: 'password' })],
      d,
      () => {},
      new AbortController().signal
    )
    expect(d.requests).toEqual(['5BAA6'])
    expect(d.requests[0]).not.toContain(PASSWORD_SHA1.slice(5, 10))
  })

  it('reports logins whose lookup failed and detects being offline', async () => {
    const failing: CheckupDeps = {
      async fetchRange() {
        return null
      },
      async score() {
        return 4
      }
    }
    const logins = [
      credential({ id: 'a', password: 'one-password-here' }),
      credential({ id: 'b', password: 'another-one-there' })
    ]
    const result = await runCheckup(logins, failing, () => {}, new AbortController().signal)
    expect(result.unchecked.sort()).toEqual(['a', 'b'])
    expect(result.offline).toBe(true)
    expect(result.compromised).toEqual([])
  }, 20_000)

  it('retries a failed range once the service answers', async () => {
    let attempts = 0
    const flaky: CheckupDeps = {
      async fetchRange() {
        attempts++
        if (attempts === 1) throw new Error('timeout')
        return RANGE_5BAA6
      },
      async score() {
        return 4
      }
    }
    const result = await runCheckup(
      [credential({ id: 'a', password: 'password' })],
      flaky,
      () => {},
      new AbortController().signal
    )
    expect(attempts).toBe(2)
    expect(result.compromised).toEqual(['a'])
    expect(result.offline).toBe(false)
  })

  it('stops when aborted and marks the rest unchecked', async () => {
    const controller = new AbortController()
    const d: CheckupDeps = {
      async fetchRange() {
        controller.abort()
        return RANGE_5BAA6
      },
      async score() {
        return 4
      }
    }
    const logins = Array.from({ length: 12 }, (_, i) =>
      credential({ id: `l${i}`, password: `distinct-${i}` })
    )
    const result = await runCheckup(logins, d, () => {}, controller.signal)
    expect(result.compromised).toEqual([])
    expect(result.unchecked.length + result.compromised.length).toBe(12)
  })
})

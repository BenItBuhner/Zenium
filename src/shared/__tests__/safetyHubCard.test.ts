import { describe, expect, it } from 'vitest'
import {
  SAFETY_HUB_CARD_TYPES,
  SAFETY_HUB_INTERVAL_MS,
  SAFETY_HUB_MAX_RUNS,
  SAFETY_HUB_MIN_IMPRESSIONS,
  SAFETY_HUB_MIN_RUN_MS,
  SAFETY_HUB_PRIORITY,
  SAFETY_HUB_SAFE_BROWSING_DELAY_MS,
  activeSafetyHubType,
  dismissSafetyHubCard,
  emptySafetyHubCardMemory,
  pickSafetyHubCard,
  safetyHubCardButton,
  safetyHubCardButtonLabel,
  safetyHubCardSummary,
  safetyHubCardTitle,
  safetyHubResult,
  safetyHubShouldShow,
  safetyHubTriggers,
  safetyHubWarrants,
  sameSafetyHubCardMemories,
  sanitizeSafetyHubCardMemories,
  type SafetyHubCardMemories,
  type SafetyHubCardMemory,
  type SafetyHubCardType,
  type SafetyHubInputs
} from '../safetyHubCard'

/*
 * Chrome's SafetyHubMenuNotificationService as the Magic Stack's Safety check card runs it
 * (menu_notification_service.cc, menu_notification.cc at 152.0.7977.89): one type at a time by
 * priority, a run seen enough after three days and five impressions, a dismissed type back after
 * its interval once its result warrants it, Safe Browsing a day late and three times at most.
 */

const DAY = 24 * 3_600_000
const T0 = Date.UTC(2026, 0, 1)

const CLEAR: SafetyHubInputs = {
  revokedOrigins: [],
  safeBrowsingEnabled: true,
  compromisedPasswords: 0
}
const REVOKED: SafetyHubInputs = { ...CLEAR, revokedOrigins: ['https://a.example'] }
const SB_OFF: SafetyHubInputs = { ...CLEAR, safeBrowsingEnabled: false }
const LEAKED: SafetyHubInputs = { ...CLEAR, compromisedPasswords: 2 }
const ALL: SafetyHubInputs = {
  revokedOrigins: ['https://a.example'],
  safeBrowsingEnabled: false,
  compromisedPasswords: 2
}

function memory(over: Partial<SafetyHubCardMemory> = {}): SafetyHubCardMemory {
  return { ...emptySafetyHubCardMemory(), ...over }
}

/** A run of `type` on since `since`, seen `impressions` times, last at `last`. */
function running(
  type: SafetyHubCardType,
  inputs: SafetyHubInputs,
  since: number,
  impressions: number,
  last = since
): SafetyHubCardMemories {
  return {
    [type]: memory({
      activeSince: since,
      impressions,
      lastShownAt: last,
      result: safetyHubResult(type, inputs)
    })
  }
}

/** Runs the pick `n` times a minute apart from `from`, returning the last pick and the time. */
function impressions(
  inputs: SafetyHubInputs,
  memories: SafetyHubCardMemories,
  from: number,
  n: number
): { type: SafetyHubCardType | null; memories: SafetyHubCardMemories; now: number } {
  let m = memories
  let type: SafetyHubCardType | null = null
  let now = from
  for (let i = 0; i < n; i++) {
    now = from + i * 60_000
    const pick = pickSafetyHubCard(inputs, m, now)
    m = pick.memories
    type = pick.type
  }
  return { type, memories: m, now }
}

describe('the constants', () => {
  it('are Chrome’s: three types in priority order, the intervals, the cap, the seen-enough bar', () => {
    expect(SAFETY_HUB_CARD_TYPES).toEqual(['passwords', 'safe-browsing', 'revoked-permissions'])
    expect(SAFETY_HUB_PRIORITY).toEqual({
      passwords: 2,
      'safe-browsing': 1,
      'revoked-permissions': 0
    })
    expect(SAFETY_HUB_INTERVAL_MS).toEqual({
      passwords: 0,
      'safe-browsing': 90 * DAY,
      'revoked-permissions': 10 * DAY
    })
    expect(SAFETY_HUB_MAX_RUNS).toEqual({
      passwords: 0,
      'safe-browsing': 3,
      'revoked-permissions': 0
    })
    expect(SAFETY_HUB_MIN_RUN_MS).toBe(3 * DAY)
    expect(SAFETY_HUB_MIN_IMPRESSIONS).toBe(5)
    expect(SAFETY_HUB_SAFE_BROWSING_DELAY_MS).toBe(DAY)
  })
})

describe('results, triggers and what warrants a new run', () => {
  it('stores the origins sorted and once, the switch, the count', () => {
    expect(
      safetyHubResult('revoked-permissions', {
        ...CLEAR,
        revokedOrigins: ['https://b.example', 'https://a.example', 'https://b.example']
      })
    ).toBe('https://a.example\nhttps://b.example')
    expect(safetyHubResult('revoked-permissions', CLEAR)).toBe('')
    expect(safetyHubResult('safe-browsing', CLEAR)).toBe('on')
    expect(safetyHubResult('safe-browsing', SB_OFF)).toBe('off')
    expect(safetyHubResult('passwords', LEAKED)).toBe('2')
    expect(safetyHubResult('passwords', { ...CLEAR, compromisedPasswords: -1 })).toBe('0')
  })

  it('triggers on a revoked origin, the switch off, a compromised login', () => {
    for (const type of SAFETY_HUB_CARD_TYPES) expect(safetyHubTriggers(type, CLEAR)).toBe(false)
    expect(safetyHubTriggers('revoked-permissions', REVOKED)).toBe(true)
    expect(safetyHubTriggers('safe-browsing', SB_OFF)).toBe(true)
    expect(safetyHubTriggers('passwords', LEAKED)).toBe(true)
    expect(safetyHubTriggers('passwords', REVOKED)).toBe(false)
  })

  it('warrants a run on a new origin, on Safe Browsing always, on a count that grew', () => {
    expect(safetyHubWarrants('revoked-permissions', 'https://a.example', 'https://a.example')).toBe(
      false
    )
    expect(safetyHubWarrants('revoked-permissions', 'https://a.example', '')).toBe(false)
    expect(
      safetyHubWarrants(
        'revoked-permissions',
        'https://a.example',
        'https://a.example\nhttps://b.example'
      )
    ).toBe(true)
    expect(safetyHubWarrants('revoked-permissions', '', 'https://a.example')).toBe(true)
    expect(safetyHubWarrants('safe-browsing', 'off', 'off')).toBe(true)
    expect(safetyHubWarrants('passwords', '2', '3')).toBe(true)
    expect(safetyHubWarrants('passwords', '2', '2')).toBe(false)
    expect(safetyHubWarrants('passwords', '3', '1')).toBe(false)
  })
})

describe('ShouldBeShown', () => {
  it('a type never shown shows as soon as it triggers; one that does not trigger never does', () => {
    expect(safetyHubShouldShow('passwords', LEAKED, memory(), T0)).toBe(true)
    expect(safetyHubShouldShow('passwords', CLEAR, memory(), T0)).toBe(false)
    expect(safetyHubShouldShow('revoked-permissions', REVOKED, memory(), T0)).toBe(true)
  })

  it('waits for its show-after time', () => {
    const m = memory({ showAfter: T0 + DAY })
    expect(safetyHubShouldShow('safe-browsing', SB_OFF, m, T0)).toBe(false)
    expect(safetyHubShouldShow('safe-browsing', SB_OFF, m, T0 + DAY - 1)).toBe(false)
    expect(safetyHubShouldShow('safe-browsing', SB_OFF, m, T0 + DAY)).toBe(true)
  })

  it('a running type keeps showing until three days AND five impressions have passed', () => {
    const young = memory({ activeSince: T0, impressions: 9, lastShownAt: T0 + 2 * DAY })
    expect(safetyHubShouldShow('passwords', LEAKED, young, T0 + 3 * DAY - 1)).toBe(true)
    const few = memory({ activeSince: T0, impressions: 4, lastShownAt: T0 + 3 * DAY })
    expect(safetyHubShouldShow('passwords', LEAKED, few, T0 + 10 * DAY)).toBe(true)
    const enough = memory({ activeSince: T0, impressions: 5, lastShownAt: T0 + 3 * DAY })
    expect(safetyHubShouldShow('passwords', LEAKED, enough, T0 + 3 * DAY)).toBe(false)
  })

  it('a dismissed type returns only when due and its interval has passed since it was last shown', () => {
    const dismissed = memory({ lastShownAt: T0, runs: 1, result: 'https://a.example' })
    expect(safetyHubShouldShow('revoked-permissions', REVOKED, dismissed, T0 + 30 * DAY)).toBe(
      false
    )
    const due = { ...dismissed, due: true }
    expect(safetyHubShouldShow('revoked-permissions', REVOKED, due, T0 + 10 * DAY - 1)).toBe(false)
    expect(safetyHubShouldShow('revoked-permissions', REVOKED, due, T0 + 10 * DAY)).toBe(true)
    // Passwords have no interval: due is enough.
    expect(
      safetyHubShouldShow('passwords', LEAKED, memory({ lastShownAt: T0, runs: 1, due: true }), T0)
    ).toBe(true)
  })

  it('Safe Browsing stops for good at its third run', () => {
    const capped = memory({ lastShownAt: T0, runs: 3, due: true })
    expect(safetyHubShouldShow('safe-browsing', SB_OFF, capped, T0 + 400 * DAY)).toBe(false)
    expect(
      safetyHubShouldShow('safe-browsing', SB_OFF, { ...capped, runs: 2 }, T0 + 400 * DAY)
    ).toBe(true)
    // The other types have no cap.
    expect(
      safetyHubShouldShow(
        'revoked-permissions',
        REVOKED,
        memory({ lastShownAt: T0, runs: 40, due: true }),
        T0 + 10 * DAY
      )
    ).toBe(true)
  })
})

describe('pickSafetyHubCard: one impression of the stack', () => {
  it('shows nothing from a clear profile and starts every type’s record, Safe Browsing’s with its day', () => {
    const pick = pickSafetyHubCard(CLEAR, {}, T0)
    expect(pick.type).toBeNull()
    expect(pick.memories.passwords).toEqual(memory({ result: '0' }))
    expect(pick.memories['revoked-permissions']).toEqual(memory({ result: '' }))
    expect(pick.memories['safe-browsing']).toEqual(memory({ result: 'on', showAfter: T0 + DAY }))
  })

  it('picks by priority: passwords over Safe Browsing over revoked permissions', () => {
    // The first look: Safe Browsing waits its day, so passwords beat revoked permissions.
    const first = pickSafetyHubCard(ALL, {}, T0)
    expect(first.type).toBe('passwords')
    expect(first.memories.passwords).toEqual(
      memory({ activeSince: T0, impressions: 1, lastShownAt: T0, result: '2' })
    )
    expect(first.memories['revoked-permissions']).toEqual(memory({ result: 'https://a.example' }))
    // A day on, the passwords fixed: Safe Browsing ahead of revoked permissions.
    const second = pickSafetyHubCard({ ...ALL, compromisedPasswords: 0 }, first.memories, T0 + DAY)
    expect(second.type).toBe('safe-browsing')
    // Safe Browsing back on too: revoked permissions.
    const third = pickSafetyHubCard(REVOKED, second.memories, T0 + DAY + 1)
    expect(third.type).toBe('revoked-permissions')
  })

  it('the winner takes the impression; every other running type is dismissed', () => {
    // Revoked permissions running for a day when the passwords turn up compromised.
    const before = running('revoked-permissions', REVOKED, T0, 2)
    const pick = pickSafetyHubCard({ ...REVOKED, compromisedPasswords: 1 }, before, T0 + DAY)
    expect(pick.type).toBe('passwords')
    expect(pick.memories['revoked-permissions']).toEqual(
      memory({
        activeSince: null,
        impressions: 0,
        lastShownAt: T0,
        runs: 1,
        result: 'https://a.example'
      })
    )
    expect(pick.memories.passwords?.activeSince).toBe(T0 + DAY)
    expect(pick.memories.passwords?.impressions).toBe(1)
  })

  it('a run ends after three days and five impressions and the next type steps up', () => {
    const start = pickSafetyHubCard({ ...REVOKED, compromisedPasswords: 1 }, {}, T0)
    expect(start.type).toBe('passwords')
    // Four more impressions inside the three days: still the passwords.
    const day1 = impressions({ ...REVOKED, compromisedPasswords: 1 }, start.memories, T0 + DAY, 4)
    expect(day1.type).toBe('passwords')
    expect(day1.memories.passwords?.impressions).toBe(5)
    // Three days on: seen enough. The run is dismissed and revoked permissions take the stack.
    const later = pickSafetyHubCard(
      { ...REVOKED, compromisedPasswords: 1 },
      day1.memories,
      T0 + 3 * DAY
    )
    expect(later.type).toBe('revoked-permissions')
    expect(later.memories.passwords).toMatchObject({
      activeSince: null,
      impressions: 0,
      runs: 1,
      due: false,
      result: '1'
    })
    // Five impressions but under three days would have kept it.
    const early = pickSafetyHubCard(
      { ...REVOKED, compromisedPasswords: 1 },
      day1.memories,
      T0 + 3 * DAY - 1
    )
    expect(early.type).toBe('passwords')
  })

  it('a dismissed type returns after its interval when a new result warrants it, not before, not for the same result', () => {
    const dismissed: SafetyHubCardMemories = {
      'revoked-permissions': memory({ lastShownAt: T0, runs: 1, result: 'https://a.example' })
    }
    // The same origin, long after: nothing.
    expect(pickSafetyHubCard(REVOKED, dismissed, T0 + 30 * DAY).type).toBeNull()
    // A new origin inside the interval: due, but not yet.
    const more = { ...REVOKED, revokedOrigins: ['https://a.example', 'https://b.example'] }
    const soon = pickSafetyHubCard(more, dismissed, T0 + 5 * DAY)
    expect(soon.type).toBeNull()
    expect(soon.memories['revoked-permissions']).toMatchObject({
      due: true,
      result: 'https://a.example\nhttps://b.example'
    })
    // The interval passed: it returns, its second run.
    const back = pickSafetyHubCard(more, soon.memories, T0 + 10 * DAY)
    expect(back.type).toBe('revoked-permissions')
    expect(back.memories['revoked-permissions']).toMatchObject({
      activeSince: T0 + 10 * DAY,
      impressions: 1,
      due: false,
      runs: 1
    })
    // The due mark set once stays until the run starts (the origin list may shrink meanwhile).
    const shrunk = pickSafetyHubCard(REVOKED, soon.memories, T0 + 10 * DAY)
    expect(shrunk.type).toBe('revoked-permissions')
  })

  it('passwords come back the moment more of them are compromised, and not when fewer', () => {
    const dismissed: SafetyHubCardMemories = {
      passwords: memory({ lastShownAt: T0, runs: 1, result: '2' })
    }
    expect(pickSafetyHubCard(LEAKED, dismissed, T0 + 1).type).toBeNull()
    expect(
      pickSafetyHubCard({ ...CLEAR, compromisedPasswords: 1 }, dismissed, T0 + 1).type
    ).toBeNull()
    expect(pickSafetyHubCard({ ...CLEAR, compromisedPasswords: 3 }, dismissed, T0 + 1).type).toBe(
      'passwords'
    )
  })

  it('Safe Browsing waits a day from the first look after its switch went off, and re-arms when the switch moves', () => {
    const first = pickSafetyHubCard(SB_OFF, {}, T0)
    expect(first.type).toBeNull()
    expect(pickSafetyHubCard(SB_OFF, first.memories, T0 + DAY - 1).type).toBeNull()
    const shown = pickSafetyHubCard(SB_OFF, first.memories, T0 + DAY)
    expect(shown.type).toBe('safe-browsing')
    // Switched back on while the card is up: the result flip re-arms the day and resets the cap
    // (Chrome's OnSafeBrowsingPrefUpdate), then the run that was on ends with its dismissal – the
    // one run counted.
    const on = pickSafetyHubCard(CLEAR, shown.memories, T0 + 2 * DAY)
    expect(on.type).toBeNull()
    expect(on.memories['safe-browsing']).toMatchObject({
      activeSince: null,
      showAfter: T0 + 3 * DAY,
      runs: 1,
      result: 'on'
    })
    // Off again: the flip resets the cap for the new off period and starts another day's wait
    // from that look. The 90-day interval still runs from the last impression (Chrome's
    // HasIntervalPassed), so the card is back after that, not after the day.
    const off = pickSafetyHubCard(SB_OFF, on.memories, T0 + 2 * DAY + 1)
    expect(off.type).toBeNull()
    expect(off.memories['safe-browsing']).toMatchObject({
      showAfter: T0 + 3 * DAY + 1,
      runs: 0,
      result: 'off'
    })
    expect(pickSafetyHubCard(SB_OFF, off.memories, T0 + 3 * DAY + 1).type).toBeNull()
    expect(pickSafetyHubCard(SB_OFF, off.memories, T0 + DAY + 90 * DAY - 1).type).toBeNull()
    expect(pickSafetyHubCard(SB_OFF, off.memories, T0 + DAY + 90 * DAY).type).toBe('safe-browsing')
  })

  it('Safe Browsing shows three runs at most while the switch stays off', () => {
    let m: SafetyHubCardMemories = {
      'safe-browsing': memory({ result: 'off', showAfter: T0 })
    }
    let now = T0
    for (let run = 0; run < 3; run++) {
      // Enough impressions over three days to end the run.
      const seen = impressions(SB_OFF, m, now, 5)
      expect(seen.type).toBe('safe-browsing')
      now = seen.now + 3 * DAY
      const ended = pickSafetyHubCard(SB_OFF, seen.memories, now)
      expect(ended.type).toBeNull()
      expect(ended.memories['safe-browsing']?.runs).toBe(run + 1)
      // The interval (90 days) passes; the switch still off warrants another run.
      now += 90 * DAY
      m = ended.memories
    }
    expect(pickSafetyHubCard(SB_OFF, m, now).type).toBeNull()
    expect(pickSafetyHubCard(SB_OFF, m, now + 1000 * DAY).type).toBeNull()
  })

  it('settles: after the records exist (and Safe Browsing’s latent due mark, which Chrome sets on every update while inactive) a look changes nothing, so the component writes nothing', () => {
    const first = pickSafetyHubCard(CLEAR, {}, T0)
    const second = pickSafetyHubCard(CLEAR, first.memories, T0 + 5)
    expect(sameSafetyHubCardMemories(second.memories, first.memories)).toBe(false)
    expect(second.memories['safe-browsing']?.due).toBe(true)
    const third = pickSafetyHubCard(CLEAR, second.memories, T0 + 10)
    expect(third.type).toBeNull()
    expect(sameSafetyHubCardMemories(third.memories, second.memories)).toBe(true)
    // A profile with something to show settles the same way once the winner's run is on.
    const shown = impressions(REVOKED, {}, T0, 3)
    expect(shown.type).toBe('revoked-permissions')
    expect(shown.memories['revoked-permissions']?.impressions).toBe(3)
  })
})

describe('the running type and its dismissal', () => {
  it('names the type whose run is on, by priority when a record names more than one', () => {
    expect(activeSafetyHubType({})).toBeNull()
    expect(activeSafetyHubType(running('revoked-permissions', REVOKED, T0, 1))).toBe(
      'revoked-permissions'
    )
    expect(
      activeSafetyHubType({
        ...running('revoked-permissions', REVOKED, T0, 1),
        ...running('safe-browsing', SB_OFF, T0, 1)
      })
    ).toBe('safe-browsing')
  })

  it('dismisses the running type – the button’s act, the trigger clearing – and leaves a type with no run as it is', () => {
    const on = running('safe-browsing', SB_OFF, T0, 3)
    const off = dismissSafetyHubCard(on, 'safe-browsing')
    expect(off['safe-browsing']).toEqual(
      memory({ activeSince: null, impressions: 0, lastShownAt: T0, runs: 1, result: 'off' })
    )
    expect(dismissSafetyHubCard(on, 'passwords')).toBe(on)
    expect(dismissSafetyHubCard(off, 'safe-browsing')).toBe(off)
    expect(dismissSafetyHubCard({}, 'passwords')).toEqual({})
  })
})

describe('the record on disk', () => {
  it('reads each field as its own kind, drops unknown types, gives a run its first impression', () => {
    expect(sanitizeSafetyHubCardMemories(undefined)).toEqual({})
    expect(sanitizeSafetyHubCardMemories('x')).toEqual({})
    expect(sanitizeSafetyHubCardMemories([])).toEqual({})
    expect(
      sanitizeSafetyHubCardMemories({
        passwords: {
          activeSince: 1_700_000_000_000.7,
          impressions: '5',
          runs: 2.9,
          showAfter: -4,
          due: 'yes',
          result: 3
        },
        'safe-browsing': null,
        price: { activeSince: 5 },
        'revoked-permissions': {
          impressions: -1,
          lastShownAt: 10,
          due: true,
          result: 'x'.repeat(9_000)
        }
      })
    ).toEqual({
      passwords: memory({
        activeSince: 1_700_000_000_000,
        impressions: 0,
        lastShownAt: 1_700_000_000_000,
        runs: 2,
        showAfter: null,
        due: false,
        result: null
      }),
      'revoked-permissions': memory({
        impressions: 0,
        lastShownAt: 10,
        due: true,
        result: 'x'.repeat(8_192)
      })
    })
  })

  it('compares records field by field, a missing type equal to a missing type only', () => {
    const a = pickSafetyHubCard(ALL, {}, T0).memories
    expect(sameSafetyHubCardMemories(a, { ...a })).toBe(true)
    expect(sameSafetyHubCardMemories(a, {})).toBe(false)
    expect(sameSafetyHubCardMemories({}, {})).toBe(true)
    const b = { ...a, passwords: { ...(a.passwords as SafetyHubCardMemory), impressions: 2 } }
    expect(sameSafetyHubCardMemories(a, b)).toBe(false)
    expect(
      sameSafetyHubCardMemories(a, sanitizeSafetyHubCardMemories(JSON.parse(JSON.stringify(a))))
    ).toBe(true)
  })
})

describe('the words', () => {
  it('titles the card as Chrome does, the origin count in the revoked one', () => {
    expect(safetyHubCardTitle('revoked-permissions', REVOKED)).toBe(
      'Removed permissions for 1 site'
    )
    expect(
      safetyHubCardTitle('revoked-permissions', {
        ...CLEAR,
        revokedOrigins: ['https://a.example', 'https://b.example', 'https://a.example']
      })
    ).toBe('Removed permissions for 2 sites')
    expect(safetyHubCardTitle('safe-browsing', SB_OFF)).toBe('Turn on Safe Browsing')
    expect(safetyHubCardTitle('passwords', LEAKED)).toBe('Change passwords')
  })

  it('gives the Safe Browsing and passwords cards their summary line and the revoked one none', () => {
    expect(safetyHubCardSummary('revoked-permissions', REVOKED)).toBeNull()
    expect(safetyHubCardSummary('safe-browsing', SB_OFF)).toBe('Safe Browsing is off')
    expect(safetyHubCardSummary('passwords', { ...CLEAR, compromisedPasswords: 1 })).toBe(
      'Found 1 compromised password'
    )
    expect(safetyHubCardSummary('passwords', LEAKED)).toBe('Found 2 compromised passwords')
  })

  it('names the button and its accessible name', () => {
    expect(safetyHubCardButton('revoked-permissions')).toBe('Review')
    expect(safetyHubCardButtonLabel('revoked-permissions')).toBe('Review Safety check')
    expect(safetyHubCardButton('safe-browsing')).toBe('Go to settings')
    expect(safetyHubCardButtonLabel('safe-browsing')).toBe('Go to settings')
    expect(safetyHubCardButton('passwords')).toBe('Change passwords')
    expect(safetyHubCardButtonLabel('passwords')).toBe('Change passwords')
  })
})

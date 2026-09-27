import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPromptHost, StoreIO } from '../platform'
import type { RevokedSitePermissions } from '../../shared/types'
import { tracksLastVisit } from '../../shared/contentSettings'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { DEVICE_LOCAL_SETTINGS } from '../sync/records'
import {
  PermissionService,
  REVOKED_PERMISSIONS_KEPT_MS,
  UNUSED_PERMISSION_MS,
  VISIT_STAMP_PRECISION_MS,
  coarseVisitTime,
  type PermissionChange
} from '../permissions'

const DAY = 24 * 3_600_000
/** A Sunday noon; the tests move the clock from here. */
const T0 = Date.UTC(2026, 8, 27, 12)
const WEEK0 = coarseVisitTime(T0)
const SITE = 'https://cam.example'
const OTHER = 'https://mic.example'

function fakeIo(initial: string | null = null): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => initial,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

const silent: PermissionPromptHost = { show: async () => null, cancel: () => undefined }

interface Harness {
  p: PermissionService
  io: ReturnType<typeof fakeIo>
  changes: PermissionChange[]
  clock: { now: number }
  /** The file as the last write left it. */
  file(): Record<string, unknown>
}

function service(initial: string | null = null, now = T0): Harness {
  const io = fakeIo(initial)
  const clock = { now }
  const changes: PermissionChange[] = []
  const p = new PermissionService(io, silent, () => clock.now)
  p.subscribe((change) => changes.push(change))
  return {
    p,
    io,
    changes,
    clock,
    file: () => {
      p.flushSync()
      return JSON.parse(io.writes.at(-1) ?? '{}') as Record<string, unknown>
    }
  }
}

/** A service whose `SITE` camera allow was stamped `weeksAgo` weeks before `T0`. */
function stale(weeksAgo: number, permission = 'camera', origin = SITE): Harness {
  const h = service(null, T0 - weeksAgo * 7 * DAY)
  h.p.set(permission, origin, 'allow')
  h.clock.now = T0
  h.changes.length = 0
  return h
}

describe('the visit stamp (PS-41)', () => {
  it('stamps every allow the user makes – a Settings grant as a prompt grant – with the week, not the moment', () => {
    const h = service()
    h.clock.now = T0 + 3 * DAY + 4321
    h.p.set('camera', SITE, 'allow')
    h.p.remember('microphone', `${SITE}/call`, 'allow')
    const stamp = coarseVisitTime(h.clock.now)
    expect(stamp % VISIT_STAMP_PRECISION_MS).toBe(0)
    expect(h.clock.now - stamp).toBeLessThan(VISIT_STAMP_PRECISION_MS)
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'allow', lastVisitedAt: stamp },
      { origin: SITE, permission: 'microphone', decision: 'allow', lastVisitedAt: stamp }
    ])
    // The file keeps the coarse stamp beside the decisions and stays a v1 file.
    const file = h.file()
    expect(file.version).toBe(1)
    expect(file.meta).toEqual({
      [`${SITE}|camera`]: { lastVisitedAt: stamp },
      [`${SITE}|microphone`]: { lastVisitedAt: stamp }
    })
    expect(file).not.toHaveProperty('revokedUnused')
  })

  it('never stamps a deny, a default, notifications or a permission outside the sweep’s reach', () => {
    const h = service()
    h.p.set('camera', SITE, 'deny')
    h.p.set('notifications', SITE, 'allow')
    h.p.set('popups', SITE, 'allow')
    h.p.setDefault('geolocation', 'allow')
    for (const rule of h.p.rules()) expect(rule).not.toHaveProperty('lastVisitedAt')
    expect(h.file()).not.toHaveProperty('meta')
  })

  it('is refreshed by a visit to the site – every reachable allow, an older unstamped one included – and only writes when the week changed', () => {
    const h = service(
      JSON.stringify({
        version: 1,
        decisions: {
          [`${SITE}|camera`]: 'allow',
          [`${SITE}|geolocation`]: 'allow',
          [`${SITE}|notifications`]: 'allow',
          [`${SITE}|popups`]: 'deny',
          [`${OTHER}|microphone`]: 'allow'
        }
      })
    )
    // A file from before the clock: no rule carries a stamp, so none is within the sweep's reach.
    for (const rule of h.p.rules()) expect(rule).not.toHaveProperty('lastVisitedAt')
    expect(h.p.sweepUnused(true, T0 + 400 * DAY)).toEqual({ revoked: [], expired: 0 })

    h.p.onPageVisited(`${SITE}/inbox?x=1`)
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'allow', lastVisitedAt: WEEK0 },
      { origin: SITE, permission: 'geolocation', decision: 'allow', lastVisitedAt: WEEK0 },
      { origin: OTHER, permission: 'microphone', decision: 'allow' },
      { origin: SITE, permission: 'notifications', decision: 'allow' },
      { origin: SITE, permission: 'popups', decision: 'deny' }
    ])
    // A stamp is not a decision: nobody is told.
    expect(h.changes).toEqual([])
    h.p.flushSync()
    const writes = h.io.writes.length
    h.clock.now = T0 + 2 * DAY
    h.p.onPageVisited(`${SITE}/again`)
    h.p.flushSync()
    expect(h.io.writes).toHaveLength(writes)
    h.clock.now = T0 + 8 * DAY
    h.p.onPageVisited(`${SITE}/next-week`)
    h.p.flushSync()
    expect(h.io.writes).toHaveLength(writes + 1)
    expect(h.p.rules()[0]).toMatchObject({ lastVisitedAt: coarseVisitTime(T0 + 8 * DAY) })
  })

  it('ignores a visit to a page without a site, or to a site with nothing allowed', () => {
    const h = service()
    h.p.onPageVisited('about:blank')
    h.p.onPageVisited('https://nothing.example/')
    h.p.flushSync()
    expect(h.io.writes).toEqual([])
  })
})

describe('the eligibility of a rule for the sweep (Chrome’s CanTrackLastVisit)', () => {
  it('reaches the ask-default permissions of the permissions and additional groups, mediaKeySystem and per-site external applications', () => {
    for (const permission of [
      'geolocation',
      'camera',
      'microphone',
      'automatic-downloads',
      'midi',
      'fileSystem',
      'clipboard-read',
      'window-management',
      'local-network-access',
      'storage-access',
      'top-level-storage-access',
      'idle-detection',
      'mediaKeySystem',
      'openExternal:zoommtg',
      'openExternal:mailto'
    ])
      expect(tracksLastVisit(permission), permission).toBe(true)
  })

  it('never reaches notifications, a device kind, a content row or an unknown name', () => {
    for (const permission of [
      'notifications',
      'hid',
      'usb',
      'serial',
      'bluetooth',
      'popups',
      'javascript',
      'images',
      'sound',
      'cookies',
      'nonsense'
    ])
      expect(tracksLastVisit(permission), permission).toBe(false)
  })
})

describe('the sweep (PS-41)', () => {
  it('revokes an allow unused for 60 days into the site’s 30-day record, one change per key, and asks again', () => {
    const h = stale(10)
    h.p.set('geolocation', SITE, 'allow')
    h.clock.now = T0
    h.changes.length = 0
    const weeksAgo10 = coarseVisitTime(T0 - 70 * DAY)
    // The camera carries the old week (the site was not visited since); the sweep runs at T0.
    expect(h.p.rules().map((r) => r.lastVisitedAt)).toEqual([weeksAgo10, WEEK0])
    // Only the camera is stale: geolocation was allowed this week.
    const result = h.p.sweepUnused(true, T0)
    expect(result).toEqual({
      revoked: [
        {
          origin: SITE,
          permissions: ['camera'],
          revokedAt: T0,
          expiresAt: T0 + REVOKED_PERMISSIONS_KEPT_MS
        }
      ],
      expired: 0
    })
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'geolocation', decision: 'allow', lastVisitedAt: WEEK0 }
    ])
    expect(h.changes).toEqual([{ permission: 'camera', origin: SITE }])
    expect(h.p.revokedUnused()).toEqual(result.revoked)
    // The site asks again: no decision stands.
    expect(h.p.rules().some((r) => r.permission === 'camera')).toBe(false)
    const file = h.file()
    expect(file.revokedUnused).toEqual(result.revoked)
    expect(file.meta).toEqual({ [`${SITE}|geolocation`]: { lastVisitedAt: WEEK0 } })
  })

  it('takes exactly the 60-day threshold: a stamp 60 days old stays, one older goes', () => {
    const h = service()
    h.clock.now = T0 - UNUSED_PERMISSION_MS
    h.p.set('camera', SITE, 'allow')
    const stamp = coarseVisitTime(h.clock.now)
    // The coarse stamp lies up to a week before the allow; the sweep reads the stamp.
    expect(h.p.sweepUnused(true, stamp + UNUSED_PERMISSION_MS).revoked).toEqual([])
    expect(h.p.sweepUnused(true, stamp + UNUSED_PERMISSION_MS + 1).revoked).toHaveLength(1)
  })

  it('never takes a deny, a default, notifications, a rule without a stamp, one allowed again, or anything outside its reach', () => {
    const h = service(
      JSON.stringify({
        version: 1,
        decisions: {
          [`${SITE}|camera`]: 'deny',
          [`${SITE}|notifications`]: 'allow',
          [`${SITE}|popups`]: 'allow',
          [`${SITE}|midi`]: 'allow',
          [`${SITE}|geolocation`]: 'allow',
          [`*|microphone`]: 'allow',
          [`${OTHER}|camera`]: 'allow'
        },
        meta: {
          // Stale, but the notification review's own; stale but denied; stale but kept; a
          // content row the sweep never reaches.
          [`${SITE}|camera`]: { lastVisitedAt: WEEK0 - 20 * 7 * DAY },
          [`${SITE}|notifications`]: { lastVisitedAt: WEEK0 - 20 * 7 * DAY },
          [`${SITE}|popups`]: { lastVisitedAt: WEEK0 - 20 * 7 * DAY },
          [`${SITE}|geolocation`]: { lastVisitedAt: WEEK0 - 20 * 7 * DAY, keepGranted: true },
          [`*|microphone`]: { lastVisitedAt: WEEK0 - 20 * 7 * DAY },
          // `midi` and the other site's camera: no stamp.
          [`${OTHER}|camera`]: {}
        }
      })
    )
    const before = h.p.rules()
    expect(h.p.sweepUnused(true, T0 + 365 * DAY)).toEqual({ revoked: [], expired: 0 })
    expect(h.p.rules()).toEqual(before)
    expect(h.p.defaultFor('microphone')).toBe('allow')
    expect(h.changes).toEqual([])
    // The load sanitised the meta: only the kept geolocation stamp survived (an allow the sweep
    // can reach); the rest never belonged there.
    expect(h.p.rules().find((r) => r.permission === 'geolocation')).toEqual({
      origin: SITE,
      permission: 'geolocation',
      decision: 'allow',
      lastVisitedAt: WEEK0 - 20 * 7 * DAY,
      keepGranted: true
    })
    for (const rule of h.p.rules())
      if (rule.permission !== 'geolocation') expect(rule).not.toHaveProperty('lastVisitedAt')
  })

  it('merges a second revocation into the site’s record: the permissions join, the clock restarts', () => {
    const h = stale(12)
    // Eight weeks back: its week's stamp is 56–63 days old at T0, within the 60 days.
    h.clock.now = T0 - 8 * 7 * DAY
    h.p.set('geolocation', SITE, 'allow')
    h.clock.now = T0
    expect(h.p.sweepUnused(true, T0).revoked).toEqual([
      { origin: SITE, permissions: ['camera'], revokedAt: T0, expiresAt: T0 + 30 * DAY }
    ])
    const later = T0 + 10 * DAY
    // Ten days on the geolocation stamp is past 60 days: it goes, into the same record.
    const second = h.p.sweepUnused(true, later)
    expect(second.revoked).toEqual([
      {
        origin: SITE,
        permissions: ['camera', 'geolocation'],
        revokedAt: later,
        expiresAt: later + 30 * DAY
      }
    ])
    expect(h.p.revokedUnused()).toHaveLength(1)
  })

  it('lets a record go 30 days after its revocation, at the next sweep, revoking or not', () => {
    const h = stale(10)
    h.p.sweepUnused(true, T0)
    // Kept while `now < expiresAt`; the sweep that finds the moment reached drops it.
    expect(h.p.sweepUnused(false, T0 + REVOKED_PERMISSIONS_KEPT_MS - 1)).toEqual({
      revoked: [],
      expired: 0
    })
    expect(h.p.revokedUnused()).toHaveLength(1)
    expect(h.p.sweepUnused(false, T0 + REVOKED_PERMISSIONS_KEPT_MS)).toEqual({
      revoked: [],
      expired: 1
    })
    expect(h.p.revokedUnused()).toEqual([])
    expect(h.file()).not.toHaveProperty('revokedUnused')
  })

  it('with the setting off (revoke = false) takes nothing and keeps stamping', () => {
    const h = stale(10)
    expect(h.p.sweepUnused(false, T0)).toEqual({ revoked: [], expired: 0 })
    expect(h.p.rules()).toHaveLength(1)
    h.p.onPageVisited(`${SITE}/`)
    expect(h.p.rules()[0]).toMatchObject({ lastVisitedAt: WEEK0 })
  })

  it('lists the revoked sites newest first, then by origin, as copies', () => {
    const h = stale(10)
    h.clock.now = T0 - 10 * 7 * DAY
    h.p.set('microphone', OTHER, 'allow')
    h.p.set('camera', 'https://a.example', 'allow')
    h.clock.now = T0
    h.p.sweepUnused(true, T0)
    const list = h.p.revokedUnused()
    expect(list.map((r) => r.origin)).toEqual(['https://a.example', SITE, OTHER])
    list[0]!.permissions.push('tampered')
    expect(h.p.revokedUnused()[0]!.permissions).toEqual(['camera'])
  })
})

describe('housekeeping of the revoked list', () => {
  const revoked = (): Harness => {
    const h = stale(10)
    h.p.sweepUnused(true, T0)
    h.changes.length = 0
    expect(h.p.revokedUnused()).toHaveLength(1)
    return h
  }

  it('a new answer for the site drops its record: a Settings grant, a remembered prompt answer, a block', () => {
    for (const act of [
      (h: Harness) => h.p.set('camera', SITE, 'allow'),
      (h: Harness) => h.p.remember('geolocation', `${SITE}/map`, 'allow'),
      (h: Harness) => h.p.set('microphone', SITE, 'deny')
    ]) {
      const h = revoked()
      act(h)
      expect(h.p.revokedUnused()).toEqual([])
      expect(h.file()).not.toHaveProperty('revokedUnused')
    }
  })

  it('resetOrigin and forgetRule drop the record too; another site’s change leaves it', () => {
    const a = revoked()
    a.p.set('geolocation', SITE, 'allow')
    a.p.sweepUnused(true, T0) // nothing stale left; the set dropped the record
    expect(a.p.revokedUnused()).toEqual([])

    const b = revoked()
    b.p.set('camera', OTHER, 'allow')
    expect(b.p.revokedUnused()).toHaveLength(1)
    b.p.resetOrigin(SITE)
    expect(b.p.revokedUnused()).toEqual([])

    const c = revoked()
    c.p.set('geolocation', SITE, 'allow')
    expect(c.p.revokedUnused()).toEqual([])
    c.p.sweepUnused(true, T0)
    c.p.set('geolocation', OTHER, 'allow')
    c.clock.now = T0 - 10 * 7 * DAY
    c.p.set('camera', SITE, 'allow')
    c.clock.now = T0
    c.p.sweepUnused(true, T0)
    expect(c.p.revokedUnused()).toHaveLength(1)
    c.p.forgetRule(SITE, 'geolocation')
    expect(c.p.revokedUnused()).toEqual([])
  })

  it('resetSites and reset clear the list with the stamps', () => {
    const h = revoked()
    h.p.set('microphone', OTHER, 'allow')
    h.p.resetSites()
    expect(h.p.revokedUnused()).toEqual([])
    expect(h.p.rules()).toEqual([])
    const file = h.file()
    expect(file).not.toHaveProperty('meta')
    expect(file).not.toHaveProperty('revokedUnused')

    const g = revoked()
    g.p.reset()
    expect(g.p.revokedUnused()).toEqual([])
  })
})

describe('the review’s commands (PS-41)', () => {
  const revoked = (): Harness => {
    const h = stale(10)
    h.clock.now = T0 - 10 * 7 * DAY
    h.p.set('geolocation', SITE, 'allow')
    h.clock.now = T0
    h.p.sweepUnused(true, T0)
    h.changes.length = 0
    return h
  }
  const RECORD: RevokedSitePermissions = {
    origin: SITE,
    permissions: ['camera', 'geolocation'],
    revokedAt: T0,
    expiresAt: T0 + 30 * DAY
  }

  it('regrantRevoked allows every permission of the record again, kept from the sweep, and drops the record', () => {
    const h = revoked()
    h.clock.now = T0 + DAY
    h.p.regrantRevoked(`${SITE}/anything`)
    expect(h.p.rules()).toEqual([
      {
        origin: SITE,
        permission: 'camera',
        decision: 'allow',
        lastVisitedAt: coarseVisitTime(T0 + DAY),
        keepGranted: true
      },
      {
        origin: SITE,
        permission: 'geolocation',
        decision: 'allow',
        lastVisitedAt: coarseVisitTime(T0 + DAY),
        keepGranted: true
      }
    ])
    expect(h.p.revokedUnused()).toEqual([])
    expect(h.changes).toEqual([
      { permission: 'camera', origin: SITE },
      { permission: 'geolocation', origin: SITE }
    ])
    // Kept: a year on, the sweep leaves it alone.
    expect(h.p.sweepUnused(true, T0 + 400 * DAY).revoked).toEqual([])
    expect(h.file().meta).toEqual({
      [`${SITE}|camera`]: { lastVisitedAt: coarseVisitTime(T0 + DAY), keepGranted: true },
      [`${SITE}|geolocation`]: { lastVisitedAt: coarseVisitTime(T0 + DAY), keepGranted: true }
    })
  })

  it('undoRegrantRevoked puts the answers back the way the sweep left them and the record back with its OLD times', () => {
    const h = revoked()
    h.clock.now = T0 + 5 * DAY
    h.p.regrantRevoked(SITE)
    h.changes.length = 0
    h.p.undoRegrantRevoked(SITE)
    expect(h.p.rules()).toEqual([])
    expect(h.p.revokedUnused()).toEqual([RECORD])
    expect(h.changes).toEqual([
      { permission: 'camera', origin: SITE },
      { permission: 'geolocation', origin: SITE }
    ])
    expect(h.file().revokedUnused).toEqual([RECORD])
    // Nothing to undo twice.
    h.changes.length = 0
    h.p.undoRegrantRevoked(SITE)
    expect(h.changes).toEqual([])
  })

  it('a user change to the site after "Allow again" forgets the undo', () => {
    const h = revoked()
    h.p.regrantRevoked(SITE)
    h.p.set('camera', SITE, 'deny')
    h.p.undoRegrantRevoked(SITE)
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'deny' },
      {
        origin: SITE,
        permission: 'geolocation',
        decision: 'allow',
        lastVisitedAt: WEEK0,
        keepGranted: true
      }
    ])
    expect(h.p.revokedUnused()).toEqual([])
  })

  it('regrant of a site without a record, or of a page without a site, does nothing', () => {
    const h = revoked()
    h.p.regrantRevoked(OTHER)
    h.p.regrantRevoked('about:blank')
    expect(h.changes).toEqual([])
    expect(h.p.revokedUnused()).toEqual([RECORD])
  })

  it('acknowledgeRevoked returns the records and clears the list; the permissions stay revoked', () => {
    const h = revoked()
    expect(h.p.acknowledgeRevoked()).toEqual([RECORD])
    expect(h.p.revokedUnused()).toEqual([])
    expect(h.p.rules()).toEqual([])
    expect(h.changes).toEqual([])
    expect(h.file()).not.toHaveProperty('revokedUnused')
    expect(h.p.acknowledgeRevoked()).toEqual([])
  })

  it('restoreRevokedList puts the records back as they were, dropping a malformed one', () => {
    const h = revoked()
    const records = h.p.acknowledgeRevoked()
    h.p.restoreRevokedList([
      ...records,
      {
        origin: 'nonsense',
        permissions: [],
        revokedAt: NaN,
        expiresAt: 1
      } as RevokedSitePermissions
    ])
    expect(h.p.revokedUnused()).toEqual([RECORD])
    expect(h.file().revokedUnused).toEqual([RECORD])
  })

  it('a restore meets a record the sweep made meanwhile: that record’s times stay, the permissions join', () => {
    const h = revoked()
    const records = h.p.acknowledgeRevoked()
    h.clock.now = T0 - 9 * 7 * DAY
    h.p.set('microphone', SITE, 'allow')
    h.clock.now = T0 + 2 * DAY
    h.p.sweepUnused(true, T0 + 2 * DAY)
    h.p.restoreRevokedList(records)
    expect(h.p.revokedUnused()).toEqual([
      {
        origin: SITE,
        permissions: ['microphone', 'camera', 'geolocation'],
        revokedAt: T0 + 2 * DAY,
        expiresAt: T0 + 2 * DAY + 30 * DAY
      }
    ])
  })
})

describe('permissions.json from before the clock, and a damaged one', () => {
  it('a v1 file without meta or revokedUnused loads as it did', () => {
    const h = service(
      JSON.stringify({
        version: 1,
        decisions: { [`${SITE}|camera`]: 'allow', [`${SITE}|popups`]: 'deny' },
        devices: [],
        noticed: []
      })
    )
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'allow' },
      { origin: SITE, permission: 'popups', decision: 'deny' }
    ])
    expect(h.p.revokedUnused()).toEqual([])
    expect(h.io.writes).toEqual([])
  })

  it('reads the two fields back, sanitised: a stamp floors to the week, junk goes, records merge per site', () => {
    const h = service(
      JSON.stringify({
        version: 1,
        decisions: { [`${SITE}|camera`]: 'allow', [`${OTHER}|midi`]: 'allow' },
        meta: {
          [`${SITE}|camera`]: { lastVisitedAt: WEEK0 + 12345, keepGranted: 'yes' },
          [`${OTHER}|midi`]: { lastVisitedAt: -5 },
          [`${OTHER}|camera`]: { lastVisitedAt: WEEK0 },
          garbage: 7
        },
        revokedUnused: [
          { origin: SITE, permissions: ['camera'], revokedAt: 100, expiresAt: 200 },
          { origin: SITE, permissions: ['midi', 'camera'], revokedAt: 150, expiresAt: 250 },
          { origin: OTHER, permissions: 'camera', revokedAt: 1, expiresAt: 2 },
          { origin: 'https://x.example', permissions: ['camera'], revokedAt: 'now', expiresAt: 2 },
          null,
          'nonsense'
        ]
      })
    )
    expect(h.p.rules()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'allow', lastVisitedAt: WEEK0 },
      { origin: OTHER, permission: 'midi', decision: 'allow' }
    ])
    expect(h.p.revokedUnused()).toEqual([
      { origin: SITE, permissions: ['camera', 'midi'], revokedAt: 150, expiresAt: 250 }
    ])
  })

  it('writes neither field while it has nothing to say', () => {
    const h = service()
    h.p.set('popups', SITE, 'deny')
    const file = h.file()
    expect(file).not.toHaveProperty('meta')
    expect(file).not.toHaveProperty('revokedUnused')
  })
})

describe('the setting’s sync class', () => {
  it('autoRevokeUnusedPermissions defaults on and travels with the profile’s settings (not device-local)', () => {
    expect(DEFAULT_SETTINGS.autoRevokeUnusedPermissions).toBe(true)
    expect(DEVICE_LOCAL_SETTINGS).not.toContain('autoRevokeUnusedPermissions')
  })
})

describe('coarseVisitTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('floors to whole weeks since the epoch and is stable across a week', () => {
    expect(VISIT_STAMP_PRECISION_MS).toBe(7 * DAY)
    expect(coarseVisitTime(0)).toBe(0)
    expect(coarseVisitTime(7 * DAY - 1)).toBe(0)
    expect(coarseVisitTime(7 * DAY)).toBe(7 * DAY)
    // Every moment of the stamp's week reads the same stamp; the next week's first moment does not.
    const weekStart = WEEK0
    expect(coarseVisitTime(weekStart)).toBe(weekStart)
    expect(coarseVisitTime(weekStart + 7 * DAY - 1)).toBe(weekStart)
    expect(coarseVisitTime(weekStart + 7 * DAY)).toBe(weekStart + 7 * DAY)
    vi.setSystemTime(T0)
    expect(coarseVisitTime(Date.now())).toBe(WEEK0)
  })
})

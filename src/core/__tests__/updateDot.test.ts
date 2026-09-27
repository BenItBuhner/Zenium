import { describe, expect, it } from 'vitest'
import { emptyUpdateStatus, type UpdatePhase, type UpdateStatus } from '../../shared/updates'
import {
  emptyUpdateDotRecord,
  markUpdateMenuOpened,
  sanitizeUpdateDotRecord,
  updateDotShows,
  type UpdateDotRecord
} from '../updateDot'

/*
 * The update dot's per-version 'seen' record (TB-12): the dot shows while an update is downloaded
 * and waiting (`ready`) and the app menu has not been opened for its version; the menu's open
 * marks the version seen; another version's `ready` shows the dot again – Chrome Android's ⋮
 * badge, cleared on the menu's first open and back on a state change.
 */

const TARGET = { os: 'android', arch: 'arm64', kind: 'apk' } as const

function status(phase: UpdatePhase, version: string | null = '2.0.0'): UpdateStatus {
  const base = emptyUpdateStatus('1.2.3', TARGET)
  return {
    ...base,
    phase,
    release:
      version === null
        ? null
        : {
            version,
            tag: `v${version}`,
            prerelease: false,
            publishedAt: '2026-09-24T09:00:00Z',
            releaseUrl: `https://github.com/BenItBuhner/Zenium/releases/tag/v${version}`,
            notesUrl: `https://github.com/BenItBuhner/Zenium/releases/tag/v${version}`,
            asset: null
          },
    downloadedPath: phase === 'ready' ? `/cache/updates/zenium-${version}.apk` : null
  }
}

describe('the update dot and its per-version seen record (TB-12)', () => {
  it('shows for a downloaded and waiting update alone – nothing found, downloading or idle', () => {
    const fresh = emptyUpdateDotRecord()
    expect(updateDotShows(status('ready'), fresh)).toBe(true)
    for (const phase of ['idle', 'checking', 'available', 'downloading', 'error'] as UpdatePhase[])
      expect(updateDotShows(status(phase), fresh), phase).toBe(false)
  })

  it('clears once the menu has been opened for the version, and returns for another version', () => {
    const ready = status('ready')
    const seen = markUpdateMenuOpened(ready, emptyUpdateDotRecord())
    expect(seen).toEqual({ seenVersion: '2.0.0' })
    expect(updateDotShows(ready, seen)).toBe(false)
    // A state change: a newer version downloaded – the dot again, by construction.
    expect(updateDotShows(status('ready', '2.1.0'), seen)).toBe(true)
    // An older one waiting (a channel change): not the seen version, the dot too.
    expect(updateDotShows(status('ready', '1.9.0'), seen)).toBe(true)
    // The newer one seen in turn.
    const seenAgain = markUpdateMenuOpened(status('ready', '2.1.0'), seen)
    expect(seenAgain).toEqual({ seenVersion: '2.1.0' })
    expect(updateDotShows(status('ready', '2.1.0'), seenAgain)).toBe(false)
  })

  /*
   * 'Returns on a state change' means a NEWER VERSION reaching `ready` – the comparison is the
   * version alone, `status.release.version !== record.seenVersion`; no phase and no time enters
   * it. The same version leaving `ready` (a failed install, a re-check that downloads again, a
   * dismissal) and coming back reads the same record and stays off.
   */
  describe('returns on a state change – a different version, never the same one again', () => {
    const X = '2.0.0'
    const Y = '2.1.0'

    it('(1) seen at X, X leaves `ready` and returns to `ready`: stays OFF', () => {
      const seenX = markUpdateMenuOpened(status('ready', X), emptyUpdateDotRecord())
      expect(seenX).toEqual({ seenVersion: X })
      // A failed install, then the same release found and downloaded again.
      for (const phase of ['error', 'checking', 'available', 'downloading'] as UpdatePhase[])
        expect(updateDotShows(status(phase, X), seenX), phase).toBe(false)
      expect(updateDotShows(status('ready', X), seenX)).toBe(false)
      // The cycle's opens change nothing either: the same record, the same object.
      expect(markUpdateMenuOpened(status('ready', X), seenX)).toBe(seenX)
      // Once more round, as many times as it happens.
      expect(updateDotShows(status('downloading', X), seenX)).toBe(false)
      expect(updateDotShows(status('ready', X), seenX)).toBe(false)
    })

    it('(2) seen at X, Y ≠ X reaches `ready`: ON', () => {
      const seenX = markUpdateMenuOpened(status('ready', X), emptyUpdateDotRecord())
      // Y found and downloading: nothing yet – the dot is `ready`'s alone.
      expect(updateDotShows(status('available', Y), seenX)).toBe(false)
      expect(updateDotShows(status('downloading', Y), seenX)).toBe(false)
      // Y downloaded and waiting: the dot returns.
      expect(updateDotShows(status('ready', Y), seenX)).toBe(true)
    })

    it('(3) seen at Y, X reaches `ready` again – an older version, a rollback: ON, because it differs', () => {
      const seenY = markUpdateMenuOpened(status('ready', Y), emptyUpdateDotRecord())
      expect(seenY).toEqual({ seenVersion: Y })
      // The comparison is inequality, not order: an older version waiting is not the seen one.
      expect(updateDotShows(status('ready', X), seenY)).toBe(true)
      // Opened for X in turn: X seen, Y – the newer one – would light it again.
      const seenXAgain = markUpdateMenuOpened(status('ready', X), seenY)
      expect(seenXAgain).toEqual({ seenVersion: X })
      expect(updateDotShows(status('ready', X), seenXAgain)).toBe(false)
      expect(updateDotShows(status('ready', Y), seenXAgain)).toBe(true)
    })

    it('keeps the version alone in the record: no phase, no time to compare by', () => {
      const seen = markUpdateMenuOpened(status('ready', X), emptyUpdateDotRecord())
      expect(Object.keys(seen)).toEqual(['seenVersion'])
      expect(Object.keys(emptyUpdateDotRecord())).toEqual(['seenVersion'])
      expect(
        Object.keys(sanitizeUpdateDotRecord({ seenVersion: X, seenAt: 1, phase: 'ready' }))
      ).toEqual(['seenVersion'])
      // Two statuses that differ in everything but the version read the same record alike.
      const a = { ...status('ready', X), lastCheckedAt: 1, downloadedPath: '/a.apk' }
      const b = { ...status('ready', X), lastCheckedAt: 2, downloadedPath: '/b.apk' }
      expect(updateDotShows(a, seen)).toBe(updateDotShows(b, seen))
    })
  })

  it('returns the record it was given – the same object – when there is nothing new to see', () => {
    const fresh = emptyUpdateDotRecord()
    for (const phase of ['idle', 'available', 'downloading'] as UpdatePhase[])
      expect(markUpdateMenuOpened(status(phase), fresh), phase).toBe(fresh)
    const seen: UpdateDotRecord = { seenVersion: '2.0.0' }
    expect(markUpdateMenuOpened(status('ready'), seen)).toBe(seen)
  })

  it('fails open on a `ready` without a release: the plain dot, nothing recorded', () => {
    const fresh = emptyUpdateDotRecord()
    expect(updateDotShows(status('ready', null), fresh)).toBe(true)
    expect(markUpdateMenuOpened(status('ready', null), fresh)).toBe(fresh)
    // A seen version does not hide a release-less ready either.
    expect(updateDotShows(status('ready', null), { seenVersion: '2.0.0' })).toBe(true)
    // The functions read the phase and the release alone: a partial status is enough.
    expect(updateDotShows({ phase: 'ready', release: null }, fresh)).toBe(true)
    expect(updateDotShows({ phase: 'available', release: null }, fresh)).toBe(false)
  })

  it('reads a persisted record back, or an empty one for anything that is not a record', () => {
    expect(sanitizeUpdateDotRecord({ seenVersion: '2.0.0' })).toEqual({ seenVersion: '2.0.0' })
    expect(sanitizeUpdateDotRecord({ seenVersion: '2.0.0', extra: 1 })).toEqual({
      seenVersion: '2.0.0'
    })
    for (const raw of [
      undefined,
      null,
      '2.0.0',
      7,
      [],
      {},
      { seenVersion: 2 },
      { seenVersion: '' }
    ])
      expect(sanitizeUpdateDotRecord(raw), JSON.stringify(raw)).toEqual({ seenVersion: null })
  })
})

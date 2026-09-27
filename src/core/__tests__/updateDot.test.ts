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

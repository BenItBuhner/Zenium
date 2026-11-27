import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  MAX_CONCURRENCY_PROCESS_LIMIT,
  isMaxConcurrency,
  maxConcurrencyPatch
} from '../concurrency'
import {
  EARLY_RELAUNCH_MARK,
  deriveStartupProfile,
  earlyRelaunchArgs,
  startupSwitches
} from '../switches'

const base = DEFAULT_SETTINGS.resources.process

describe('max concurrency', () => {
  it('is off by default', () => {
    expect(isMaxConcurrency(base)).toBe(false)
  })

  it('turns on relaxed isolation with a small process limit, and off again', () => {
    const on = { ...base, ...maxConcurrencyPatch(true) }
    expect(isMaxConcurrency(on)).toBe(true)
    expect(on.rendererProcessLimit).toBe(MAX_CONCURRENCY_PROCESS_LIMIT)
    const off = { ...on, ...maxConcurrencyPatch(false) }
    expect(isMaxConcurrency(off)).toBe(false)
    expect(off).toEqual(base)
  })

  it('is only on when both parts are', () => {
    expect(isMaxConcurrency({ ...base, siteIsolation: 'relaxed' })).toBe(false)
    expect(isMaxConcurrency({ ...base, rendererProcessLimit: 6 })).toBe(false)
  })

  it('reaches the startup switches', () => {
    const settings = {
      ...DEFAULT_SETTINGS.resources,
      process: { ...base, ...maxConcurrencyPatch(true) }
    }
    const names = startupSwitches(deriveStartupProfile(settings), []).map(
      (s) => `${s.name}${s.value === undefined ? '' : `=${s.value}`}`
    )
    expect(names).toContain('disable-site-isolation-trials')
    expect(names).toContain(`renderer-process-limit=${MAX_CONCURRENCY_PROCESS_LIMIT}`)
  })
})

describe('early switches', () => {
  const limit = [{ name: 'renderer-process-limit', value: '6' }]

  it('asks for a relaunch when the limit is not on the real command line', () => {
    expect(earlyRelaunchArgs(limit, ['.', 'https://a.test'])).toEqual([
      '.',
      'https://a.test',
      '--renderer-process-limit=6',
      EARLY_RELAUNCH_MARK
    ])
  })

  it('does not relaunch when the command line has it, or when nothing early is wanted', () => {
    expect(earlyRelaunchArgs(limit, ['.', '--renderer-process-limit=6'])).toBeNull()
    expect(earlyRelaunchArgs([{ name: 'disable-site-isolation-trials' }], ['.'])).toBeNull()
    expect(earlyRelaunchArgs([], ['.'])).toBeNull()
  })

  it('replaces a stale limit and never relaunches twice', () => {
    expect(earlyRelaunchArgs(limit, ['--renderer-process-limit=4'])).toEqual([
      '--renderer-process-limit=6',
      EARLY_RELAUNCH_MARK
    ])
    expect(earlyRelaunchArgs(limit, ['.', EARLY_RELAUNCH_MARK])).toBeNull()
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FAILURE_KINDS,
  classifyFailures,
  formatFailure,
  matchesEntry,
  parseKnownFailures
} from './known-failures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const linux = { platform: 'linux', arch: 'x64', label: 'unpacked' }
const winArm = { platform: 'win32', arch: 'arm64', label: 'installed' }

const doc = {
  entries: [
    {
      id: 'BUG-1',
      kind: 'main-exception',
      pattern: 'ElectronTabView\\.onDestroyed',
      fixedBy: 'branch-a'
    },
    {
      id: 'BUG-2',
      kind: ['view-console-error', 'preload-error'],
      pattern:
        "sandboxed_renderer\\.bundle\\.js script failed to run|Cannot destructure property 'preloadScripts'"
    },
    {
      id: 'BUG-3',
      kind: 'install',
      pattern: 'zenium\\.exe',
      platforms: ['win32'],
      archs: ['arm64']
    }
  ]
}

describe('parseKnownFailures', () => {
  it('compiles patterns and keeps filters', () => {
    const entries = parseKnownFailures(doc)
    expect(entries.map((e) => e.id)).toEqual(['BUG-1', 'BUG-2', 'BUG-3'])
    expect(entries[0].kinds).toEqual(['main-exception'])
    expect(
      entries[0].regex.test('TypeError: x\n    at ElectronTabView.onDestroyed (views.js:1)')
    ).toBe(true)
    expect(entries[1].kinds).toEqual(['view-console-error', 'preload-error'])
    expect(entries[2].platforms).toEqual(['win32'])
    expect(entries[2].archs).toEqual(['arm64'])
  })

  it('accepts an empty allowlist', () => {
    expect(parseKnownFailures({ entries: [] })).toEqual([])
  })

  it('rejects malformed documents', () => {
    expect(() => parseKnownFailures(null)).toThrow(/entries/)
    expect(() => parseKnownFailures({ entries: [{ kind: 'step', pattern: 'x' }] })).toThrow(/id/)
    expect(() =>
      parseKnownFailures({ entries: [{ id: 'A', kind: 'nope', pattern: 'x' }] })
    ).toThrow(/unknown kind/)
    expect(() => parseKnownFailures({ entries: [{ id: 'A', kind: 'step' }] })).toThrow(/pattern/)
    expect(() =>
      parseKnownFailures({ entries: [{ id: 'A', kind: 'step', pattern: '(' }] })
    ).toThrow(/does not compile/)
    expect(() =>
      parseKnownFailures({
        entries: [
          { id: 'A', kind: 'step', pattern: 'x' },
          { id: 'A', kind: 'step', pattern: 'y' }
        ]
      })
    ).toThrow(/duplicates/)
    expect(() =>
      parseKnownFailures({ entries: [{ id: 'A', kind: 'step', pattern: 'x', platforms: 'win32' }] })
    ).toThrow(/array of strings/)
  })
})

describe('matchesEntry', () => {
  const [exception, preload, install] = parseKnownFailures(doc)

  it('matches on kind and message', () => {
    const f = {
      kind: 'main-exception',
      message: 'TypeError: Cannot read properties of null\n    at ElectronTabView.onDestroyed'
    }
    expect(matchesEntry(exception, f, linux)).toBe(true)
    expect(matchesEntry(exception, { ...f, kind: 'chrome-pageerror' }, linux)).toBe(false)
    expect(matchesEntry(exception, { kind: 'main-exception', message: 'other' }, linux)).toBe(false)
  })

  it('also searches the source field', () => {
    const f = {
      kind: 'view-console-error',
      message: 'Unable to load preload script',
      source: 'node:electron/js2c/sandboxed_renderer.bundle.js script failed to run'
    }
    expect(matchesEntry(preload, f, linux)).toBe(true)
  })

  it('honours platform and arch filters', () => {
    const f = { kind: 'install', message: 'installed executable missing: C:\\x\\zenium.exe' }
    expect(matchesEntry(install, f, winArm)).toBe(true)
    expect(matchesEntry(install, f, { ...winArm, arch: 'x64' })).toBe(false)
    expect(matchesEntry(install, f, linux)).toBe(false)
  })

  it('honours label, scenario and step filters', () => {
    const [entry] = parseKnownFailures({
      entries: [
        {
          id: 'X',
          kind: 'step',
          pattern: 'did not exit',
          labels: ['installed'],
          scenarios: ['boot'],
          steps: ['quit']
        }
      ]
    })
    const f = { kind: 'step', scenario: 'boot', step: 'quit', message: 'app did not exit' }
    expect(matchesEntry(entry, f, winArm)).toBe(true)
    expect(matchesEntry(entry, f, { ...winArm, label: 'unpacked' })).toBe(false)
    expect(matchesEntry(entry, { ...f, scenario: 'restore' }, winArm)).toBe(false)
    expect(matchesEntry(entry, { ...f, step: 'launch' }, winArm)).toBe(false)
  })
})

describe('classifyFailures', () => {
  const entries = parseKnownFailures(doc)

  it('separates known from unexpected and lists unused entries', () => {
    const failures = [
      { kind: 'main-exception', message: 'at ElectronTabView.onDestroyed' },
      { kind: 'view-console-error', message: "Cannot destructure property 'preloadScripts'" },
      { kind: 'step', scenario: 'boot', step: 'zoom', message: 'zoom factor stayed 1' }
    ]
    const verdict = classifyFailures(failures, entries, linux)
    expect(verdict.ok).toBe(false)
    expect(verdict.known.map((k) => k.id)).toEqual(['BUG-1', 'BUG-2'])
    expect(verdict.unexpected).toEqual([failures[2]])
    expect(verdict.unused).toEqual(['BUG-3'])
  })

  it('is ok with only known failures or none at all', () => {
    expect(classifyFailures([], entries, linux)).toMatchObject({ ok: true, unexpected: [] })
    const only = [{ kind: 'install', message: 'zenium.exe missing' }]
    expect(classifyFailures(only, entries, winArm)).toMatchObject({
      ok: true,
      known: [{ id: 'BUG-3' }]
    })
  })
})

describe('formatFailure', () => {
  it('prints kind, location and the first message line', () => {
    const f = { kind: 'step', scenario: 'boot', step: 'zoom', message: 'first line\nsecond' }
    expect(formatFailure(f)).toBe('step [boot/zoom]: first line')
    expect(formatFailure({ kind: 'harness', message: 'x'.repeat(300) }, 10)).toBe(
      `harness: ${'x'.repeat(10)}`
    )
  })
  it('names the screen grabbed as the step failed', () => {
    const f = {
      kind: 'step',
      scenario: 'boot',
      step: 'onboarding',
      message: 'not painted',
      screen: '02-boot-onboarding-failed.png'
    }
    expect(formatFailure(f)).toBe(
      'step [boot/onboarding]: not painted (screen: 02-boot-onboarding-failed.png)'
    )
  })
})

describe('known-failures.json', () => {
  it('parses and only names kinds the harness emits', () => {
    const file = join(here, 'known-failures.json')
    const entries = parseKnownFailures(JSON.parse(readFileSync(file, 'utf8')))
    for (const e of entries) for (const k of e.kinds) expect(FAILURE_KINDS).toContain(k)
  })
})

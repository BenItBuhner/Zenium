import { describe, expect, it } from 'vitest'
import { PERSONAS, report, type SimResult } from '../sim'

/**
 * The simulated users (`sim.ts`) hold the Auto policy to what people would feel. Set
 * ZEN_SIM_REPORT=1 to print the whole table as Markdown.
 */
const { results, markdown } = report(1)
if (process.env.ZEN_SIM_REPORT) console.log(`\n${markdown}\n`)

const get = (persona: string, policy: string): SimResult => {
  const r = results.find((x) => x.persona === persona && x.policy === policy)
  if (!r) throw new Error(`no result for ${persona} / ${policy}`)
  return r
}

describe('simulated users', () => {
  for (const { name } of PERSONAS) {
    describe(name, () => {
      const auto = get(name, 'auto')
      const fixed = get(name, 'fixed timers (old default)')
      const naive = get(name, 'auto, not learning')

      it('almost never makes them reload a tab they left under an hour ago', () => {
        expect(auto.quickReloads).toBeLessThanOrEqual(2)
      })

      it('makes them reload fewer tabs than the old fixed timers', () => {
        expect(auto.reloads).toBeLessThan(fixed.reloads)
      })

      it('never stops audio and never leaves the machine shorter of memory than before', () => {
        expect(auto.audioStopped).toBe(0)
        expect(auto.shortMinutes).toBeLessThanOrEqual(fixed.shortMinutes)
      })

      it('uses less memory once it has learned their habits', () => {
        expect(auto.avgMb).toBeLessThanOrEqual(naive.avgMb)
      })
    })
  }

  it('keeps everything live for someone using 30 tabs at once on a big machine', () => {
    const auto = get('dozens-active', 'auto')
    const all = get('dozens-active', 'never sleep')
    expect(auto.avgMb).toBeGreaterThan(all.avgMb * 0.9)
  })

  it('sleeps hard for a hoarder and a researcher who rarely go back', () => {
    for (const name of ['tab-hoarder', 'researcher']) {
      expect(get(name, 'auto').avgMb).toBeLessThan(get(name, 'never sleep').avgMb * 0.5)
    }
  })

  it('gives the memory back when a game needs it', () => {
    expect(get('gamer', 'auto').shortMinutes).toBe(0)
    expect(get('gamer', 'never sleep').shortMinutes).toBeGreaterThan(0)
  })
})

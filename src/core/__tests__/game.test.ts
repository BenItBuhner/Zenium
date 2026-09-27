import { describe, expect, it } from 'vitest'
import { GameService } from '../game'
import type { Browser } from '../browser'
import { gameBestScript } from '../../shared/game/bridge'

/**
 * `GameService` over a stand-in browser: the settings object with the best, a commit counter,
 * one tab (`t1`) whose view records the scripts run on its document, and one (`gone`) without a
 * view. The relay's messages arrive as `handlePageMessage` hands them over: already parsed, not
 * yet trusted.
 */
function harness(
  best: unknown = 0,
  run: (code: string) => Promise<unknown> = () => Promise.resolve()
): {
  service: GameService
  scripts: string[]
  state: { settings: { gameBestScore: unknown }; commits: number }
} {
  const scripts: string[] = []
  const state = {
    settings: { gameBestScore: best } as { gameBestScore: unknown },
    commits: 0,
    commit(): void {
      state.commits++
    }
  }
  const view = {
    executeJavaScript: (code: string): Promise<unknown> => {
      scripts.push(code)
      return run(code)
    }
  }
  const browser = {
    state,
    tabs: { view: (id: string) => (id === 't1' ? view : null) }
  } as unknown as Browser
  return { service: new GameService(browser), scripts, state }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe("GameService: Roll's best, the profile's and synced (ERR-03, §9.17 (i))", () => {
  it("answers the ask with the standing best on the tab's document, and changes nothing", () => {
    const { service, scripts, state } = harness(123)
    service.handleMessage('t1', { ask: 'best' })
    expect(scripts).toEqual([gameBestScript(123)])
    expect(scripts[0]).toBe('window.zenGameBest&&window.zenGameBest(123)')
    expect(state.commits).toBe(0)
    expect(service.best()).toBe(123)
  })

  it('raises the best on a report of a higher run, commits, and answers with the new number', () => {
    const { service, scripts, state } = harness(123)
    service.handleMessage('t1', { best: 400 })
    expect(state.settings.gameBestScore).toBe(400)
    expect(state.commits).toBe(1)
    expect(scripts).toEqual([gameBestScript(400)])
  })

  it('keeps the best on a report of a lesser run, and answers with the standing one', () => {
    const { service, scripts, state } = harness(500)
    service.handleMessage('t1', { best: 400 })
    expect(state.settings.gameBestScore).toBe(500)
    expect(state.commits).toBe(0)
    expect(scripts).toEqual([gameBestScript(500)])
    service.handleMessage('t1', { best: 500 })
    expect(state.commits).toBe(0)
  })

  it('reads a report as a whole number in the meter’s range, and a settings value gone wrong as 0', () => {
    const { service, scripts, state } = harness('junk')
    expect(service.best()).toBe(0)
    service.handleMessage('t1', { best: 1e9 })
    expect(state.settings.gameBestScore).toBe(99999)
    service.handleMessage('t1', { best: 77.9 })
    expect(state.settings.gameBestScore).toBe(99999)
    expect(scripts).toEqual([gameBestScript(99999), gameBestScript(99999)])
    const fresh = harness(10)
    fresh.service.handleMessage('t1', { best: 42.9 })
    expect(fresh.state.settings.gameBestScore).toBe(42)
  })

  it('ignores what is neither ask nor report – nothing raised, nothing answered', () => {
    const { service, scripts, state } = harness(10)
    for (const junk of [
      null,
      undefined,
      'best',
      42,
      {},
      { ask: 'all' },
      { best: '900' },
      { best: Number.NaN },
      { action: 'back' }
    ])
      service.handleMessage('t1', junk)
    expect(scripts).toEqual([])
    expect(state.commits).toBe(0)
    expect(state.settings.gameBestScore).toBe(10)
  })

  it('keeps a raise from a tab whose view is gone, and answers nothing there', () => {
    const { service, scripts, state } = harness(10)
    service.handleMessage('gone', { best: 90 })
    expect(state.settings.gameBestScore).toBe(90)
    expect(state.commits).toBe(1)
    expect(scripts).toEqual([])
  })

  it('shrugs off a document that refuses the script', async () => {
    const { service, scripts } = harness(10, () => Promise.reject(new Error('Script failed')))
    service.handleMessage('t1', { ask: 'best' })
    expect(scripts).toHaveLength(1)
    await tick()
  })

  it('raise() is the max: true when the number rose, false otherwise, never lower', () => {
    const { service, state } = harness(100)
    expect(service.raise(99)).toBe(false)
    expect(service.raise(100)).toBe(false)
    expect(service.raise(101)).toBe(true)
    expect(state.settings.gameBestScore).toBe(101)
    expect(service.raise(Number.NaN)).toBe(false)
    expect(service.raise(-1)).toBe(false)
    expect(state.commits).toBe(1)
  })

  it('raiseAfterApply writes this device’s higher best back a macrotask later, and skips 0', async () => {
    const { service, state } = harness(300)
    service.raiseAfterApply(500)
    expect(state.settings.gameBestScore).toBe(300)
    await tick()
    expect(state.settings.gameBestScore).toBe(500)
    expect(state.commits).toBe(1)
    service.raiseAfterApply(0)
    service.raiseAfterApply(400)
    await tick()
    expect(state.settings.gameBestScore).toBe(500)
    expect(state.commits).toBe(1)
  })
})

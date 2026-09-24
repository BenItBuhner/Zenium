import { describe, expect, it } from 'vitest'
import { relayServedObservation, selects } from '../relaySelection'

/**
 * The relay selection's truth table (blocking-rule-interface.md 7.10): the five facts and the
 * answer. The same rows, in the same order, with the same answers, are pinned in
 * `android/app/src/test/kotlin/app/zen/chromium/blocking/BlockingTest.kt` – the engine chooses
 * with the Kotlin twin, the runtime drops the relay's page-script observations with this one.
 */
const table: Array<
  [
    name: string,
    allowed: boolean,
    mainFrame: boolean,
    method: string,
    hasRange: boolean,
    hasOrigin: boolean,
    relayed: boolean
  ]
> = [
  ['element same-origin', true, false, 'GET', true, false, true],
  ['element cross-origin no-cors', true, false, 'GET', true, false, true],
  [
    'element crossorigin (the recorded gap: Origin goes with it)',
    true,
    false,
    'GET',
    true,
    true,
    false
  ],
  ['fetch same-origin, no Range', true, false, 'GET', false, false, false],
  [
    'fetch same-origin with Range (a range-reading script: the recorded overlap)',
    true,
    false,
    'GET',
    true,
    false,
    true
  ],
  ['fetch cross-origin with Range', true, false, 'GET', true, true, false],
  ['XHR cross-origin', true, false, 'GET', false, true, false],
  ['main frame', true, true, 'GET', true, false, false],
  ['a blocked request', false, false, 'GET', true, false, false],
  ['a POST with Range', true, false, 'POST', true, false, false],
  ['a HEAD with Range', true, false, 'HEAD', true, false, false]
]

describe('the relay selection (blocking-rule-interface.md 7.2 as 7.10 amends it)', () => {
  it('holds the truth table pinned in BlockingTest.kt, row for row', () => {
    for (const [name, allowed, mainFrame, method, hasRange, hasOrigin, relayed] of table)
      expect(selects(allowed, mainFrame, method, hasRange, hasOrigin), name).toBe(relayed)
    expect(table).toHaveLength(11)
  })
  it("reads a page script's observation as allowed and no document: the Range header stands for hasRange, crossOrigin for hasOrigin", () => {
    const observation = (
      over: Partial<Parameters<typeof relayServedObservation>[0]>
    ): Parameters<typeof relayServedObservation>[0] => ({
      tabId: 't1',
      url: 'https://news.example/clip.mp4',
      method: 'GET',
      range: 'bytes=0-',
      crossOrigin: false,
      ...over
    })
    // A same-origin ranged GET a script made: the relay served it (the recorded overlap).
    expect(relayServedObservation(observation({}))).toBe(true)
    expect(relayServedObservation(observation({ range: 'bytes=1024-2047' }))).toBe(true)
    // No Range: the page script's, as every ordinary fetch / XHR is.
    expect(relayServedObservation(observation({ range: null }))).toBe(false)
    // Cross-origin: Origin went with it, the relay declined.
    expect(
      relayServedObservation(
        observation({ url: 'https://cdn.example/clip.mp4', crossOrigin: true })
      )
    ).toBe(false)
    // Not a GET.
    expect(relayServedObservation(observation({ method: 'POST' }))).toBe(false)
    expect(relayServedObservation(observation({ method: 'HEAD' }))).toBe(false)
    // The tab and the URL do not enter the choice.
    expect(
      relayServedObservation(observation({ tabId: null, url: 'https://news.example/x' }))
    ).toBe(true)
  })
})

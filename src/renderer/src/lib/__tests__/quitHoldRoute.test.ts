import { describe, expect, it } from 'vitest'
import type { QuitHoldState, Tab } from '@shared/types'
import { CRASH_ERROR_CODE } from '@shared/zenPages'
import { holdCoversPage, pageCanPaint } from '../quitHoldRoute'

/*
 * Where "Hold ⌘Q to quit" is drawn over a page that cannot paint it (the design lead's C4 on
 * #486): the page script's route needs a renderer that is there and answering; without one the
 * chrome's twin takes its position, so a hold never quits without its notice – and over a hung
 * page the view gives way to its picture for the hold, so the twin is seen over a frame the
 * hung renderer keeps painted.
 */

const page = { url: 'https://example.com/a', errorCode: null as number | null }

describe('pageCanPaint', () => {
  it('a live page paints its own notice', () => {
    expect(pageCanPaint(page)).toBe(true)
    expect(pageCanPaint({ ...page, errorCode: 404 })).toBe(true)
  })

  it('a page whose renderer is gone cannot: the crash mark on a tab whose address is still the page’s own – the crash page has not committed', () => {
    expect(pageCanPaint({ ...page, errorCode: CRASH_ERROR_CODE })).toBe(false)
  })

  it('the crash page, once committed, paints as any page does (its page script is live in a fresh renderer)', () => {
    expect(
      pageCanPaint({
        url: 'zen://error?code=-1&description=RESULT_CODE_HUNG&url=https%3A%2F%2Fexample.com%2Fa',
        errorCode: CRASH_ERROR_CODE
      })
    ).toBe(true)
  })

  it('a hung page cannot: the hang monitor’s mark says its renderer answers nothing', () => {
    expect(pageCanPaint({ ...page, unresponsive: true })).toBe(false)
    // The monitor sets its own reading with the prompt's mark (`Tabs.onUnresponsive`).
    expect(pageCanPaint({ ...page, unresponsive: true, hung: true })).toBe(false)
  })

  it('a hung page after the prompt’s Wait cannot either: Wait dismisses the prompt (its mark goes) and un-hangs nothing, so the monitor’s own reading stands until the page answers again', () => {
    // `Tabs.waitUnresponsive` deletes `unresponsive` alone; `hung` stands (C4 on #486: a hold
    // here quit at 1.5 s with nothing shown until the next hang report).
    expect(pageCanPaint({ ...page, hung: true })).toBe(false)
    // `Tabs.onResponsive`: both marks go, and the page paints its own notice again.
    expect(pageCanPaint({ ...page, hung: undefined, unresponsive: undefined })).toBe(true)
  })
})

describe('holdCoversPage', () => {
  const hold: QuitHoldState = { startedAt: 50_000, durationMs: 1500, chord: '⌘Q' }

  it('a hold over a hung page asks the view to give way to its picture – under the prompt, and after its Wait', () => {
    const underPrompt: Pick<Tab, 'hung' | 'unresponsive' | 'discarded'> = {
      hung: true,
      unresponsive: true,
      discarded: false
    }
    expect(holdCoversPage(hold, underPrompt)).toBe(true)
    expect(holdCoversPage(hold, { hung: true, discarded: false })).toBe(true)
  })

  it('not without a hold, not over a live page (the view stays: hiding it would drop the key up), not over a sleeping one (no renderer, no frame to cover), not over an empty frame', () => {
    expect(holdCoversPage(null, { hung: true, discarded: false })).toBe(false)
    expect(holdCoversPage(hold, { discarded: false })).toBe(false)
    expect(holdCoversPage(hold, { hung: true, discarded: true })).toBe(false)
    expect(holdCoversPage(hold, null)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { CRASH_ERROR_CODE } from '@shared/zenPages'
import { pageCanPaint } from '../quitHoldRoute'

/*
 * Where "Hold ⌘Q to quit" is drawn over a page that cannot paint it (the design lead's C4 on
 * #486): the page script's route needs a renderer that is there and answering; without one the
 * chrome's twin takes its position, so a hold never quits without its notice.
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
  })
})

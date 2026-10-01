// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Platform, Tab } from '@shared/types'
import {
  CHROME_PAGE_CAPTURE_SETTLE_MS,
  chromePageCaptureDue,
  resetChromePageCaptures,
  scheduleChromePageCapture,
  useChromePageCapture
} from '../chromePageCapture'
import { captureThumbnail } from '../thumbnails'

vi.mock('../thumbnails', () => ({ captureThumbnail: vi.fn() }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * The Settings tab's card picture is the chrome's to ask for (lib/chromePageCapture.ts): a page
 * tab has no view whose hide takes one. While the page is shown on a host that pictures its
 * chrome (Android), a route it is on that is not pictured yet is captured once it has settled –
 * the drill-in's entrance over – and a route is never asked for twice; the desktop hosts, a
 * hidden page and a document page ask for nothing.
 */

function tab(url: string): Tab {
  return { id: 'settings-tab', url } as Tab
}

function Probe({
  url,
  shown,
  platform
}: {
  url: string
  shown: boolean
  platform: Platform
}): JSX.Element {
  useChromePageCapture(tab(url), shown, platform)
  return createElement('i')
}

let root: Root
let container: HTMLDivElement
const capture = vi.mocked(captureThumbnail)

function mount(url: string, shown = true, platform: Platform = 'android'): void {
  act(() => root.render(createElement(Probe, { url, shown, platform })))
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(CHROME_PAGE_CAPTURE_SETTLE_MS)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetChromePageCaptures()
  capture.mockReset()
  capture.mockResolvedValue('data:image/jpeg;base64,picture')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('a chrome page shown on Android', () => {
  it('is captured once its route has settled, and not again for the same route', () => {
    mount('zen://settings/updates')
    expect(capture).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(CHROME_PAGE_CAPTURE_SETTLE_MS - 1)
    })
    expect(capture).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('settings-tab')
    // Hidden by a sheet and shown again: the same route, no second picture.
    mount('zen://settings/updates', false)
    mount('zen://settings/updates', true)
    settle()
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('is captured again for each route it moves to: the drill-in page, and the way back', () => {
    mount('zen://settings/privacy')
    settle()
    mount('zen://settings/privacy/site-data')
    settle()
    mount('zen://settings/privacy')
    settle()
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('waits for the route to settle: a change within the wait cancels the capture of the route left', () => {
    mount('zen://settings/privacy')
    act(() => {
      vi.advanceTimersByTime(CHROME_PAGE_CAPTURE_SETTLE_MS / 2)
    })
    mount('zen://settings/privacy/site-data')
    settle()
    expect(capture).toHaveBeenCalledTimes(1)
    // The route left is due again, should the tab come back to it.
    expect(chromePageCaptureDue('settings-tab', 'zen://settings/privacy')).toBe(true)
    expect(chromePageCaptureDue('settings-tab', 'zen://settings/privacy/site-data')).toBe(false)
  })

  it('leaves the route to be asked again when the capture yielded nothing', async () => {
    capture.mockResolvedValueOnce(null)
    mount('zen://settings/updates')
    settle()
    await flush()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(chromePageCaptureDue('settings-tab', 'zen://settings/updates')).toBe(true)
    // Shown again (the sheet that hid it is gone): asked once more.
    mount('zen://settings/updates', false)
    mount('zen://settings/updates', true)
    settle()
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('is not captured while hidden, nor when it leaves the screen before the route settled', () => {
    mount('zen://settings/updates', false)
    settle()
    expect(capture).not.toHaveBeenCalled()
    mount('zen://settings/updates', true)
    act(() => root.unmount())
    root = createRoot(container)
    settle()
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('nothing is asked for', () => {
  it('on a host that takes no picture of its chrome', () => {
    mount('zen://settings/updates', true, 'linux')
    settle()
    mount('zen://settings/updates', true, 'darwin')
    settle()
    expect(capture).not.toHaveBeenCalled()
  })

  it("for a document page, whose view's hide takes its picture", () => {
    mount('https://example.com/')
    settle()
    mount('zen://newtab')
    settle()
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('the schedule on its own', () => {
  it('runs the capture given once the route has settled and reports the route as taken', async () => {
    const taken = vi.fn().mockResolvedValue('picture')
    scheduleChromePageCapture('t', 'zen://settings/updates', taken)
    expect(chromePageCaptureDue('t', 'zen://settings/updates')).toBe(false)
    vi.advanceTimersByTime(CHROME_PAGE_CAPTURE_SETTLE_MS)
    expect(taken).toHaveBeenCalledWith('t')
    await Promise.resolve()
    expect(chromePageCaptureDue('t', 'zen://settings/updates')).toBe(false)
  })

  it('cancelled, forgets the route and never runs', () => {
    const taken = vi.fn().mockResolvedValue('picture')
    const cancel = scheduleChromePageCapture('t', 'zen://settings/updates', taken)
    cancel()
    vi.advanceTimersByTime(CHROME_PAGE_CAPTURE_SETTLE_MS)
    expect(taken).not.toHaveBeenCalled()
    expect(chromePageCaptureDue('t', 'zen://settings/updates')).toBe(true)
  })
})

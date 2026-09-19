// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewBridge } from '../preview'

/*
 * The stand-in host's page views (`npm run dev:android`): an `<iframe>` per tab, flipped with
 * `view.setVisible`. Like the Kotlin host it reports the frame carrying a flip as drawn
 * (`view.drawn`), which `lib/pageView.ts` times the swap between the live page and its picture
 * by – without it every sheet waited out the chrome's 1 s ack timeout before it came up, and
 * nobody previewing a sheet saw its real timing.
 */

interface HostGlobal {
  resolve: ReturnType<typeof vi.fn>
  reject: ReturnType<typeof vi.fn>
  viewEvent: ReturnType<typeof vi.fn>
  hostEvent: ReturnType<typeof vi.fn>
}

let host: HostGlobal
let frames: Array<(now: number) => void> = []

const call = (
  bridge: ReturnType<typeof createPreviewBridge>,
  method: string,
  args: unknown
): void => {
  bridge.callSync(JSON.stringify({ id: 1, method, args }))
}

beforeEach(() => {
  host = { resolve: vi.fn(), reject: vi.fn(), viewEvent: vi.fn(), hostEvent: vi.fn() }
  ;(window as unknown as { __zenHost: HostGlobal }).__zenHost = host
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
})

describe('the preview host’s view.setVisible', () => {
  it('flips the frame and reports the flip drawn on the next frame, either way', () => {
    const bridge = createPreviewBridge()
    call(bridge, 'view.create', { tabId: 't1' })
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-id="t1"]')!
    expect(frame.style.display).toBe('none')

    call(bridge, 'view.setVisible', { tabId: 't1', visible: true })
    expect(frame.style.display).toBe('block')
    // Not before the frame that shows it: the chrome must never hear "drawn" ahead of the paint.
    expect(host.hostEvent).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    frames.shift()!(16)
    expect(host.hostEvent).toHaveBeenCalledWith(
      'view.drawn',
      JSON.stringify({ tabId: 't1', visible: true })
    )

    call(bridge, 'view.setVisible', { tabId: 't1', visible: false })
    expect(frame.style.display).toBe('none')
    frames.shift()!(32)
    expect(host.hostEvent).toHaveBeenLastCalledWith(
      'view.drawn',
      JSON.stringify({ tabId: 't1', visible: false })
    )
    expect(host.hostEvent).toHaveBeenCalledTimes(2)
  })

  it('says nothing for a view it does not have', () => {
    const bridge = createPreviewBridge()
    call(bridge, 'view.setVisible', { tabId: 'nowhere', visible: false })
    expect(frames).toHaveLength(0)
    expect(host.hostEvent).not.toHaveBeenCalled()
  })
})

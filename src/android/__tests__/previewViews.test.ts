// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import { Bridge } from '../bridge'
import { createPreviewBridge } from '../preview'
import { AndroidTabView } from '../views'

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
    // Hidden the way a GONE WebView is: laid out, so the document in it keeps its measures.
    expect(frame.style.visibility).toBe('hidden')
    expect(frame.style.display).not.toBe('none')

    call(bridge, 'view.setVisible', { tabId: 't1', visible: true })
    expect(frame.style.visibility).toBe('visible')
    // Not before the frame that shows it: the chrome must never hear "drawn" ahead of the paint.
    expect(host.hostEvent).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    frames.shift()!(16)
    expect(host.hostEvent).toHaveBeenCalledWith(
      'view.drawn',
      JSON.stringify({ tabId: 't1', visible: true })
    )

    call(bridge, 'view.setVisible', { tabId: 't1', visible: false })
    expect(frame.style.visibility).toBe('hidden')
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

/*
 * The stand-in host takes the view batch too (`batch`, #312's H3b), so the preview runs the
 * chrome's production path: an `AndroidTabView` placed the way `applyLayout` places it makes ONE
 * hop, and the frame shows what the commands said, in their order, off the caller's task the way
 * the Kotlin host's main-thread task is.
 */
describe('the preview host’s batch', () => {
  it('applies a layout’s view ops in order from one hop', async () => {
    const native = createPreviewBridge()
    const batch = vi.spyOn(native, 'batch')
    const bridge = new Bridge(native)
    const view = new AndroidTabView('t1', bridge)
    call(native, 'view.create', { tabId: 't1' })
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-id="t1"]')!
    view.setBounds({ x: 0, y: 56, width: 412, height: 800 })
    view.setBorderRadius(12)
    view.setVisible(true)
    expect(view.isVisible()).toBe(true)
    // Still the task's: nothing has left, nothing has landed.
    expect(batch).not.toHaveBeenCalled()
    expect(frame.style.visibility).toBe('hidden')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(batch).toHaveBeenCalledTimes(1)
    expect(
      (JSON.parse(batch.mock.calls[0]?.[0] ?? '[]') as Array<{ method: string }>).map(
        (c) => c.method
      )
    ).toEqual(['view.setBounds', 'view.setRadius', 'view.setVisible'])
    expect(frame.style.borderRadius).toBe('12px')
    expect(frame.style.visibility).toBe('visible')
    expect(frames).toHaveLength(1)
  })

  /*
   * The boot's first report through the batch (#277's lesson: the boot sequence is where a
   * reordered or swallowed op costs the most): the shape `applyLayout` gives it – the page's
   * bounds, radius, cover and flip, then the glance's front, bounds, radius, cover and flip –
   * and the `view.focus` the core fires for the page after `layout.applied`, a `call`. The report
   * leaves as ONE hop, before the call (the flush at `call`), and the stand-in applies it before
   * it answers the call: the frames show what the commands said when the answer comes.
   */
  it('takes applyLayout’s first report – the page, the glance, the focus after – as one hop before the call, and shows it before the call is answered', async () => {
    const native = createPreviewBridge()
    const batch = vi.spyOn(native, 'batch')
    const nativeCall = vi.spyOn(native, 'call')
    const bridge = new Bridge(native)
    // The glance's view created first, so the front is a move the frame's order shows.
    const glance = new AndroidTabView('glance', bridge)
    const page = new AndroidTabView('page', bridge)
    call(native, 'view.create', { tabId: 'glance' })
    call(native, 'view.create', { tabId: 'page' })
    const glanceFrame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-id="glance"]')!
    const pageFrame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-id="page"]')!
    expect([...document.querySelectorAll('iframe')].map((f) => f.dataset.tabId)).toEqual([
      'glance',
      'page'
    ])
    // The stand-in's answer to the call: what the frames show at that moment is what the report
    // had made of them – or the call overtook the report.
    const atAnswer: Array<{ page: string; glance: string; order: Array<string | undefined> }> = []
    host.resolve.mockImplementation(() => {
      atAnswer.push({
        page: pageFrame.style.visibility,
        glance: glanceFrame.style.visibility,
        order: [...document.querySelectorAll('iframe')].map((f) => f.dataset.tabId)
      })
    })

    // `window.ts` `applyLayout`, a report with one placement and a glance, every view hidden.
    page.setBounds({ x: 0, y: 56, width: 412, height: 800 })
    page.setBorderRadius(12)
    page.setCover({ top: 56, bottom: 0 })
    page.setVisible(true)
    glance.bringToFront()
    glance.setBounds({ x: 24, y: 120, width: 364, height: 600 })
    glance.setBorderRadius(24)
    glance.setCover({ top: 0, bottom: 48 })
    glance.setVisible(true)
    // Then `layout.applied` (in-process) and, the focus pending, `focusContent` → the page's focus.
    page.focus()

    // The report left as one hop the moment the call went: the call's own hop came after it.
    expect(batch).toHaveBeenCalledTimes(1)
    expect(nativeCall).toHaveBeenCalledTimes(1)
    expect(batch.mock.invocationCallOrder[0]).toBeLessThan(nativeCall.mock.invocationCallOrder[0]!)
    expect(
      (JSON.parse(batch.mock.calls[0]?.[0] ?? '[]') as Array<{ method: string }>).map(
        (c) => c.method
      )
    ).toEqual([
      'view.setBounds',
      'view.setRadius',
      'view.setCover',
      'view.setVisible',
      'view.bringToFront',
      'view.setBounds',
      'view.setRadius',
      'view.setCover',
      'view.setVisible'
    ])
    expect((JSON.parse(nativeCall.mock.calls[0]?.[0] ?? '{}') as { method: string }).method).toBe(
      'view.focus'
    )
    // Still the task's: nothing has landed yet.
    expect(pageFrame.style.visibility).toBe('hidden')
    expect(glanceFrame.style.visibility).toBe('hidden')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The frames show the report, in its order: the glance in front of the page.
    expect(pageFrame.style.visibility).toBe('visible')
    expect(pageFrame.style.borderRadius).toBe('12px')
    expect(pageFrame.style.clipPath).toBe('inset(56px 0 0px 0 round 12px)')
    expect(glanceFrame.style.visibility).toBe('visible')
    expect(glanceFrame.style.borderRadius).toBe('24px')
    expect(glanceFrame.style.clipPath).toBe('inset(0px 0 48px 0 round 24px)')
    expect([...document.querySelectorAll('iframe')].map((f) => f.dataset.tabId)).toEqual([
      'page',
      'glance'
    ])
    // Both flips reported drawn on their frame, as the Kotlin host reports them.
    expect(frames).toHaveLength(2)
    // The call was answered once, after the report had landed – never before it.
    expect(atAnswer).toEqual([{ page: 'visible', glance: 'visible', order: ['page', 'glance'] }])
    expect(host.reject).not.toHaveBeenCalled()
  })
})

/*
 * The preview host has none of the back/forward list messages (`view.navigationEntries`,
 * `view.navigationHostState`, `historyChanged`, `view.restoreNavigation`, `view.goToIndex`): a
 * view on it keeps the URL-only snapshot and a restore loads the current entry, as before.
 */
describe('the preview host without the navigation snapshot messages', () => {
  it('leaves the view its URL-only snapshot and loads the current entry on a restore', async () => {
    const bridge = new Bridge(createPreviewBridge())
    // Answers come back through the host global, as `installHostGlobal` wires them on a device.
    host.resolve.mockImplementation((id: number, json: string | null) => bridge.resolve(id, json))
    host.reject.mockImplementation((id: number, message: string) => bridge.reject(id, message))
    const view = new AndroidTabView('t1', bridge)
    view.events = new Proxy({} as TabViewEvents, { get: () => (): undefined => undefined })
    await bridge.call('view.create', { tabId: 't1' })
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-id="t1"]')!

    expect(view.navigationEntries()).toEqual({ entries: [], index: -1 })
    view.goToIndex(0)
    // The current entry is a page happy-dom does not go and fetch (an `about:` URL).
    await view.restoreNavigation({
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: 'about:blank', title: '' }
      ],
      index: 1,
      hostState: 'UGFyY2Vs'
    })
    expect(frame.dataset.url).toBe('about:blank')
    expect(frame.src).toBe('about:blank')
    expect(host.reject).not.toHaveBeenCalled()
    // The stand-in's `navigated` came through the host global, which the fake here only records.
    expect(host.viewEvent).toHaveBeenCalledWith('t1', 'navigated', expect.any(String))
  })
})

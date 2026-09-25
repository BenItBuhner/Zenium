import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bridge, type NativeBridge } from '../bridge'
import { AndroidTabView, type PlacementListener } from '../views'

/*
 * Q1, the observable landing (the §11 stand-in rule): a page view brought back is a landing,
 * and the chrome's stand-in for the page leaves on the host's word that the page is on screen –
 * the answer to `view.shown`, asked right after the batch that placed the view. What the host
 * reads is the page's order: the batch (bounds, radius, the flip to visible), then the ask.
 */

/** A host that records every hop in the order it saw it, by kind and method(s), and its calls' ids. */
function native(): {
  native: NativeBridge
  hops: string[]
  calls: Array<{ id: number; method: string; args: unknown }>
} {
  const hops: string[] = []
  const calls: Array<{ id: number; method: string; args: unknown }> = []
  const methodsOf = (json: string): string => {
    const parsed = JSON.parse(json) as { method: string } | Array<{ method: string }>
    return Array.isArray(parsed) ? parsed.map((c) => c.method).join('+') : parsed.method
  }
  return {
    hops,
    calls,
    native: {
      call: (json) => {
        hops.push(`call ${methodsOf(json)}`)
        calls.push(JSON.parse(json) as { id: number; method: string; args: unknown })
      },
      callSync: () => '',
      post: (json) => {
        hops.push(`post ${methodsOf(json)}`)
      },
      batch: (json) => {
        hops.push(`batch ${methodsOf(json)}`)
      }
    }
  }
}

function listener(): { placement: PlacementListener; answers: Array<[string, boolean]> } {
  const answers: Array<[string, boolean]> = []
  return { answers, placement: { onShown: (tabId, shown) => answers.push([tabId, shown]) } }
}

const microtasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The core's landing placement of `view`, as `window.ts` `applyLayout` makes it, in one task. */
function place(view: AndroidTabView): void {
  view.setBounds({ x: 0, y: 56, width: 412, height: 800 })
  view.setBorderRadius(12)
  view.setVisible(true)
}

describe('view.shown: the ask follows the placement through the port, and the answer is the chrome’s word', () => {
  afterEach(() => {
    delete (globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace
    vi.restoreAllMocks()
  })

  it('a view brought back sends its batch, then the ask, in that order and in one task', async () => {
    const { native: n, hops, calls } = native()
    const { placement, answers } = listener()
    const view = new AndroidTabView('t1', new Bridge(n), undefined, undefined, placement)
    place(view)
    // Nothing has left yet: the batch waits for the task's end, the ask for the batch.
    expect(hops).toEqual([])
    await microtasks()
    expect(hops).toEqual(['batch view.setBounds+view.setRadius+view.setVisible', 'call view.shown'])
    expect(calls[0]?.args).toEqual({ tabId: 't1' })
    expect(answers).toEqual([])
  })

  it('the host’s `true` – the placement applied and the view’s frame drawn – reaches the chrome as shown', async () => {
    const { native: n, calls } = native()
    const { placement, answers } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    place(view)
    await microtasks()
    bridge.resolve(calls[0]!.id, 'true')
    await microtasks()
    expect(answers).toEqual([['t1', true]])
  })

  it('the host’s `false` – a view it does not have or show, or a frame that never came – reaches the chrome as not shown', async () => {
    const { native: n, calls } = native()
    const { placement, answers } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    place(view)
    await microtasks()
    bridge.resolve(calls[0]!.id, 'false')
    await microtasks()
    expect(answers).toEqual([['t1', false]])
  })

  it('a call the host refuses is not shown either: the stand-in has nothing to wait for', async () => {
    const { native: n, calls } = native()
    const { placement, answers } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    place(view)
    await microtasks()
    bridge.reject(calls[0]!.id, 'no such method')
    await microtasks()
    expect(answers).toEqual([['t1', false]])
  })

  it('only the flip to visible is a landing: a hide, and a placement of a view already shown, ask nothing', async () => {
    const { native: n, hops } = native()
    const { placement, answers } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    place(view)
    await microtasks()
    hops.length = 0
    // The sheet's layout: the same view moved, still visible.
    view.setBounds({ x: 0, y: 56, width: 412, height: 700 })
    view.setVisible(true)
    await microtasks()
    expect(hops).toEqual(['batch view.setBounds+view.setVisible'])
    // Its hide.
    view.setVisible(false)
    await microtasks()
    expect(hops).toEqual(['batch view.setBounds+view.setVisible', 'batch view.setVisible'])
    expect(answers).toEqual([])
  })

  it('a view destroyed before the ask left answers not shown without a hop', async () => {
    const { native: n, hops } = native()
    const { placement, answers } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    view.setVisible(true)
    view.destroy()
    await microtasks()
    expect(hops.some((h) => h.includes('view.shown'))).toBe(false)
    expect(answers).toEqual([['t1', false]])
  })

  it('under the bridge’s trace flag the answer’s arrival is marked, with the tab and the word', async () => {
    ;(globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace = true
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark)
    const { native: n, calls } = native()
    const { placement } = listener()
    const bridge = new Bridge(n)
    const view = new AndroidTabView('t1', bridge, undefined, undefined, placement)
    place(view)
    await microtasks()
    bridge.resolve(calls[0]!.id, 'true')
    await microtasks()
    const names = mark.mock.calls.map((c) => c[0])
    expect(names).toContain('bridge:batch:view.setBounds+view.setRadius+view.setVisible')
    expect(names).toContain('bridge:call:view.shown')
    expect(names).toContain('bridge:answer:view.shown:t1:true')
    // The ask's mark precedes the answer's: the sequence a scene's trace reads.
    expect(names.indexOf('bridge:call:view.shown')).toBeLessThan(
      names.indexOf('bridge:answer:view.shown:t1:true')
    )
  })
})

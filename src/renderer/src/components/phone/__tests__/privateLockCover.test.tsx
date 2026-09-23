// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'

/*
 * The lock cover (INC-05 / SET-17, Chrome's locked Incognito view): over a locked private tab it
 * draws the tab's picture masked under a veil, the mask glyph, "Your private tabs are locked" and
 * one primary Unlock in the window family; Unlock asks the host's prompt; a lock that comes off
 * under the cover lifts it on the spring before the page comes back (`liftLanded`), while a
 * cover asked away with the lock standing goes at once; main.css draws the blur, the veil and
 * the lift from `--zen-lock-p`.
 */

const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { PrivateLockCover } = await import('../PrivateLockCover')
const { applyPrivateLock, privateLockStore, resetPrivateLock, setPrivateLockHost } =
  await import('@renderer/lib/privateLock')
const { browserStore } = await import('@renderer/lib/ui')

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's1',
    containerId: PRIVATE_CONTAINER_ID,
    url: `https://${id}.example`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

const X1 = tab('x1')

function stateOn(activeTabId: string): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: ['x1'],
    activeTabId,
    pinnedCollapsed: false
  }
  return {
    tabs: { x1: X1 },
    essentialTabIds: [],
    spaces: [space],
    activeSpaceId: 's1',
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

/** Animation frames under the test's hand: `run(n)` fires the pending callbacks n times, 16 ms apart. */
class Frames {
  queue = new Map<number, FrameRequestCallback>()
  next = 1
  now = 0
  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = this.next++
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }
  run(n: number, step = 16): void {
    for (let i = 0; i < n; i++) {
      this.now += step
      const pending = [...this.queue.values()]
      this.queue.clear()
      act(() => {
        for (const cb of pending) cb(this.now)
      })
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null

function render(props: { shown: boolean; tab?: Tab | null }): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(createElement(PrivateLockCover, props)))
}

const cover = (): HTMLElement | null => document.querySelector('[data-testid="private-lock-cover"]')
const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

beforeEach(() => {
  frames.install()
  frames.now = 0
  resetPrivateLock()
  invoke.mockClear()
  browserStore.set({ state: stateOn('x1') })
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }) as unknown as MediaQueryList
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  resetPrivateLock()
  frames.queue.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the lock cover', () => {
  it('draws nothing until asked, then the masked picture, the veil, the mask, the title and one primary Unlock in the window family', () => {
    render({ shown: false, tab: X1 })
    expect(cover()).toBeNull()
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    const el = cover()!
    expect(el).not.toBeNull()
    expect(el.dataset.surface).toBe('window')
    expect(el.getAttribute('role')).toBe('group')
    expect(el.getAttribute('aria-label')).toBe('Private tabs locked')
    // The tab's picture, masked (no capture here: the bare placeholder, which the panel base
    // under it turns into the opaque cover), then the veil over it.
    expect(el.querySelector('[data-testid="tab-preview-masked"]')).not.toBeNull()
    expect(el.querySelector('.zen-private-lock-veil')).not.toBeNull()
    const title = el.querySelector<HTMLElement>('.zen-private-lock-block h2')!
    expect(title.textContent).toBe('Your private tabs are locked')
    // §9.17's cover form: the 20 px glyph naming the state, the title 17/600 on the heading line
    // (`.zen-private-lock-title` reads `--v2-font-heading` / `--v2-line-heading`), the one
    // primary 8 below (`mt-2`); no description.
    const mask = el.querySelector<SVGElement>('.zen-private-lock-block > svg.lucide-venetian-mask')!
    expect(mask.classList.contains('h-5')).toBe(true)
    expect(mask.classList.contains('w-5')).toBe(true)
    expect(title.classList.contains('zen-private-lock-title')).toBe(true)
    expect(el.querySelectorAll('.zen-private-lock-block p')).toHaveLength(0)
    const unlock = el.querySelector<HTMLButtonElement>('[data-testid="private-lock-unlock"]')!
    expect(unlock.textContent).toBe('Unlock')
    expect(unlock.classList.contains('zen-v2-button')).toBe(true)
    expect(unlock.hasAttribute('data-primary')).toBe(true)
    expect(unlock.classList.contains('mt-2')).toBe(true)
    // The fingerprint glyph on the button (20 px, 8 before the label: §9.11's leading glyph that
    // names the means), the mask above the title: Lucide, hidden from readers.
    const finger = unlock.querySelector<SVGElement>('svg.lucide-fingerprint')!
    expect(finger.getAttribute('aria-hidden')).toBe('true')
    expect(finger.classList.contains('h-5')).toBe(true)
    expect(unlock.classList.contains('gap-2')).toBe(true)
    expect(mask.getAttribute('aria-hidden')).toBe('true')
  })

  it('over the Private pane (no tab) it has no picture: the veil lies on the opaque panel base, nothing under the cover shows through', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: null })
    const el = cover()!
    // One cover, one base: no variant leaning on a backdrop blur (the composited overview
    // defeats one, and the pane's cards would read through the tint).
    expect(el.hasAttribute('data-backdrop')).toBe(false)
    expect(el.querySelector('[data-testid="tab-preview-masked"]')).toBeNull()
    expect(el.querySelector('.zen-private-lock-veil')).not.toBeNull()
  })

  it("Unlock asks the host's prompt once and is busy meanwhile; a cancel leaves the cover", async () => {
    let answer: (locked: boolean) => void = () => undefined
    const unlock = vi.fn(
      () =>
        new Promise<{ locked: boolean }>((resolve) => (answer = (locked) => resolve({ locked })))
    )
    setPrivateLockHost({ unlock, verify: async () => true })
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    const button = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>('[data-testid="private-lock-unlock"]')!
    act(() => button().click())
    expect(unlock).toHaveBeenCalledTimes(1)
    expect(button().getAttribute('aria-busy')).toBe('true')
    act(() => button().click())
    expect(unlock).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer(true)
      await Promise.resolve()
    })
    expect(button().hasAttribute('aria-busy')).toBe(false)
    expect(privateLockStore.get().locked).toBe(true)
    expect(cover()).not.toBeNull()
  })

  it('a lock that comes off under the cover lifts it on the spring: `--zen-lock-p` runs 1 → 0, the cover stays until it lands, then the page comes back (liftLanded)', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    // The pass: the host says unlocked; the frame keeps asking for the cover while it lifts.
    act(() => applyPrivateLock({ locked: false }))
    expect(privateLockStore.get().lifting).toBe(true)
    render({ shown: true, tab: X1 })
    const el = cover()!
    expect(el.dataset.leaving).toBe('true')
    expect(el.hasAttribute('inert')).toBe(true)
    frames.run(2)
    const p = Number.parseFloat(el.style.getPropertyValue('--zen-lock-p'))
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
    // Still lifting: the page stays hidden under the cover.
    expect(privateLockStore.get().lifting).toBe(true)
    // The lift lands: the value runs to 0 in its own time – the spring rests at the unit's scale
    // (`SPRING_LIFT`), not at the shared spring's px thresholds, which would call it settled
    // around the half and cut the cover away with the veil at half and the picture still
    // blurred. Every frame is read while the lift runs.
    const trace: number[] = [p]
    // The landing frame's write is read as it is made: the effect's cleanup clears the property
    // once the lift is done.
    const setProperty = el.style.setProperty.bind(el.style)
    vi.spyOn(el.style, 'setProperty').mockImplementation((name, value) => {
      if (name === '--zen-lock-p' && value !== null) trace.push(Number.parseFloat(value))
      setProperty(name, value)
    })
    let lifting = true
    for (let i = 0; i < 60 && lifting; i++) {
      frames.run(1)
      lifting = privateLockStore.get().lifting
    }
    expect(lifting).toBe(false)
    // At rest by 370 ms (22 frames at 60 Hz, + the 2 above), not in five, and at 0 when it lands.
    expect(trace.length).toBeGreaterThan(12)
    expect(trace.length).toBeLessThan(30)
    expect(trace.at(-1)).toBe(0)
    // Monotone, no frame stepping more than .13.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]).toBeLessThanOrEqual(trace[i - 1])
      expect(trace[i - 1] - trace[i]).toBeLessThan(0.13)
    }
    // Landed: the lift is over, the store says so, and the cover goes once the frame stops asking.
    render({ shown: false, tab: X1 })
    expect(cover()).toBeNull()
  })

  it('the wait ending before the cover lands cuts the cover with it: LIFT_MAX_MS ran out on slow frames – the page comes back in the same flush, never under a cover still up', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    act(() => applyPrivateLock({ locked: false }))
    render({ shown: true, tab: X1 })
    const el = cover()!
    expect(el.dataset.leaving).toBe('true')
    // The spring steps at most 64 ms a frame: on frames 300 ms apart the lift is at a quarter
    // when the deadline's 600 ms are up (the emulator's rate under swiftshader; W4-11's run).
    frames.run(2, 300)
    const p = Number.parseFloat(el.style.getPropertyValue('--zen-lock-p'))
    expect(p).toBeGreaterThan(0.1)
    expect(privateLockStore.get().lifting).toBe(true)
    // The deadline clears the wait (`privateLock.ts`), the frame stops asking for the cover: the
    // cover is gone in the same flush, not left lifting over the page.
    act(() => {
      privateLockStore.set({ lifting: false })
      root!.render(createElement(PrivateLockCover, { shown: false, tab: X1 }))
    })
    expect(cover()).toBeNull()
    expect(privateLockStore.get()).toMatchObject({ locked: false, lifting: false })
  })

  it('over the Private pane the lift runs the same way, though nothing waits on it', () => {
    browserStore.set({ state: stateOn('r-none') })
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: null })
    act(() => applyPrivateLock({ locked: false }))
    // No private tab in front: no page to keep hidden, the pane cover just lifts.
    expect(privateLockStore.get().lifting).toBe(false)
    render({ shown: false, tab: null })
    const el = cover()!
    expect(el).not.toBeNull()
    expect(el.dataset.leaving).toBe('true')
    frames.run(60)
    expect(cover()).toBeNull()
  })

  it('asked away while the lock stands (the stage or the omnibox over the tab) it goes at once, no lift', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    render({ shown: false, tab: X1 })
    expect(cover()).toBeNull()
    expect(privateLockStore.get().locked).toBe(true)
  })

  it('a lock released while no cover was up here lands the lift at once: the page comes back', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: false, tab: X1 })
    act(() => applyPrivateLock({ locked: false }))
    expect(privateLockStore.get().lifting).toBe(false)
    expect(cover()).toBeNull()
  })

  it('a lock again during the lift puts the cover back at rest, whole', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: X1 })
    act(() => applyPrivateLock({ locked: false }))
    render({ shown: true, tab: X1 })
    frames.run(2)
    expect(cover()!.dataset.leaving).toBe('true')
    act(() => applyPrivateLock({ locked: true }))
    render({ shown: true, tab: X1 })
    const el = cover()!
    expect(el.dataset.leaving).toBeUndefined()
    expect(el.hasAttribute('inert')).toBe(false)
    expect(el.style.getPropertyValue('--zen-lock-p')).toBe('')
    expect(privateLockStore.get()).toMatchObject({ locked: true, lifting: false })
  })

  it('main.css draws the cover from the lift progress: the blur, the veil and the block ride `--zen-lock-p` on the one opaque panel base; nothing slides, nothing blurs its backdrop', () => {
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, selector).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(rule('.zen-private-lock')).toMatch(/--zen-lock-p: 1;/)
    expect(rule('.zen-private-lock')).toMatch(/background: var\(--v2-panel\);/)
    // One base for every form of the cover (§9.19's opaque `--v2-panel` where there is no
    // picture): no transparent variant.
    expect(css).not.toContain('.zen-private-lock[data-backdrop]')
    expect(rule('.zen-private-lock-picture')).toMatch(
      /filter: blur\(calc\(var\(--zen-lock-blur\) \* var\(--zen-lock-p\)\)\);/
    )
    // The veil tints and fades; it does not blur what lies under it (a backdrop blur reads
    // nothing through a composited layer, and over a picture it would blur the blur).
    expect(rule('.zen-private-lock-veil')).not.toMatch(/backdrop-filter/)
    expect(rule('.zen-private-lock-veil')).toMatch(/opacity: var\(--zen-lock-p\);/)
    expect(rule('.zen-private-lock-block')).toMatch(/opacity: var\(--zen-lock-p\);/)
    // §11.6: nothing on the cover slides – the block's transform is its centring alone.
    expect(rule('.zen-private-lock-block')).toMatch(/transform: translateY\(-50%\);/)
    expect(rule('.zen-private-lock-block')).not.toMatch(/8px/)
    // The title at §9.17's 17/600 on the heading line.
    expect(rule('.zen-private-lock-title')).toMatch(/font-size: var\(--v2-font-heading\);/)
    expect(rule('.zen-private-lock-title')).toMatch(/line-height: var\(--v2-line-heading\);/)
    expect(rule('.zen-private-lock-title')).toMatch(/font-weight: 600;/)
    // A locked private tab's picture is masked wherever a card shows it.
    expect(rule('.zen-tab-preview-masked')).toMatch(/filter: blur\(/)
  })
})

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
    expect(el.hasAttribute('data-backdrop')).toBe(false)
    expect(el.querySelector('.zen-private-lock-block h2')?.textContent).toBe(
      'Your private tabs are locked'
    )
    const unlock = el.querySelector<HTMLButtonElement>('[data-testid="private-lock-unlock"]')!
    expect(unlock.textContent).toBe('Unlock')
    expect(unlock.classList.contains('zen-v2-button')).toBe(true)
    expect(unlock.hasAttribute('data-primary')).toBe(true)
    // The fingerprint glyph on the button, the mask above the title: Lucide, hidden from readers.
    expect(unlock.querySelector('svg.lucide-fingerprint')?.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('svg.lucide-venetian-mask')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('over the Private pane (no tab) it has no picture and no base: the veil blurs what lies under it', () => {
    applyPrivateLock({ locked: true, screenLock: true })
    render({ shown: true, tab: null })
    const el = cover()!
    expect(el.hasAttribute('data-backdrop')).toBe(true)
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
    frames.run(60)
    // Landed: the lift is over, the store says so, and the cover goes once the frame stops asking.
    expect(privateLockStore.get().lifting).toBe(false)
    render({ shown: false, tab: X1 })
    expect(cover()).toBeNull()
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

  it('main.css draws the cover from the lift progress: the blur, the veil and the block ride `--zen-lock-p`, the panel base under a picture, none under a backdrop', () => {
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, selector).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(rule('.zen-private-lock')).toMatch(/--zen-lock-p: 1;/)
    expect(rule('.zen-private-lock')).toMatch(/background: var\(--v2-panel\);/)
    expect(rule('.zen-private-lock[data-backdrop]')).toMatch(/background: transparent;/)
    expect(rule('.zen-private-lock-picture')).toMatch(
      /filter: blur\(calc\(var\(--zen-lock-blur\) \* var\(--zen-lock-p\)\)\);/
    )
    expect(rule('.zen-private-lock-veil')).toMatch(/backdrop-filter: blur\(calc\(/)
    expect(rule('.zen-private-lock-veil')).toMatch(/opacity: var\(--zen-lock-p\);/)
    expect(rule('.zen-private-lock-block')).toMatch(/opacity: var\(--zen-lock-p\);/)
    // A locked private tab's picture is masked wherever a card shows it.
    expect(rule('.zen-tab-preview-masked')).toMatch(/filter: blur\(/)
  })
})

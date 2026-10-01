// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Smartphone } from 'lucide-react'
import type { UIState } from '@shared/types'
import type { BannerDismissReason } from '@renderer/lib/ui'

/*
 * The band on the touch hosts (motion spec §3.4 Android; §9 item 6): the layer mounts the
 * Android host and the tenants' door, the band takes no focus on open, and the system Back is
 * its Escape – a standing band is the chrome's topmost back surface, Back puts it away
 * UNANSWERED (the tenant hears `onAway`, not a refusal), a popover over the page goes first.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const touch = { value: true }
vi.mock('@renderer/lib/formFactor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/formFactor')>()
  return { ...actual, isTouchLayout: () => touch.value }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TouchBandLayer } = await import('../TouchBandLayer')
const { run } = await import('@renderer/lib/api')
const { backStore, dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
const { bandStore, resetBands } = await import('@renderer/lib/band')
const { mountedAndroidBand } = await import('@renderer/lib/band/mount')
const { bandIsTheDoor, postBanner } = await import('@renderer/lib/band/post')
const { browserStore } = await import('@renderer/lib/browserStore')
const { openPopover, openPopoverCount } = await import('@renderer/lib/popoverStore')
const { abortPull, setPageHold, setPullHost } = await import('@renderer/lib/pull')
const { uiStore } = await import('@renderer/lib/ui')

function stateWith(activeTabId: string): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [
      {
        id: 's1',
        name: 'Work',
        containerId: 'default',
        tabIds: ['t1'],
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    tabs: {
      t1: {
        id: 't1',
        url: 'https://example.com/t1',
        title: 't1',
        containerId: 'default',
        pinned: false,
        essential: false,
        folderId: null,
        splitGroupId: null,
        discarded: false,
        loading: false
      }
    },
    essentialTabIds: [],
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLDivElement | null = null

function render(): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(createElement(TouchBandLayer)))
}

interface Tenant {
  id: number
  ends: BannerDismissReason[]
  away: number
}

/** The install offer posted through the door, its ends and its unanswered ends counted. */
function postInstall(): Tenant {
  const tenant: Tenant = { id: 0, ends: [], away: 0 }
  act(() => {
    tenant.id = postBanner(
      {
        title: 'Add Example to Home screen',
        detail: 'example.com',
        icon: Smartphone,
        key: 'install',
        duration: 10_000,
        action: { label: 'Add', onPick: () => undefined },
        onDismiss: (reason) => tenant.ends.push(reason)
      },
      'offer',
      { onAway: () => void tenant.away++ }
    )
  })
  return tenant
}

describe('TouchBandLayer – the band on the touch hosts', () => {
  beforeEach(() => {
    touch.value = true
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    setPullHost({ setOffset: () => undefined })
    browserStore.set({ state: stateWith('t1') })
    uiStore.set({
      frameDialogsOpen: 0,
      frameDialogCover: 0,
      banners: [],
      findOpen: false,
      findTabId: null
    })
    resetBands()
    vi.mocked(run).mockClear()
  })

  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = null
    mount?.remove()
    mount = null
    abortPull()
    setPageHold(null)
    setPullHost(null)
    browserStore.set({ state: null })
    resetBands()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('mounting makes the band the door and gives the host the front; a shown band is a role="status" region that takes no focus; unmounting hands the door back', () => {
    expect(bandIsTheDoor()).toBe(false)
    render()
    expect(mountedAndroidBand()).not.toBeNull()
    expect(bandIsTheDoor()).toBe(true)
    expect(bandStore.get()).toMatchObject({ front: 't1', ok: true })
    expect(topBackSurface()).toBeNull()

    const tenant = postInstall()
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    const band = mount!.querySelector('.zen-band')
    expect(band).not.toBeNull()
    expect(band?.getAttribute('role')).toBe('status')
    expect(band?.getAttribute('data-form')).toBe('offer')
    expect(mount!.querySelector('.zen-band-title')?.textContent).toBe('Add Example to Home screen')
    // An unasked offer: nothing in the band or the layer took the focus (§9 item 6).
    expect(document.activeElement).toBe(document.body)
    expect(tenant.ends).toEqual([])

    act(() => root!.unmount())
    root = null
    // The layer gone, the band it held went as the chrome's doing and the stack is the door.
    expect(tenant.ends).toEqual(['program'])
    expect(tenant.away).toBe(0)
    expect(mountedAndroidBand()).toBeNull()
    expect(bandIsTheDoor()).toBe(false)
    expect(topBackSurface()).toBeNull()
  })

  it('a standing band is the topmost back surface and the system Back puts it away unanswered: the tenant hears onAway, not a refusal', () => {
    render()
    expect(backStore.get().chrome).toBe(false)
    const tenant = postInstall()
    expect(topBackSurface()?.name).toBe('band')
    expect(backStore.get().chrome).toBe(true)

    let handled = false
    act(() => {
      handled = dispatchBackEvent('commit')
    })
    expect(handled).toBe(true)
    expect(bandStore.get().entries).toEqual([])
    expect(tenant.away).toBe(1)
    expect(tenant.ends).toEqual([])
    expect(topBackSurface()).toBeNull()
    expect(backStore.get().chrome).toBe(false)
  })

  it('the predictive gesture: start takes the band as its surface and commit puts it away; a cancel leaves it standing', () => {
    render()
    const tenant = postInstall()
    act(() => {
      expect(dispatchBackEvent('start', { edge: 'left' })).toBe(true)
      expect(dispatchBackEvent('progress', { progress: 0.4 })).toBe(true)
      expect(dispatchBackEvent('cancel')).toBe(true)
    })
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    expect(tenant.away).toBe(0)
    act(() => {
      expect(dispatchBackEvent('start', { edge: 'left' })).toBe(true)
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(bandStore.get().entries).toEqual([])
    expect(tenant.away).toBe(1)
  })

  it('the × is the explicit refusal the tenant hears as close; Back after that has nothing of the band’s', () => {
    render()
    const tenant = postInstall()
    const close = mount!.querySelector<HTMLButtonElement>('.zen-band-close')
    expect(close?.getAttribute('aria-label')).toBe('Dismiss')
    act(() => close!.click())
    expect(tenant.ends).toEqual(['close'])
    expect(tenant.away).toBe(0)
    expect(topBackSurface()).toBeNull()
  })

  it('a popover over the page goes first: Back closes it and the band stands; the next Back puts the band away', () => {
    render()
    const tenant = postInstall()
    const bubble = document.createElement('div')
    document.body.appendChild(bubble)
    const closed: string[] = []
    const off = openPopover({ element: () => bubble, close: (reason) => closed.push(reason) })
    expect(openPopoverCount()).toBe(1)

    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(closed).toEqual(['all'])
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    expect(tenant.away).toBe(0)
    off()
    bubble.remove()

    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(bandStore.get().entries).toEqual([])
    expect(tenant.away).toBe(1)
  })

  it('the shell’s order holds with a band up: the find bar, which registers no surface, closes on the first Back and the band stands; the next Back puts the band away', () => {
    render()
    const tenant = postInstall()
    expect(topBackSurface()?.name).toBe('band')
    act(() => uiStore.set({ findOpen: true, findTabId: 't1' }))

    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(uiStore.get().findOpen).toBe(false)
    expect(vi.mocked(run)).toHaveBeenCalledWith('find.stop', { tabId: 't1', keepSelection: true })
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    expect(tenant.away).toBe(0)
    expect(topBackSurface()?.name).toBe('band')

    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(bandStore.get().entries).toEqual([])
    expect(tenant.away).toBe(1)
    expect(tenant.ends).toEqual([])
  })

  it('a glance over the page goes before the band too: Back closes the glance, never the band under it', () => {
    render()
    const tenant = postInstall()
    act(() => {
      browserStore.set({
        state: { ...stateWith('t1'), glance: {} as unknown as NonNullable<UIState['glance']> }
      })
    })

    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(vi.mocked(run)).toHaveBeenCalledWith('glance.close', undefined)
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    expect(tenant.away).toBe(0)
  })
})

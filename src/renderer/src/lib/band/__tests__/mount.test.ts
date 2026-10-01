import { Info } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import type { BannerDismissReason } from '@renderer/lib/ui'

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

import { bandStore, resetBands } from '@renderer/lib/band'
import { browserStore } from '@renderer/lib/browserStore'
import { abortPull, heldPageOffset, setPageHold, setPullHost } from '@renderer/lib/pull'
import { uiStore } from '@renderer/lib/ui'
import { mountAndroidBand, mountedAndroidBand } from '../mount'
import { bandIsTheDoor, postBanner, postedUp } from '../post'

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

describe('mountAndroidBand – the host and the door, mounted and unmounted as one', () => {
  let written: Array<[string, number]>

  beforeEach(() => {
    written = []
    touch.value = true
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    setPullHost({ setOffset: (tabId, offset) => written.push([tabId, offset]) })
    browserStore.set({ state: stateWith('t1') })
    uiStore.set({ frameDialogsOpen: 0, frameDialogCover: 0, banners: [] })
    resetBands()
  })
  afterEach(() => {
    abortPull()
    setPageHold(null)
    setPullHost(null)
    browserStore.set({ state: null })
    resetBands()
    vi.unstubAllGlobals()
  })

  it('mounted, the tenants post to the model and the host has the front; unmounted, they post to the banner stack again', () => {
    expect(bandIsTheDoor()).toBe(false)
    expect(mountedAndroidBand()).toBeNull()
    const band = mountAndroidBand()
    expect(mountedAndroidBand()).toBe(band)
    expect(bandIsTheDoor()).toBe(true)
    expect(bandStore.get()).toMatchObject({ front: 't1', eligible: true })

    const ends: BannerDismissReason[] = []
    const id = postBanner(
      { title: 'Install?', icon: Info, key: 'install', onDismiss: (r) => ends.push(r) },
      'offer'
    )
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['install'])
    expect(uiStore.get().banners).toEqual([])
    expect(postedUp(id)).toBe(true)
    band.host.translate(76)
    expect(heldPageOffset('t1')).toBe(76)

    band.unmount()
    // What stood at the band went as the chrome's doing; the tenant heard and let go.
    expect(ends).toEqual(['program'])
    expect(bandStore.get().entries).toEqual([])
    expect(postedUp(id)).toBe(false)
    expect(heldPageOffset('t1')).toBe(0)
    expect(written).toEqual([
      ['t1', 76],
      ['t1', 0]
    ])
    expect(bandIsTheDoor()).toBe(false)
    expect(mountedAndroidBand()).toBeNull()
    expect(bandStore.get()).toMatchObject({ front: null, eligible: false })

    const again = postBanner({ title: 'Install?', icon: Info, key: 'install' }, 'offer')
    expect(bandStore.get().entries).toEqual([])
    expect(uiStore.get().banners.map((b) => b.key)).toEqual(['install'])
    expect(postedUp(again)).toBe(true)
  })
})

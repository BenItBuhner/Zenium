import { describe, expect, it } from 'vitest'
import {
  SYSTEM_DISPLAY_CROS_ONLY_ERROR,
  SYSTEM_DISPLAY_CROS_ONLY_METHODS,
  SYSTEM_DISPLAY_NO_PERMISSION_ERROR,
  type ScreenDisplay
} from '../../../core/extensions/api/systemDisplay'
import { SystemDisplayApi, type DisplayScreen } from '../extensionApi/systemDisplay'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const NO_PERMISSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const primary: ScreenDisplay = {
  id: 1,
  label: 'HDMI-1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1050 },
  scaleFactor: 1,
  rotation: 0,
  internal: false,
  touchSupport: 'unknown',
  accelerometerSupport: 'unknown'
}

const second: ScreenDisplay = {
  ...primary,
  id: 2,
  label: 'DP-2',
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 }
}

interface Broadcast {
  namespace: string
  event: string
  delivered: string[]
}

class FakeScreen implements DisplayScreen {
  list: ScreenDisplay[] = [primary]
  listeners = new Set<() => void>()

  displays(): ScreenDisplay[] {
    return this.list
  }

  primary(): ScreenDisplay | null {
    return this.list[0] ?? null
  }

  observe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  change(list: ScreenDisplay[]): void {
    this.list = list
    for (const listener of this.listeners) listener()
  }
}

function world(): {
  api: SystemDisplayApi
  screen: FakeScreen
  broadcasts: Broadcast[]
  loaded: Map<string, LoadedExtension>
  ctx(id: string): ApiContext
  load(id: string): void
  unload(id: string): void
} {
  const screen = new FakeScreen()
  const broadcasts: Broadcast[] = []
  const loaded = new Map<string, LoadedExtension>()
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['tabs'] : ['system.display'],
      origins: []
    }),
    allLoaded: () => [...loaded.values()],
    broadcast: (
      namespace: string,
      event: string,
      argsFor: (extension: LoadedExtension) => unknown[] | null
    ) => {
      const delivered = [...loaded.values()]
        .filter((extension) => argsFor(extension) !== null)
        .map((extension) => extension.id)
      broadcasts.push({ namespace, event, delivered })
    }
  } as unknown as ApiHost
  const api = new SystemDisplayApi(host, screen)
  return {
    api,
    screen,
    broadcasts,
    loaded,
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext,
    load(id) {
      const extension = { id } as unknown as LoadedExtension
      loaded.set(id, extension)
      api.load(extension)
    },
    unload(id) {
      loaded.delete(id)
      api.unload()
    }
  }
}

describe('chrome.system.display on the desktop', () => {
  it('getInfo lists the screens with the primary flagged; the permission is required', async () => {
    const w = world()
    w.screen.list = [primary, second]
    const infos = (await w.api.handlers.getInfo(w.ctx(EXT), {})) as Array<{
      id: string
      isPrimary: boolean
      name: string
      bounds: { left: number }
    }>
    expect(infos.map((info) => [info.id, info.name, info.isPrimary, info.bounds.left])).toEqual([
      ['1', 'HDMI-1', true, 0],
      ['2', 'DP-2', false, 1920]
    ])
    await expect(async () => w.api.handlers.getInfo(w.ctx(NO_PERMISSION), {})).rejects.toThrow(
      SYSTEM_DISPLAY_NO_PERMISSION_ERROR
    )
  })

  it('getDisplayLayout is empty, as Chrome answers off ChromeOS', async () => {
    const w = world()
    expect(await w.api.handlers.getDisplayLayout(w.ctx(EXT))).toEqual([])
  })

  it('the ChromeOS-only functions fail with Chrome\u2019s error', async () => {
    const w = world()
    for (const name of SYSTEM_DISPLAY_CROS_ONLY_METHODS) {
      await expect(async () => w.api.handlers[name](w.ctx(EXT), '1', {}), name).rejects.toThrow(
        SYSTEM_DISPLAY_CROS_ONLY_ERROR
      )
    }
  })

  it('onDisplayChanged reaches the extensions holding the permission when the screens change', () => {
    const w = world()
    w.load(EXT)
    w.load(OTHER)
    w.load(NO_PERMISSION)
    expect(w.screen.listeners.size).toBe(1)
    w.screen.change([primary, second])
    expect(w.broadcasts).toEqual([
      { namespace: 'system.display', event: 'onDisplayChanged', delivered: [EXT, OTHER] }
    ])
  })

  it('watches the screens only while an extension with the permission is loaded', () => {
    const w = world()
    w.load(NO_PERMISSION)
    expect(w.screen.listeners.size).toBe(0)
    w.load(EXT)
    w.load(OTHER)
    expect(w.screen.listeners.size).toBe(1)
    w.unload(EXT)
    expect(w.screen.listeners.size).toBe(1)
    w.unload(OTHER)
    expect(w.screen.listeners.size).toBe(0)
    w.screen.change([second])
    expect(w.broadcasts).toEqual([])
  })
})

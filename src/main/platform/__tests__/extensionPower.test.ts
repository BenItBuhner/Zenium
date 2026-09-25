import { describe, expect, it } from 'vitest'
import {
  POWER_BAD_LEVEL_ERROR,
  POWER_NO_PERMISSION_ERROR
} from '../../../core/extensions/api/power'
import { PowerApi, type SaveBlocker } from '../extensionApi/power'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const EXT = 'kioaomfokioenhackhaijiebhhkkcojo'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'

interface World {
  api: PowerApi
  ctx: ApiContext
  other: ApiContext
  starts: string[]
  running: Set<number>
}

function world(permissions: Record<string, string[]> = { [EXT]: ['power'] }): World {
  const starts: string[] = []
  const running = new Set<number>()
  const blocker: SaveBlocker = {
    start: (type) => {
      starts.push(type)
      running.add(starts.length)
      return starts.length
    },
    stop: (id) => void running.delete(id),
    isStarted: (id) => running.has(id)
  }
  const host = {
    grants: (id: string) => ({ permissions: permissions[id] ?? [], origins: [] })
  } as unknown as ApiHost
  const ctxFor = (extensionId: string): ApiContext =>
    ({ extensionId, sender: { kind: 'worker' } }) as unknown as ApiContext
  return {
    api: new PowerApi(host, blocker),
    ctx: ctxFor(EXT),
    other: ctxFor(OTHER),
    starts,
    running
  }
}

describe('chrome.power on the desktop', () => {
  it('holds the display or the system awake through a power-save blocker while the request stands', () => {
    const w = world()
    expect(w.api.handlers.requestKeepAwake(w.ctx, 'display')).toBeUndefined()
    expect(w.starts).toEqual(['prevent-display-sleep'])
    expect([...w.running]).toEqual([1])
    expect(w.api.heldLevel(EXT)).toBe('display')
    w.api.handlers.releaseKeepAwake(w.ctx)
    expect(w.running.size).toBe(0)
    expect(w.api.heldLevel(EXT)).toBeNull()
    w.api.handlers.requestKeepAwake(w.ctx, 'system')
    expect(w.starts).toEqual(['prevent-display-sleep', 'prevent-app-suspension'])
    expect(w.api.heldLevel(EXT)).toBe('system')
  })

  it('keeps one request per extension: a second level replaces the first without a gap, the same level again holds', () => {
    const w = world()
    w.api.handlers.requestKeepAwake(w.ctx, 'display')
    w.api.handlers.requestKeepAwake(w.ctx, 'system')
    expect(w.starts).toEqual(['prevent-display-sleep', 'prevent-app-suspension'])
    expect([...w.running]).toEqual([2])
    w.api.handlers.requestKeepAwake(w.ctx, 'system')
    expect(w.starts).toHaveLength(2)
    expect([...w.running]).toEqual([2])
    // A release with nothing held is Chrome's no-op.
    w.api.handlers.releaseKeepAwake(w.ctx)
    w.api.handlers.releaseKeepAwake(w.ctx)
    expect(w.running.size).toBe(0)
  })

  it('releases the request when the extension unloads and leaves other extensions’ holds alone', () => {
    const w = world({ [EXT]: ['power'], [OTHER]: ['power'] })
    w.api.handlers.requestKeepAwake(w.ctx, 'display')
    w.api.handlers.requestKeepAwake(w.other, 'system')
    w.api.unload(EXT)
    expect(w.api.heldLevel(EXT)).toBeNull()
    expect(w.api.heldLevel(OTHER)).toBe('system')
    expect([...w.running]).toEqual([2])
  })

  it('answers Chrome’s errors: no permission, a level outside the enum; reportActivity is a no-op', () => {
    const w = world()
    expect(() => w.api.handlers.requestKeepAwake(w.other, 'display')).toThrow(
      POWER_NO_PERMISSION_ERROR
    )
    expect(() => w.api.handlers.releaseKeepAwake(w.other)).toThrow(POWER_NO_PERMISSION_ERROR)
    expect(() => w.api.handlers.requestKeepAwake(w.ctx, 'screen')).toThrow(POWER_BAD_LEVEL_ERROR)
    expect(() => w.api.handlers.requestKeepAwake(w.ctx, undefined)).toThrow(POWER_BAD_LEVEL_ERROR)
    expect(w.starts).toEqual([])
    expect(w.api.handlers.reportActivity(w.ctx)).toBeUndefined()
  })
})

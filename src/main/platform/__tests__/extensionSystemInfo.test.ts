import { describe, expect, it } from 'vitest'
import {
  SYSTEM_CPU_NO_PERMISSION_ERROR,
  SYSTEM_MEMORY_NO_PERMISSION_ERROR
} from '../../../core/extensions/api/systemInfo'
import { nodeMachine, SystemInfoApi, type MachineReader } from '../extensionApi/systemInfo'
import { type ApiContext, type ApiHost } from '../extensionApi/types'

const BOTH = 'abcdefghijklmnopabcdefghijklmnop'
const CPU_ONLY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NEITHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const machine: MachineReader = {
  cpu: () => ({
    numOfProcessors: 2,
    archName: 'x64',
    modelName: 'Apple M2',
    features: [],
    usage: [
      [1200, 300, 9000],
      [1100, 200, 9100]
    ]
  }),
  memory: () => ({ capacity: 16 * 1024 ** 3, availableCapacity: 5 * 1024 ** 3 })
}

function world(): { api: SystemInfoApi; ctx(id: string): ApiContext } {
  const host = {
    grants: (extensionId: string) => ({
      permissions:
        extensionId === BOTH
          ? ['system.cpu', 'system.memory', 'storage']
          : extensionId === CPU_ONLY
            ? ['system.cpu']
            : ['storage'],
      origins: []
    })
  } as unknown as ApiHost
  return {
    api: new SystemInfoApi(host, machine),
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
}

describe('chrome.system.cpu and chrome.system.memory on the desktop', () => {
  it("answers the machine in Chrome's shape for an extension granted the permissions", () => {
    const w = world()
    expect(w.api.cpuHandlers.getInfo(w.ctx(BOTH))).toEqual({
      numOfProcessors: 2,
      archName: 'x86_64',
      modelName: 'Apple M2',
      features: [],
      processors: [
        { usage: { user: 1200, kernel: 300, idle: 9000, total: 10500 } },
        { usage: { user: 1100, kernel: 200, idle: 9100, total: 10400 } }
      ],
      temperatures: []
    })
    expect(w.api.memoryHandlers.getInfo(w.ctx(BOTH))).toEqual({
      capacity: 16 * 1024 ** 3,
      availableCapacity: 5 * 1024 ** 3
    })
    expect(Object.keys(w.api.cpuHandlers)).toEqual(['getInfo'])
    expect(Object.keys(w.api.memoryHandlers)).toEqual(['getInfo'])
  })

  it('gates each namespace on its own permission with Chrome\u2019s error', () => {
    const w = world()
    expect(() => w.api.cpuHandlers.getInfo(w.ctx(CPU_ONLY))).not.toThrow()
    expect(() => w.api.memoryHandlers.getInfo(w.ctx(CPU_ONLY))).toThrow(
      SYSTEM_MEMORY_NO_PERMISSION_ERROR
    )
    expect(() => w.api.cpuHandlers.getInfo(w.ctx(NEITHER))).toThrow(SYSTEM_CPU_NO_PERMISSION_ERROR)
    expect(() => w.api.memoryHandlers.getInfo(w.ctx(NEITHER))).toThrow(
      SYSTEM_MEMORY_NO_PERMISSION_ERROR
    )
  })

  it('reads this machine through node:os in the shape the core expects', () => {
    const reading = nodeMachine()
    const cpu = reading.cpu()
    expect(typeof cpu.numOfProcessors).toBe('number')
    expect(cpu.numOfProcessors).toBeGreaterThan(0)
    expect(typeof cpu.archName).toBe('string')
    expect(Array.isArray(cpu.usage)).toBe(true)
    expect((cpu.usage as unknown[]).length).toBe(cpu.numOfProcessors)
    const memory = reading.memory()
    expect(memory.capacity).toBeGreaterThan(0)
    expect(memory.availableCapacity).toBeGreaterThan(0)
  })
})

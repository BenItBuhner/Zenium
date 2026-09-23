import { arch, cpus, freemem, totalmem } from 'node:os'
import {
  cpuInfo,
  memoryInfo,
  SYSTEM_CPU_NO_PERMISSION_ERROR,
  SYSTEM_CPU_PERMISSION,
  SYSTEM_MEMORY_NO_PERMISSION_ERROR,
  SYSTEM_MEMORY_PERMISSION,
  type CpuInfo,
  type MemoryInfo,
  type RawCpuReading,
  type RawMemoryReading
} from '../../../core/extensions/api/systemInfo'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** What the API reads of the machine (`node:os` by default; a test hands in its own). */
export interface MachineReader {
  cpu(): RawCpuReading
  memory(): RawMemoryReading
}

/**
 * Chrome's `CpuInfoProvider` on Linux folds `nice` into `user`; Node's `times` are in ms of the
 * same four counters (plus `irq`, which Chrome's Linux provider leaves out of the three).
 */
export function nodeMachine(): MachineReader {
  return {
    cpu: () => {
      const list = cpus()
      return {
        numOfProcessors: list.length,
        archName: arch(),
        modelName: list[0]?.model ?? '',
        // Node has no feature list; Chrome's x86 list stays empty here.
        features: [],
        usage: list.map((cpu) => [cpu.times.user + cpu.times.nice, cpu.times.sys, cpu.times.idle])
      }
    },
    memory: () => ({ capacity: totalmem(), availableCapacity: freemem() })
  }
}

/**
 * `chrome.system.cpu` and `chrome.system.memory` for the desktop: the engine has neither
 * namespace (Electron's extension support leaves them out), so the shim's table shapes them and
 * every call comes here, answered in Chrome's shape (`core/extensions/api/systemInfo.ts`) over
 * the machine. Gated on the permission as granted (a required one at load, an optional one by
 * `permissions.request`).
 */
export class SystemInfoApi {
  constructor(
    private readonly host: ApiHost,
    private readonly machine: MachineReader = nodeMachine()
  ) {}

  readonly cpuHandlers: NamespaceHandlers = {
    getInfo: (ctx: ApiContext): CpuInfo => {
      if (!this.permitted(ctx.extensionId, SYSTEM_CPU_PERMISSION))
        throw new ApiError(SYSTEM_CPU_NO_PERMISSION_ERROR)
      return cpuInfo(this.machine.cpu())
    }
  }

  readonly memoryHandlers: NamespaceHandlers = {
    getInfo: (ctx: ApiContext): MemoryInfo => {
      if (!this.permitted(ctx.extensionId, SYSTEM_MEMORY_PERMISSION))
        throw new ApiError(SYSTEM_MEMORY_NO_PERMISSION_ERROR)
      return memoryInfo(this.machine.memory())
    }
  }

  private permitted(extensionId: string, permission: string): boolean {
    return this.host.grants(extensionId).permissions.includes(permission)
  }
}

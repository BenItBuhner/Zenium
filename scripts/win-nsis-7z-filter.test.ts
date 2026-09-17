import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyWinNsis7zFilter, FILTER, ARCH_ARM64 } = require('./win-nsis-7z-filter.js') as {
  applyWinNsis7zFilter: (context: { electronPlatformName: string; arch: number }) => {
    applied: boolean
    filter?: string
    reason?: string
  }
  FILTER: string
  ARCH_ARM64: number
}

const ENV = 'ELECTRON_BUILDER_7Z_FILTER'
const SKIP = 'ZENIUM_SKIP_NSIS_7Z_FILTER'
const ARCH_X64 = 1

describe('win-nsis-7z-filter', () => {
  afterEach(() => {
    delete process.env[ENV]
    delete process.env[SKIP]
  })

  it('pins Windows arm64 to BCJ2 so nsis7z can decode the payload', () => {
    const result = applyWinNsis7zFilter({ electronPlatformName: 'win32', arch: ARCH_ARM64 })
    expect(result).toEqual({ applied: true, filter: 'BCJ2' })
    expect(FILTER).toBe('BCJ2')
    expect(ARCH_ARM64).toBe(3)
    expect(process.env[ENV]).toBe('BCJ2')
  })

  it('leaves Windows x64 on 7za defaults', () => {
    const result = applyWinNsis7zFilter({ electronPlatformName: 'win32', arch: ARCH_X64 })
    expect(result).toEqual({ applied: false, reason: 'not-win-arm64' })
    expect(process.env[ENV]).toBeUndefined()
  })

  it('does not pin macOS or Linux arm64 archives', () => {
    expect(applyWinNsis7zFilter({ electronPlatformName: 'darwin', arch: ARCH_ARM64 }).applied).toBe(
      false
    )
    expect(applyWinNsis7zFilter({ electronPlatformName: 'linux', arch: ARCH_ARM64 }).applied).toBe(
      false
    )
    expect(process.env[ENV]).toBeUndefined()
  })

  it('can skip the pin so a before listing still sees the ARM64 filter', () => {
    process.env[SKIP] = '1'
    const result = applyWinNsis7zFilter({ electronPlatformName: 'win32', arch: ARCH_ARM64 })
    expect(result).toEqual({ applied: false, reason: 'skipped' })
    expect(process.env[ENV]).toBeUndefined()
  })

  it('rejects a missing context', () => {
    expect(() => applyWinNsis7zFilter(undefined as never)).toThrow(/context is required/)
  })
})

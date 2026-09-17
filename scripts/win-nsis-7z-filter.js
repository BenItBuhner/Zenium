'use strict'

/**
 * electron-builder 26.15 packs the NSIS payload with 7-Zip 24.09
 * (electron-builder-binaries 7zip@1.0.0). At -mx=9 that 7za auto-applies a
 * CPU-specific branch converter to PE files: BCJ2 on x64 (which the bundled
 * nsis7z.dll can decode) and ARM64 / coder 0a on arm64 (which it cannot). The
 * ARM64 installer then exits 0, writes shortcuts, and skips zenium.exe plus
 * the Chromium DLLs (WIN-002).
 *
 * ELECTRON_BUILDER_7Z_FILTER is passed through as -mf= by compute7zCompressArgs.
 * Pin only the Windows arm64 payload to BCJ2, which nsis7z already handles
 * (resources/elevate.exe is BCJ2 today and extracts). x64 is left on 7za's
 * default so that installer stays identical.
 *
 * Set ZENIUM_SKIP_NSIS_7Z_FILTER=1 to pack without the pin (used by the
 * temporary verification workflow to record the before listing).
 */

const FILTER = 'BCJ2'
// builder-util Arch.arm64. Inlined so this CJS hook has no require() (eslint).
const ARCH_ARM64 = 3

/**
 * @typedef {{ electronPlatformName?: string, arch?: number }} PackContext
 * @typedef {{ applied: true, filter: string } | { applied: false, reason: string }} FilterResult
 */

/**
 * @param {PackContext | null | undefined} context
 * @returns {FilterResult}
 */
function applyWinNsis7zFilter(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('afterPack context is required')
  }
  if (process.env.ZENIUM_SKIP_NSIS_7Z_FILTER === '1') {
    return { applied: false, reason: 'skipped' }
  }
  if (context.electronPlatformName === 'win32' && context.arch === ARCH_ARM64) {
    process.env.ELECTRON_BUILDER_7Z_FILTER = FILTER
    return { applied: true, filter: FILTER }
  }
  return { applied: false, reason: 'not-win-arm64' }
}

/**
 * @param {PackContext} context
 * @returns {Promise<void>}
 */
async function afterPack(context) {
  const result = applyWinNsis7zFilter(context)
  if (result.applied) {
    console.log(
      `win-nsis-7z-filter: Windows arm64 NSIS payload uses -mf=${result.filter} (nsis7z cannot decode 7-Zip's ARM64 filter)`
    )
  }
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.afterPack = afterPack
module.exports.applyWinNsis7zFilter = applyWinNsis7zFilter
module.exports.FILTER = FILTER
module.exports.ARCH_ARM64 = ARCH_ARM64

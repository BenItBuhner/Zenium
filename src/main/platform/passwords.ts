import { safeStorage, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { pbkdf2, scrypt } from 'node:crypto'
import type { KdfParams, KeyWrapHost, PasswordsHost, ReauthHost } from '../../core/platform'

/**
 * Desktop protection for the password vault's data key.
 *
 * The key is wrapped by Electron's `safeStorage`: Keychain on macOS, DPAPI on Windows, the
 * secret service (libsecret or KWallet) on Linux. Electron 44 has an asynchronous encryptor that
 * can rotate keys; it is preferred and the synchronous API is the fallback. On Linux without a
 * secret service `safeStorage` only offers an in-memory "basic_text" key, which protects nothing,
 * so the host reports the keystore as unavailable and the vault falls back to a passphrase wrapped
 * with `node:crypto` scrypt.
 */

const BLOB_PREFIX = 'safeStorage:'
const SCRYPT_PARAMS: KdfParams = { kdf: 'scrypt', n: 2 ** 15, r: 8, p: 1 }
const SCRYPT_MAXMEM = 64 * 1024 * 1024
/** How long the Windows Hello prompt may stay up before it counts as dismissed. */
const REAUTH_TIMEOUT_MS = 120_000
const AVAILABILITY_TIMEOUT_MS = 20_000

export class SafeStorageKeyWrap implements KeyWrapHost {
  async osAvailable(): Promise<boolean> {
    try {
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        return false
      if (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) return true
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  async wrap(dataKey: Uint8Array): Promise<string> {
    const text = Buffer.from(dataKey).toString('base64')
    const encrypted = (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
      ? await safeStorage.encryptStringAsync(text)
      : safeStorage.encryptString(text)
    return BLOB_PREFIX + encrypted.toString('base64')
  }

  async unwrap(blob: string): Promise<Uint8Array> {
    if (!blob.startsWith(BLOB_PREFIX)) throw new Error('Not a safeStorage wrapped key')
    const encrypted = Buffer.from(blob.slice(BLOB_PREFIX.length), 'base64')
    let text: string
    if (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) {
      const { result } = await safeStorage.decryptStringAsync(encrypted)
      text = result
    } else {
      text = safeStorage.decryptString(encrypted)
    }
    const key = Buffer.from(text, 'base64')
    if (key.length !== 32) throw new Error('The unwrapped vault key has the wrong size')
    return new Uint8Array(key)
  }

  kdfParams(): KdfParams {
    return SCRYPT_PARAMS
  }

  deriveKey(passphrase: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const done = (error: Error | null, key: Buffer): void => {
        if (error) reject(error)
        else resolve(new Uint8Array(key))
      }
      if (params.kdf === 'scrypt') {
        scrypt(
          passphrase,
          salt,
          32,
          { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
          done
        )
      } else {
        pbkdf2(passphrase, salt, params.iterations, 32, 'sha256', done)
      }
    })
  }
}

/**
 * Re-authentication with what the OS offers: Touch ID on macOS, Windows Hello through
 * `Windows.Security.Credentials.UI.UserConsentVerifier` (driven by the PowerShell that ships with
 * Windows, so no dependency), nothing on Linux (the vault passphrase takes over).
 */
export class DesktopReauth implements ReauthHost {
  private windowsAvailable: Promise<boolean> | null = null

  async available(): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        return systemPreferences.canPromptTouchID()
      } catch {
        return false
      }
    }
    if (process.platform === 'win32') {
      this.windowsAvailable ??= runPowerShell(WINDOWS_AVAILABILITY_SCRIPT, AVAILABILITY_TIMEOUT_MS)
        .then((out) => out.trim() === 'Available')
        .catch(() => false)
      return this.windowsAvailable
    }
    return false
  }

  async verify(reason: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        await systemPreferences.promptTouchID(reason)
        return true
      } catch {
        return false
      }
    }
    if (process.platform === 'win32') {
      try {
        const out = await runPowerShell(windowsVerifyScript(reason), REAUTH_TIMEOUT_MS)
        return out.trim() === 'Verified'
      } catch {
        return false
      }
    }
    return false
  }
}

export function createPasswordsHost(): PasswordsHost {
  return { keys: new SafeStorageKeyWrap(), reauth: new DesktopReauth() }
}

// ---------------------------------------------------------------------------
// Windows Hello through PowerShell
// ---------------------------------------------------------------------------

/** WinRT async operations need an `AsTask` bridge before PowerShell can await them. */
const WINRT_PRELUDE = `
$ErrorActionPreference = 'Stop'
[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
`

const WINDOWS_AVAILABILITY_SCRIPT = `${WINRT_PRELUDE}
$availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
Write-Output $availability.ToString()
`

function windowsVerifyScript(reason: string): string {
  // The reason is embedded as a single-quoted PowerShell literal; quotes are doubled.
  const literal = reason.replace(/[\r\n]+/g, ' ').replace(/'/g, "''")
  return `${WINRT_PRELUDE}
$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${literal}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output $result.ToString()
`
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout))
      }
    )
  })
}

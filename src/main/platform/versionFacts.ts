/**
 * The facts `zen://version` prints on the desktop (SET-66): Chrome's chrome://version rows as
 * Electron knows them (`chrome/browser/ui/webui/version/version_ui.cc`, 152.0.7977.89), read when
 * the page is requested (`installZenProtocol`'s `version` lookup) – never at start. The rows are
 * composed from primitives (`desktopVersionFacts`, unit-tested); `readDesktopVersionInput`
 * gathers those from the process and the session.
 */
import { app, type Session } from 'electron'
import { release, type } from 'node:os'
import type { VersionPageFacts } from '../../shared/zenPages'

/** What the process knows, as primitives. */
export interface DesktopVersionInput {
  /** `app.getVersion()`. */
  version: string
  /** `app.isPackaged`: Chrome's "Official Build" against its "Developer Build". */
  packaged: boolean
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** `app.runningUnderARM64Translation`: an x64 build under Rosetta or Windows' emulation. */
  translated: boolean
  /** `process.versions.chrome`, `.electron`, `.v8`. */
  chrome: string
  electron: string
  v8: string
  /** `os.type()` and `os.release()`. */
  osType: string
  osRelease: string
  /** The session's user agent (`ses.getUserAgent()`). */
  userAgent: string
  /** `process.argv`. */
  argv: readonly string[]
  /** `process.execPath`. */
  execPath: string
  /** The profile's directory (`ElectronPlatform.profileDir`). */
  profilePath: string
}

const OS_NAMES: Readonly<Record<string, string>> = {
  Linux: 'Linux',
  Darwin: 'macOS',
  Windows_NT: 'Windows'
}

const ARCH_32 = new Set(['ia32', 'arm', 'mips', 'ppc', 's390'])

/**
 * Chrome's processor variation after the version (`VersionUI::VersionProcessorVariation`,
 * `version_ui_strings.grdp`): "(x86_64)" / "(arm64)" on macOS – "(x86_64 translated)" under
 * Rosetta – "(64-bit)" / "(32-bit)" on Windows, "(arm64)" for a Windows Arm build and "emulated"
 * for an x86 one running on Arm; "(64-bit)" / "(32-bit)" for any other platform, Linux included
 * (Chrome's `#else` branch: an arm64 Linux prints "(64-bit)" too).
 */
export function processorVariation(platform: string, arch: string, translated = false): string {
  if (platform === 'darwin') {
    if (arch === 'arm64') return '(arm64)'
    return translated ? '(x86_64 translated)' : '(x86_64)'
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return '(arm64)'
    if (arch === 'ia32') return translated ? '(32-bit emulated)' : '(32-bit)'
    return translated ? '(64-bit emulated)' : '(64-bit)'
  }
  return ARCH_32.has(arch) ? '(32-bit)' : '(64-bit)'
}

/** The rows from the primitives: Chrome's formats, Zenium's engine row where Chrome prints its Revision. */
export function desktopVersionFacts(input: DesktopVersionInput): VersionPageFacts {
  const kind = input.packaged ? 'Official Build' : 'Developer Build'
  const osName = OS_NAMES[input.osType] ?? input.osType
  return {
    app: `${input.version} (${kind}) ${processorVariation(input.platform, input.arch, input.translated)}`,
    engine: `Chromium ${input.chrome} (Electron ${input.electron})`,
    os: input.osRelease ? `${osName} ${input.osRelease}` : osName,
    javascript: `V8 ${input.v8}`,
    userAgent: input.userAgent,
    commandLine: input.argv.join(' '),
    executablePath: input.execPath,
    profilePath: input.profilePath
  }
}

/** The primitives as this process and `ses` have them right now. */
export function readDesktopVersionInput(ses: Session, profilePath: string): DesktopVersionInput {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    translated: app.runningUnderARM64Translation === true,
    chrome: process.versions.chrome ?? '',
    electron: process.versions.electron ?? '',
    v8: process.versions.v8,
    osType: type(),
    osRelease: release(),
    userAgent: ses.getUserAgent(),
    argv: process.argv,
    execPath: process.execPath,
    profilePath
  }
}

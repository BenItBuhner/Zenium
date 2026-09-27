/**
 * The facts `zen://version` prints on Android (SET-66): Chrome's chrome://version rows as this
 * host knows them. Kotlin answers `app.versionFacts` synchronously when the page is opened
 * (`Host.dispatchSync`: `Build.*`, the APK, the WebView package, the paths – cheap reads, no
 * boot-path work); the composer here lays the answer out in Chrome's formats
 * (`chrome/browser/ui/webui/version/version_ui.cc`, 152.0.7977.89) and, from an older host
 * that has no answer, prints the rows the chrome knows by itself.
 */
import type { VersionPageFacts } from '../shared/zenPages'

/** What `app.versionFacts` answers (every key optional: an older host answers nothing at all). */
export interface AndroidVersionAnswer {
  /** `BuildConfig.VERSION_NAME`. */
  version?: string
  /** `BuildConfig.VERSION_CODE` – Chrome's "APK versionCode" row. */
  versionCode?: number
  /** `BuildConfig.DEBUG`: Chrome's "Developer Build" against its "Official Build". */
  debug?: boolean
  /** `applicationInfo.targetSdkVersion` – Chrome's "APK targetSdkVersion" row. */
  targetSdk?: number
  /** `Process.is64Bit()` – Chrome's "(64-bit)" / "(32-bit)". */
  is64Bit?: boolean
  /** `Build.VERSION.RELEASE` ("14"). */
  release?: string
  /** `Build.VERSION.SDK_INT`. */
  sdkInt?: number
  /** `Build.VERSION.CODENAME` ("REL" on a release). */
  codename?: string
  /** `Build.MODEL`. */
  model?: string
  /** `Build.ID` – Chrome's "Build/…" of the OS row (`base::SysInfo::GetAndroidBuildID`). */
  buildId?: string
  webViewPackage?: string | null
  webViewVersion?: string | null
  /** The tab's user agent (`UserAgent.normalize` of the WebView's default). */
  userAgent?: string | null
  /** `applicationInfo.sourceDir`: the APK. */
  apkPath?: string | null
  /** The profile's directory (`Storage.root`). */
  profilePath?: string | null
}

/** What the chrome prints when the host has no answer: the boot's version and its own user agent. */
export interface AndroidVersionFallback {
  version: string
  userAgent: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Chrome's OS row on Android (`AndroidAboutAppInfo::GetOsInfo`, then `version_ui.cc` appends the
 * SDK and the codename): `Android 14; Pixel 7 Build/UQ1A.240105.004; 34; REL`. Parts the host
 * did not name are left out the way Chrome leaves an empty model or build id out
 * (`embedder_support::GetAndroidOSInfo`).
 */
export function androidOsRow(answer: AndroidVersionAnswer): string {
  const release = text(answer.release)
  let row = release ? `Android ${release}` : 'Android'
  const model = text(answer.model)
  const buildId = text(answer.buildId)
  if (model) row += `; ${model}`
  if (buildId) row += `${model ? '' : ';'} Build/${buildId}`
  const sdkInt = integer(answer.sdkInt)
  if (sdkInt !== undefined) row += `; ${sdkInt}`
  const codename = text(answer.codename)
  if (codename) row += `; ${codename}`
  return row
}

/**
 * The page's rows from the host's answer. `answer` is whatever the bridge returned – an object
 * from a host with the method, undefined from one without, anything at all from a broken one –
 * so every field is checked before it is printed.
 */
export function androidVersionFacts(
  answer: unknown,
  fallback: AndroidVersionFallback
): VersionPageFacts {
  const a: AndroidVersionAnswer =
    answer !== null && typeof answer === 'object' ? (answer as AndroidVersionAnswer) : {}
  const version = text(a.version) ?? fallback.version
  const kind =
    a.debug === true ? ' (Developer Build)' : a.debug === false ? ' (Official Build)' : ''
  const bits = a.is64Bit === true ? ' (64-bit)' : a.is64Bit === false ? ' (32-bit)' : ''
  const webViewPackage = text(a.webViewPackage)
  const webViewVersion = text(a.webViewVersion)
  const engine = webViewPackage
    ? webViewVersion
      ? `${webViewPackage} ${webViewVersion}`
      : webViewPackage
    : 'Android WebView'
  const versionCode = integer(a.versionCode)
  const targetSdk = integer(a.targetSdk)
  return {
    app: `${version}${kind}${bits}`,
    engine,
    os: androidOsRow(a),
    versionCode: versionCode === undefined ? undefined : String(versionCode),
    targetSdkVersion: targetSdk === undefined ? undefined : String(targetSdk),
    userAgent: text(a.userAgent) ?? fallback.userAgent,
    executablePath: text(a.apkPath),
    profilePath: text(a.profilePath)
  }
}

import { describe, expect, it } from 'vitest'
import { androidOsRow, androidVersionFacts } from '../versionFacts'

const FALLBACK = { version: '0.5.9', userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) Chrome' }

/** What `Host.dispatchSync("app.versionFacts")` answers on a Pixel 7 running a release APK. */
const ANSWER = {
  version: '0.5.9',
  versionCode: 50900,
  debug: false,
  targetSdk: 35,
  is64Bit: true,
  release: '14',
  sdkInt: 34,
  codename: 'REL',
  model: 'Pixel 7',
  buildId: 'UQ1A.240105.004',
  webViewPackage: 'com.google.android.webview',
  webViewVersion: '152.0.7977.89',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  apkPath: '/data/app/~~x==/app.zen.chromium-y==/base.apk',
  profilePath: '/data/user/0/app.zen.chromium/files/zen'
}

describe('androidVersionFacts (SET-66)', () => {
  it("lays the host's answer out as Chrome Android's chrome://version rows", () => {
    expect(androidVersionFacts(ANSWER, FALLBACK)).toEqual({
      // `<version> (<Official Build>) (<64-bit>)`: `version_ui_strings.grdp`'s words.
      app: '0.5.9 (Official Build) (64-bit)',
      // Zenium's row where Chrome prints its Revision: the WebView that is the engine.
      engine: 'com.google.android.webview 152.0.7977.89',
      // `AndroidAboutAppInfo::GetOsInfo` + "; <sdk>; <codename>" (`version_ui.cc`).
      os: 'Android 14; Pixel 7 Build/UQ1A.240105.004; 34; REL',
      versionCode: '50900',
      targetSdkVersion: '35',
      userAgent: ANSWER.userAgent,
      executablePath: ANSWER.apkPath,
      profilePath: ANSWER.profilePath
    })
  })

  it("names a debuggable APK a Developer Build and a 32-bit process as such, in Chrome's words", () => {
    const facts = androidVersionFacts({ ...ANSWER, debug: true, is64Bit: false }, FALLBACK)
    expect(facts.app).toBe('0.5.9 (Developer Build) (32-bit)')
  })

  it('prints the rows the chrome knows by itself when an older host answers nothing', () => {
    // `callSync` of a method the host lacks is undefined (`JsBridge.callSync` answers "").
    expect(androidVersionFacts(undefined, FALLBACK)).toEqual({
      app: '0.5.9',
      engine: 'Android WebView',
      os: 'Android',
      versionCode: undefined,
      targetSdkVersion: undefined,
      userAgent: FALLBACK.userAgent,
      executablePath: undefined,
      profilePath: undefined
    })
    // Nor is a malformed answer trusted for any field.
    expect(androidVersionFacts('garbage', FALLBACK).app).toBe('0.5.9')
    expect(
      androidVersionFacts({ version: 7, sdkInt: 'x', is64Bit: 'yes' }, FALLBACK)
    ).toMatchObject({
      app: '0.5.9',
      os: 'Android'
    })
  })

  it('composes the OS row as GetAndroidOSInfo does: the model and the build id each optional, the semicolon kept', () => {
    expect(androidOsRow({ release: '14', sdkInt: 34, codename: 'REL' })).toBe('Android 14; 34; REL')
    expect(androidOsRow({ release: '14', model: 'Pixel 7', sdkInt: 34, codename: 'REL' })).toBe(
      'Android 14; Pixel 7; 34; REL'
    )
    // No model: Chrome inserts the semicolon before " Build/" itself.
    expect(androidOsRow({ release: '14', buildId: 'UQ1A.240105.004', sdkInt: 34 })).toBe(
      'Android 14; Build/UQ1A.240105.004; 34'
    )
    expect(androidOsRow({})).toBe('Android')
  })

  it('names the WebView by package alone when its version is unknown', () => {
    expect(androidVersionFacts({ ...ANSWER, webViewVersion: null }, FALLBACK).engine).toBe(
      'com.google.android.webview'
    )
    expect(androidVersionFacts({ ...ANSWER, webViewPackage: null }, FALLBACK).engine).toBe(
      'Android WebView'
    )
  })

  it("falls back to the chrome's own user agent when the host could not read the WebView's", () => {
    expect(androidVersionFacts({ ...ANSWER, userAgent: null }, FALLBACK).userAgent).toBe(
      FALLBACK.userAgent
    )
  })
})

import { app, webContents as electronWebContents, type Session } from 'electron'
import type { Browser } from '../../core/browser'
import type { ElectronTabViewHost } from './views'

/** The bundle id of the app (electron-builder.yml `appId`); the keychain group hangs off it. */
const BUNDLE_ID = 'io.github.benitbuhner.zenium'

/**
 * Passkeys with platform authenticators. Chromium services Windows Hello and roaming security
 * keys (USB / NFC / hybrid) on every desktop without configuration. macOS Touch ID needs
 * `app.configureWebAuthn`, whose credentials live in a keychain access group the signed app must
 * be entitled to (`<TEAM_ID>.<bundle id>.webauthn`, see build/after-pack.mjs). The team id is
 * baked in at build time from `APPLE_TEAM_ID`; unsigned and ad-hoc builds have none and keep
 * Chromium's defaults (security keys still work, Touch ID reports "not available").
 *
 * Touch ID credentials created this way are device-bound; iCloud Keychain sync is not offered by
 * Electron's authenticator.
 */
export function configurePlatformAuthenticators(teamId: string): void {
  if (process.platform !== 'darwin' || !teamId) return
  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: `${teamId}.${BUNDLE_ID}.webauthn`,
        promptReason: 'sign in to $1'
      }
    })
  } catch (error) {
    console.warn('[zenium] WebAuthn platform authenticator:', (error as Error).message)
  }
}

/**
 * Several discoverable passkeys match a `navigator.credentials.get()`: the core asks the user
 * which account, and the answer (or a cancel) goes back to the authenticator exactly once.
 */
export function attachWebAuthnHandlers(
  browser: Browser,
  views: ElectronTabViewHost,
  ses: Session
): void {
  ses.on('select-webauthn-account', (_event, details, callback) => {
    let answered = false
    const answer = (credentialId: string | null): void => {
      if (answered) return
      answered = true
      if (credentialId) callback(credentialId)
      else callback()
    }
    const wc = details.frame ? electronWebContents.fromFrame(details.frame) : null
    const tabId = wc ? (views.tabIdForWebContents(wc) ?? null) : null
    void browser.autofill
      .selectPasskeyAccount(
        details.relyingPartyId,
        details.accounts.map((a) => ({
          credentialId: a.credentialId,
          name: a.name ?? '',
          displayName: a.displayName ?? ''
        })),
        tabId
      )
      .then(answer, () => answer(null))
  })
}

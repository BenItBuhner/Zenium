import { app, type Certificate, type WebContents } from 'electron'
import { statSync } from 'node:fs'
import type { Browser } from '../../core/browser'
import type { PermissionRequestDetails } from '../../core/permissions'
import type { ClientCertificateInfo } from '../../shared/types'
import type { ElectronTabViewHost } from './views'

type RequestDetails = Parameters<
  NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>
>[3]
type CheckDetails = Parameters<
  NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>
>[3]

/** How long the empty file a save dialog leaves behind counts as "just chosen". */
const FRESH_SAVE_MS = 30_000

/**
 * What the core's prompt needs to know about an Electron permission request: the embedding page
 * for requests from frames, the external URL of a protocol launch, the file of a File System
 * Access request.
 */
export function permissionRequestDetails(
  webContents: WebContents | null,
  details: RequestDetails
): PermissionRequestDetails {
  const out: PermissionRequestDetails = {}
  const top = webContents && !webContents.isDestroyed() ? webContents.getURL() : ''
  if (!details.isMainFrame && top) out.embedderUrl = top
  if ('externalURL' in details && details.externalURL) out.externalUrl = details.externalURL
  if ('filePath' in details && details.filePath !== undefined) {
    out.filePath = details.filePath
    out.isDirectory = details.isDirectory
    out.fileAccessType = details.fileAccessType
  }
  return out
}

/**
 * What the core's check needs to know: the embedding page for frames and, for a File System
 * Access handle, the entry and direction plus two facts Electron does not pass on – whether a
 * page of the site has seen a gesture (the check may then ask) and whether the file was just
 * chosen in a save dialog (Chromium empties it on the spot, before the page can touch it).
 */
export function permissionCheckDetails(
  permission: string,
  requestingOrigin: string,
  details: CheckDetails,
  browser: Browser,
  freshlyEmptied: (path: string) => boolean = isFreshlyEmptied
): PermissionRequestDetails {
  const out: PermissionRequestDetails = {}
  if (details.embeddingOrigin) out.embedderUrl = details.embeddingOrigin
  if (permission === 'fileSystem' && details.filePath !== undefined) {
    out.filePath = details.filePath
    out.isDirectory = details.isDirectory
    out.fileAccessType = details.fileAccessType
    out.pageActivated = browser.popups.originHasBeenActive(requestingOrigin)
    if (details.fileAccessType === 'writable' && !details.isDirectory)
      out.pickedForSaving = freshlyEmptied(details.filePath)
  }
  return out
}

/** An empty file written within the last moments: what a save dialog leaves behind. */
export function isFreshlyEmptied(path: string, now: number = Date.now()): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size === 0 && now - stat.mtimeMs < FRESH_SAVE_MS
  } catch {
    return false
  }
}

/**
 * The site a client-certificate request is for. Despite its name in the API, Electron passes the
 * server's `host:port` (`localhost:8443`), which `new URL` would read as a scheme; a full URL
 * is accepted as well.
 */
export function hostOf(urlOrHostPort: string): string {
  const text = urlOrHostPort.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  try {
    return new URL(text).host || text
  } catch {
    return text
  }
}

export function describeCertificate(cert: Certificate): ClientCertificateInfo {
  return {
    fingerprint: cert.fingerprint,
    subject: cert.subjectName || cert.subject?.commonName || '',
    issuer: cert.issuerName || cert.issuer?.commonName || '',
    serialNumber: cert.serialNumber,
    validFrom: cert.validStart * 1000,
    validTo: cert.validExpiry * 1000
  }
}

/**
 * HTTP authentication and client-certificate selection: Chromium asks through `app`, the core's
 * prompt service asks the user through the chrome, and the answer goes back into the request.
 */
export function attachSecurityHandlers(browser: Browser, views: ElectronTabViewHost): void {
  app.on('login', (event, webContents, details, authInfo, callback) => {
    event.preventDefault()
    const tabId = webContents ? (views.tabIdForWebContents(webContents) ?? null) : null
    void browser.security
      .httpAuth(
        {
          host: authInfo.host,
          port: authInfo.port,
          realm: authInfo.realm,
          scheme: authInfo.scheme,
          isProxy: authInfo.isProxy,
          secure: authInfo.isProxy ? false : details.url.startsWith('https:')
        },
        tabId
      )
      .then((credentials) => {
        if (credentials) callback(credentials.username, credentials.password)
        else callback()
      })
  })

  app.on('select-client-certificate', (event, webContents, url, certificates, callback) => {
    event.preventDefault()
    const tabId = webContents ? (views.tabIdForWebContents(webContents) ?? null) : null
    const host = hostOf(url)
    // A null certificate continues the request without one (Chromium's
    // ContinueWithCertificate(nullptr)); the typings only spell out the "pick one" case.
    const answer = callback as (certificate: Certificate | null) => void
    void browser.security
      .clientCertificate(host, certificates.map(describeCertificate), tabId)
      .then((index) => answer(index === null ? null : certificates[index]))
  })
}

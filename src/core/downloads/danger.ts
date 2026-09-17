/**
 * Danger classification for downloads, modelled on Chromium's file-type policy
 * (`components/safe_browsing/content/resources/download_file_types.asciipb`, version 69) plus
 * the mixed-content rule (an http download from an https page is blocked behind a warning).
 *
 * Chromium knows three file-type levels. `DANGEROUS` types always warn (a handful of names that
 * hijack programs when they land in a folder). `ALLOW_ON_USER_GESTURE` covers executables,
 * installers, scripts and macro-bearing documents that are also common legitimate downloads;
 * Chromium skips the warning for them when the click came with a user gesture from a site the
 * user already knew. Everything else, including archives (which Safe Browsing inspects), is
 * `NOT_DANGEROUS`. Hosts do not expose the gesture, so Zenium keys the exemption on the referrer
 * alone: a familiar site (visited before today) downloads its installers without a warning.
 *
 * Verdicts from elsewhere (Safe Browsing, an enterprise policy) plug in through
 * `DangerVerdictProvider`; the highest level wins.
 */
import type {
  DownloadDanger,
  DownloadDangerLevel,
  DownloadDangerReason,
  Platform as PlatformOs
} from '../../shared/types'
import { fileExtension } from '../../shared/downloads'

/** Platform letters used by the tables: w Windows, m macOS, l Linux, a Android. */
type PlatformLetter = 'w' | 'm' | 'l' | 'a'

/**
 * Extensions Chromium marks ALLOW_ON_USER_GESTURE, keyed by where they apply: a set of platform
 * letters, `*` for every platform, `*!w` for every platform but Windows (`*!c` excludes only
 * Chrome OS, which Zenium never runs on).
 */
const WARN_UNLESS_FAMILIAR: Array<[platforms: string, extensions: string]> = [
  [
    'w',
    'accda accdb accde accdr ad ade adp app application appref-ms appx appxbundle asp asx bas bat bgi cer chi chm cmd com cpi cpl crt der diagcab diagcfg diagpkg drv eml exe fon fxp gadget grp hlp hta htt inf ins inx iqy isp isu job js jse library-ms lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz mht mhtml mmc mof msc msg msh msh1 msh1xml msh2 msh2xml mshxml msi msix msixbundle msp mst ocx ops paf partial pcd pif plg prf prg ps1 ps1xml ps2 ps2xml psc1 psc2 psm1 pst reg rels rgs scr sct search-ms settingcontent-ms shb shs slk sys u3p url vb vbe vbs vbscript vdx vsd vsdm vsdx vsmacros vss vssm vssx vst vstm vstx vsw vsx vtx website ws wsc wsf wsh xbap xll xml xnk xrm-ms xsd xsl'
  ],
  [
    'm',
    'action applescript as atloc caction cdr command configprofile cpgz dart dc42 definition diskcopy42 dmg dmgpart dvdr dylib fileloc ftploc imgpart inetloc internetconnect mobileconfig mpkg ndif networkconnect osas osax pax scpt scptd seplugin service smi sparsebundle sparseimage toast udif webloc wflow workflow xip'
  ],
  ['lmw', 'efi pl py pyc pyd pyo pyw pyz pyzw rb'],
  ['l', 'deb desktop out pet pup rpm run slp'],
  ['*!w', 'bash csh ksh sh shar tcsh'],
  ['*', 'crx oxt spl swf'],
  ['*!c', 'class jar jnlp'],
  ['a', 'dex'],
  ['al', 'apk'],
  ['lm', 'pkg'],
  ['mw', 'img']
]

/** Extensions Chromium marks DANGEROUS: always warn. */
const ALWAYS_WARN: Array<[platforms: string, extensions: string]> = [
  ['a', 'dng'],
  ['w', 'cfg dll ini local manifest scf']
]

/**
 * What kind of thing a flagged extension is, for the reason and the sentence on the row.
 * Programs and scripts the user is likely to run straight from the panel are `dangerous` (red);
 * disk images, macro-bearing documents and the rest of Chromium's list stay `suspicious` (amber).
 */
const CATEGORIES: Array<[reason: DownloadDangerReason, extensions: string]> = [
  [
    'script',
    'bat cmd js jse vb vbe vbs vbscript ws wsc wsf wsh sct ps1 ps1xml ps2 ps2xml psc1 psc2 psm1 msh msh1 msh2 mshxml msh1xml msh2xml hta sh bash csh ksh tcsh shar py pyc pyd pyo pyw pyz pyzw pl rb applescript scpt scptd as osas osax action workflow wflow command bas'
  ],
  [
    'executable',
    'exe msi msix msixbundle appx appxbundle application appref-ms com scr pif cpl msc msp mst jar jnlp class dex apk deb rpm run out pet pup slp pkg mpkg app dll sys drv ocx efi crx oxt swf spl xbap gadget paf u3p desktop lnk url scf reg inf ins isp job library-ms search-ms settingcontent-ms website shb shs grp'
  ],
  [
    'archive',
    'dmg dmgpart img imgpart cpgz xip pax toast udif ndif smi sparseimage sparsebundle dc42 diskcopy42 dvdr cdr'
  ],
  [
    'office-macro',
    'accda accdb accde accdr ad ade adp mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz xll xnk slk iqy vsmacros'
  ]
]

const RED = new Set<DownloadDangerReason>(['executable', 'script'])

/** Chromium's category for a flagged extension; `file-type` for the rest of its list. */
export function dangerReasonFor(filename: string): DownloadDangerReason {
  const ext = fileExtension(filename)
  const last = ext.includes('.') ? ext.slice(ext.lastIndexOf('.') + 1) : ext
  for (const candidate of ext === last ? [ext] : [ext, last]) {
    for (const [reason, extensions] of CATEGORIES) {
      if (extensions.split(' ').includes(candidate)) return reason
    }
  }
  return 'file-type'
}

/** The sentence the row shows under a flagged download (Chrome's wording, Zenium's name). */
export function dangerMessage(reason: DownloadDangerReason, level: DownloadDangerLevel): string {
  if (level === 'safe') return ''
  switch (reason) {
    case 'executable':
      return 'This type of file can harm your device.'
    case 'script':
      return 'This type of file can run code on your device.'
    case 'archive':
      return 'This disk image can contain programs that harm your device.'
    case 'office-macro':
      return 'This document type can contain macros that harm your device.'
    case 'insecure-download':
      return 'This file was downloaded over an insecure connection.'
    case 'url-verdict':
      return 'Zenium found this file may be dangerous.'
    default:
      return 'This type of file is uncommon and could be unsafe.'
  }
}

/** A complete verdict from its level and reason (providers may leave the sentence to us). */
export function makeDanger(
  level: DownloadDangerLevel,
  reason: DownloadDangerReason,
  message?: string
): DownloadDanger {
  if (level === 'safe') return SAFE
  return { level, reason, message: message || dangerMessage(reason, level) }
}

function toLetter(os: PlatformOs): PlatformLetter {
  switch (os) {
    case 'win32':
      return 'w'
    case 'darwin':
      return 'm'
    case 'android':
      return 'a'
    default:
      return 'l'
  }
}

function applies(platforms: string, letter: PlatformLetter): boolean {
  if (platforms.startsWith('*')) {
    const excluded = platforms.slice(2)
    return !excluded.includes(letter)
  }
  return platforms.includes(letter)
}

function lookup(table: Array<[string, string]>, ext: string, letter: PlatformLetter): boolean {
  for (const [platforms, extensions] of table) {
    if (!applies(platforms, letter)) continue
    if (extensions.split(' ').includes(ext)) return true
  }
  return false
}

export type FileTypePolicy = 'not-dangerous' | 'allow-on-user-gesture' | 'dangerous'

/** Chromium's policy for a file name on a platform (`tar.gz`-style double extensions included). */
export function fileTypePolicy(filename: string, os: PlatformOs): FileTypePolicy {
  const letter = toLetter(os)
  const ext = fileExtension(filename)
  if (!ext) return 'not-dangerous'
  const last = ext.includes('.') ? ext.slice(ext.lastIndexOf('.') + 1) : ext
  for (const candidate of ext === last ? [ext] : [ext, last]) {
    if (lookup(ALWAYS_WARN, candidate, letter)) return 'dangerous'
    if (lookup(WARN_UNLESS_FAMILIAR, candidate, letter)) return 'allow-on-user-gesture'
  }
  return 'not-dangerous'
}

/** Chromium's `auto_open_hint`: flagged types never open automatically, whatever the setting says. */
export function mayAutoOpen(filename: string, os: PlatformOs): boolean {
  return fileTypePolicy(filename, os) === 'not-dangerous'
}

export interface DangerContext {
  url: string
  /** Page the download was started from (empty when there was none). */
  referrer: string
  filename: string
  mimeType: string
  os: PlatformOs
  /** The referrer's site was visited before today (Chromium's user-gesture exemption proxy). */
  referrerFamiliar: boolean
}

/**
 * Chromium blocks downloads an https page fetched over plain http (and follows the whole redirect
 * chain; hosts pass the final URL). `data:` and `blob:` inherit the page's security.
 */
export function isInsecureDownload(url: string, referrer: string): boolean {
  if (!referrer.startsWith('https:')) return false
  return /^http:\/\//i.test(url)
}

export const SAFE: DownloadDanger = { level: 'safe', reason: 'none', message: '' }

/** File-type and mixed-content classification, before any provider verdict. */
export function classifyDownload(context: DangerContext): DownloadDanger {
  if (isInsecureDownload(context.url, context.referrer))
    return makeDanger('suspicious', 'insecure-download')
  const policy = fileTypePolicy(context.filename, context.os)
  if (policy === 'not-dangerous') return SAFE
  if (policy === 'allow-on-user-gesture' && context.referrerFamiliar) return SAFE
  const reason = dangerReasonFor(context.filename)
  const level: DownloadDangerLevel =
    policy === 'dangerous' || RED.has(reason) ? 'dangerous' : 'suspicious'
  return makeDanger(level, reason)
}

const RANK: Record<DownloadDangerLevel, number> = { safe: 0, suspicious: 1, dangerous: 2 }

/** The more severe of two verdicts. */
export function worstDanger(a: DownloadDanger, b: DownloadDanger): DownloadDanger {
  const pick = RANK[b.level] > RANK[a.level] ? b : a
  return makeDanger(pick.level, pick.reason, pick.message)
}

export interface DangerVerdictRequest {
  url: string
  referrer: string
  filename: string
  mimeType: string
  totalBytes: number
}

/**
 * Something that knows more about a download than its file name – Safe Browsing URL and digest
 * checks, an enterprise deny-list. Registered with `DownloadService.addVerdictProvider`; asked
 * once when a download starts. A `null` answer leaves the file-type classification alone; the
 * highest level of all answers wins. Providers that need the finished file can hold their answer
 * until the transfer completes: the service keeps the file quarantined until every verdict is in
 * (or `VERDICT_TIMEOUT_MS` passed).
 */
export interface DangerVerdictProvider {
  verdict(request: DangerVerdictRequest, signal: AbortSignal): Promise<DownloadDanger | null>
}

export const VERDICT_TIMEOUT_MS = 15_000

/**
 * Where providers sign up. A package that ships a verdict source (Safe Browsing, an enterprise
 * policy) calls `register` at start-up; the download service asks everyone registered when a
 * transfer begins. The default instance is shared; tests build their own.
 */
export class DangerVerdictRegistry {
  private readonly providers = new Set<DangerVerdictProvider>()

  /** Returns the matching unregister. */
  register(provider: DangerVerdictProvider): () => void {
    this.providers.add(provider)
    return () => void this.providers.delete(provider)
  }

  all(): DangerVerdictProvider[] {
    return [...this.providers]
  }

  get size(): number {
    return this.providers.size
  }
}

export const dangerVerdicts = new DangerVerdictRegistry()

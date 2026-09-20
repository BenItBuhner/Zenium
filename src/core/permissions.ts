import { JsonStore } from './store/JsonStore'
import type { PermissionPromptHost, StoreIO } from './platform'
import type { PermissionPrompt, PermissionRule } from '../shared/types'
import {
  FILE_SITE,
  MEDIA_ROWS,
  allowOnceFor,
  builtInDefault,
  contentSettingId,
  promptLabelFor,
  type ContentDecision,
  type ContentDefault
} from '../shared/contentSettings'
import { newId } from '../shared/ids'

export type PermissionDecision = PermissionRule['decision']
type Decision = PermissionDecision

interface Persisted {
  version: 1
  decisions: Record<string, PermissionDecision>
}

/** A decision changed: `origin` is null when it was a permission's default. */
export interface PermissionChange {
  permission: string
  origin: string | null
}

/**
 * Rules extensions set (`chrome.contentSettings`), consulted before the user's answers as
 * Chrome's extension provider ranks above its preference provider: the catalogue id of the
 * permission (`geolocation`, `notifications`, `popups`…), the requesting URL and the request's
 * details (the embedding page, for a frame). Null when no extension has a rule for the site.
 */
export type PermissionOverride = (
  permission: string,
  requestingUrl: string,
  details?: PermissionRequestDetails
) => ContentDefault | null

/**
 * The "origin" of a permission's default decision (Chrome's content-setting default). Never a real
 * origin, so `listForOrigin` and `resetOrigin` cannot reach it.
 */
const DEFAULT_ORIGIN = '*'

/** Facts about one request that shape the prompt, or the key the answer is remembered under. */
export interface PermissionRequestDetails {
  /**
   * Tab whose page asks. Prompts queue per tab and go away when it navigates; an "Allow once"
   * lasts while this tab stays on the site.
   */
  tabId?: string
  /** `media`: the capture devices the request is for (both when the host does not say). */
  mediaTypes?: Array<'video' | 'audio'>
  /** Top-level page the request happens in, when the requesting frame is embedded in another site. */
  embedderUrl?: string
  /** `openExternal`: the URL that would be handed to another application. */
  externalUrl?: string
  /** `fileSystem`: the file or directory the page wants and how it wants it. */
  filePath?: string
  isDirectory?: boolean
  fileAccessType?: 'writable' | 'readable'
  /** `fileSystem` checks: a page of the site has seen a gesture, so a refusal may come with a question. */
  pageActivated?: boolean
  /**
   * `fileSystem` checks: the file was chosen in a save dialog a moment ago (the host recognises
   * the file the engine emptied on the spot), which is the user's permission to write it.
   */
  pickedForSaving?: boolean
}

export interface PermissionPromptCopy {
  message: string
  detail: string
  okLabel: string
  cancelLabel: string
}

/**
 * A "Block" for these is a one-time answer: the site can ask again. Refusing to hand a link to
 * another application once should not silence that application on the site for good.
 */
const ONE_SHOT_DENY = new Set(['openExternal'])

/**
 * Chrome blocks a permission for a site once its prompt was dismissed this many times in a row
 * without an answer (the "ignored prompts" embargo).
 */
export const DISMISSALS_BEFORE_BLOCK = 3

/** Longest URL or path shown inside a prompt. */
const MAX_SHOWN = 80

/**
 * Chromium-style permission prompts with per-origin persistence. What a site gets without a
 * decision of its own comes from the content-settings catalogue (`shared/contentSettings`):
 * an answer (fullscreen is granted, USB refused) or a question, which the chrome shows as a
 * non-modal per-tab prompt with Allow / Block / Allow once; the user may change any default in
 * Settings, and every answer is remembered here.
 *
 * Keys are `${origin}|${permission}` where the permission may carry a qualifier after a colon
 * (`openExternal:zoommtg`, `storage-access:https://embedder.example`), so one answer never covers
 * a different scheme or a different embedding site. The origin is the site of `permissionSite`:
 * local files share the one `file://` site, and pages without a site (`zen://`, `chrome-error://`)
 * store nothing and are asked nothing; they get what the catalogue grants without a prompt.
 *
 * `permissions.json` is also the store of record for content settings the user sets without a
 * prompt (ad and tracker blocking per site, and its default): the same `origin|permission` keys,
 * so the site-information sheet lists and resets them like any other decision.
 */
export class PermissionService {
  private decisions: Record<string, PermissionDecision> = {}
  private readonly store: JsonStore<Persisted>
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly listeners = new Set<(change: PermissionChange) => void>()
  /** Files the user chose in a save dialog this session (`origin|path`): writable, as in Chrome. */
  private readonly savedFiles = new Set<string>()
  /** "Allow once" grants: decision keys per tab, dropped when the tab leaves the site or closes. */
  private readonly sessionAllows = new Map<string, Set<string>>()
  /** Prompts dismissed without an answer, per decision key (reset by an answer). */
  private readonly dismissals = new Map<string, number>()
  /** Requests answered from a stored allow this session, per key (the notification review). */
  private readonly hits = new Map<string, number>()
  private override: PermissionOverride | null = null

  constructor(
    io: StoreIO,
    private readonly prompts: PermissionPromptHost,
    private readonly now: () => number = Date.now
  ) {
    this.store = new JsonStore<Persisted>(io, 'permissions.json', 500)
    const data = this.store.readSync()
    if (data?.version === 1 && data.decisions) this.decisions = data.decisions
  }

  /**
   * Synchronous check (`Notification.permission`, or the engine's own status question before it
   * would prompt); never prompts, a question counts as no. File System Access is the one
   * exception, see `checkFileSystem`.
   */
  check(permission: string, requestingOrigin: string, details?: PermissionRequestDetails): boolean {
    if (permission === 'fileSystem') return this.checkFileSystem(requestingOrigin, details ?? {})
    if (permission === 'media')
      return mediaRows(details).every(
        (row) => this.resolve(row, requestingOrigin, details) === 'allow'
      )
    return this.resolve(permission, requestingOrigin, details) === 'allow'
  }

  /**
   * File System Access under Electron: Chromium asks this check for a handle's status and only
   * prompts when the answer is "ask", which a yes-or-no check cannot say, so the request prompt is
   * never reached for a file. Hence: reading what the user picked or dropped is granted (Chrome
   * grants it the same way), a folder's read answer comes from the picker's prompt, a file chosen
   * in a save dialog is writable for the session, and any other write is refused while the user is
   * asked, once the page has been interacted with; the answer is remembered for the site and the
   * page's next attempt gets it.
   */
  private checkFileSystem(requestingOrigin: string, details: PermissionRequestDetails): boolean {
    const stored = this.stored('fileSystem', requestingOrigin, details)
    if (details.fileAccessType === 'readable') return details.isDirectory ? stored !== 'deny' : true
    if (stored) return stored === 'allow'
    const origin = permissionSite(requestingOrigin)
    if (!origin) return false
    const file = details.filePath ? `${origin}|${details.filePath}` : null
    if (file && details.pickedForSaving) this.savedFiles.add(file)
    if (file && this.savedFiles.has(file)) return true
    if (details.pageActivated) void this.decide('fileSystem', requestingOrigin, details)
    return false
  }

  /**
   * What a request comes down to before anyone is asked: the site's own decision, an "Allow
   * once" of the asking tab, the user's default for the permission, or the catalogue's built-in
   * default (`ask` for the prompted ones). A page without a site gets only what needs no prompt.
   */
  resolve(
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): ContentDefault {
    const origin = permissionSite(requestingUrl)
    if (!origin) return this.siteless(permission, requestingUrl)
    const overridden = this.overridden(permission, requestingUrl, details)
    if (overridden) return overridden
    const key = decisionKey(origin, permission, details)
    const stored = this.decisions[key]
    if (stored) return stored
    if (details?.tabId && this.sessionAllows.get(details.tabId)?.has(key)) return 'allow'
    return this.effectiveDefault(permission)
  }

  /**
   * Extensions' content-setting rules rank above every answer of the user's (Chrome's order of
   * providers); `setOverride` installs the provider, `overridesChanged` tells the listeners the
   * affected permissions may resolve differently now (as a change of the defaults would).
   */
  setOverride(provider: PermissionOverride | null): void {
    this.override = provider
  }

  overridesChanged(permissions: readonly string[]): void {
    for (const permission of permissions) this.notify({ permission, origin: null })
  }

  private overridden(
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): ContentDefault | null {
    if (!this.override) return null
    return this.override(qualifiedPermission(permission, details), requestingUrl, details)
  }

  /**
   * A page without a site (`zen://`, `chrome-error://`, `data:`, `about:blank`) cannot be asked
   * about or remembered, so it gets what would be granted without a prompt anyway (fullscreen,
   * pointer and keyboard lock, a clipboard write after a click) and is refused whatever a site
   * would be asked about. Something that is not a URL at all gets nothing.
   */
  private siteless(permission: string, url: string): ContentDecision {
    if (!safeUrl(url)) return 'deny'
    return this.effectiveDefault(permission) === 'allow' ? 'allow' : 'deny'
  }

  /**
   * The remembered answer for origin + permission (or the permission's default, see `defaultFor`),
   * or null when the site would be asked.
   */
  stored(
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): PermissionDecision | null {
    const origin = permissionSite(requestingUrl)
    if (!origin) return null
    const overridden = this.overridden(permission, requestingUrl, details)
    if (overridden) return overridden === 'ask' ? null : overridden
    return (
      this.decisions[decisionKey(origin, permission, details)] ??
      this.defaultFor(permission) ??
      null
    )
  }

  /** Remember an answer without prompting ("Always allow pop-ups on this site"). */
  remember(
    permission: string,
    requestingUrl: string,
    decision: PermissionDecision,
    details?: PermissionRequestDetails
  ): void {
    const origin = permissionSite(requestingUrl)
    if (!origin) return
    const key = decisionKey(origin, permission, details)
    this.update(key, decision, changeFor(key))
  }

  /** Forget one origin's answer for a permission: the site is asked (or blocked) again. */
  forget(permission: string, requestingUrl: string, details?: PermissionRequestDetails): void {
    const origin = permissionSite(requestingUrl)
    if (!origin) return
    const key = decisionKey(origin, permission, details)
    this.update(key, null, changeFor(key))
  }

  /** Every remembered per-site answer (Settings lists and revokes them); defaults are not sites. */
  rules(): PermissionRule[] {
    const out: PermissionRule[] = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0) continue
      const origin = key.slice(0, split)
      if (origin === DEFAULT_ORIGIN) continue
      out.push({ origin, permission: key.slice(split + 1), decision })
    }
    return out.sort(
      (a, b) => a.permission.localeCompare(b.permission) || a.origin.localeCompare(b.origin)
    )
  }

  /** Forget one rule as Settings lists it (`permission` is the stored, qualified name). */
  forgetRule(origin: string, permission: string): void {
    const key = `${origin}|${permission}`
    this.update(key, null, changeFor(key))
  }

  /**
   * Decide a permission request: the resolved answer when there is one, else the prompt, shown
   * once per origin + permission however many requests wait on it. Types the catalogue never
   * asks about (pop-ups, unknown names) are refused without a question.
   */
  async decide(
    permission: string,
    requestingUrl: string,
    details: PermissionRequestDetails = {}
  ): Promise<boolean> {
    const origin = permissionSite(requestingUrl)
    if (!origin) return this.check(permission, requestingUrl, details)
    if (permission === 'media') return this.decideMedia(origin, details)
    const outcome = this.resolve(permission, requestingUrl, details)
    const key = decisionKey(origin, permission, details)
    if (outcome !== 'ask') {
      if (outcome === 'allow') this.recordHit(key)
      return outcome === 'allow'
    }
    if (promptLabelFor(permission) === null) return false
    return this.askOnce(key, () => this.prompt(permission, origin, [key], details))
  }

  /**
   * A `media` request asks for the camera and microphone rows it names: any row the site is
   * refused refuses the request, and only the rows still open are asked about (one prompt,
   * "camera and microphone" when both are).
   */
  private async decideMedia(origin: string, details: PermissionRequestDetails): Promise<boolean> {
    const rows = mediaRows(details)
    const outcomes = rows.map((row) => this.resolve(row, origin, details))
    if (outcomes.some((outcome) => outcome === 'deny')) return false
    const open = rows.filter((_row, i) => outcomes[i] === 'ask')
    if (open.length === 0) {
      for (const row of rows) this.recordHit(decisionKey(origin, row, details))
      return true
    }
    const keys = open.map((row) => decisionKey(origin, row, details))
    const permission = open.length === 1 ? open[0] : 'media'
    return this.askOnce(keys.join('+'), () => this.prompt(permission, origin, keys, details))
  }

  /** Concurrent requests for the same question share one prompt and its answer. */
  private askOnce(pendingKey: string, ask: () => Promise<boolean>): Promise<boolean> {
    const inFlight = this.pending.get(pendingKey)
    if (inFlight) return inFlight
    const promise = ask().finally(() => this.pending.delete(pendingKey))
    this.pending.set(pendingKey, promise)
    return promise
  }

  private async prompt(
    permission: string,
    origin: string,
    keys: string[],
    details: PermissionRequestDetails
  ): Promise<boolean> {
    const copy = permissionPromptCopy(permission, origin, details)
    const request: PermissionPrompt = {
      id: newId('perm'),
      tabId: details.tabId ?? null,
      origin,
      permission: contentSettingId(permission),
      message: copy.message,
      detail: copy.detail,
      allowLabel: copy.okLabel,
      blockLabel: copy.cancelLabel,
      allowOnce: allowOnceFor(permission),
      requestedAt: this.now()
    }
    const answer = await this.prompts.show(request)
    switch (answer) {
      // Withdrawn (the page navigated away): refused this once, nothing counted or remembered.
      case null:
        return false
      case 'allow':
        for (const key of keys) {
          this.dismissals.delete(key)
          this.update(key, 'allow', changeFor(key))
        }
        return true
      case 'allow-once':
        for (const key of keys) this.dismissals.delete(key)
        if (details.tabId) {
          const grants = this.sessionAllows.get(details.tabId) ?? new Set<string>()
          for (const key of keys) grants.add(key)
          this.sessionAllows.set(details.tabId, grants)
        }
        return true
      case 'block':
        for (const key of keys) {
          this.dismissals.delete(key)
          if (!ONE_SHOT_DENY.has(permission)) this.update(key, 'deny', changeFor(key))
        }
        return false
      case 'dismiss':
        for (const key of keys) {
          const count = (this.dismissals.get(key) ?? 0) + 1
          if (count >= DISMISSALS_BEFORE_BLOCK && !ONE_SHOT_DENY.has(permission)) {
            this.dismissals.delete(key)
            this.update(key, 'deny', changeFor(key))
          } else this.dismissals.set(key, count)
        }
        return false
    }
  }

  private recordHit(key: string): void {
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1)
  }

  /**
   * Sites whose stored allow for `permission` answered requests this session, busiest first:
   * for notifications, how often a site showed one (each display is a request to the engine).
   */
  activity(permission: string): Array<{ origin: string; count: number }> {
    const suffix = `|${permission}`
    const out: Array<{ origin: string; count: number }> = []
    for (const [key, count] of this.hits) {
      if (!key.endsWith(suffix)) continue
      const origin = key.slice(0, -suffix.length)
      if (origin && origin !== DEFAULT_ORIGIN) out.push({ origin, count })
    }
    return out.sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))
  }

  reset(): void {
    const keys = Object.keys(this.decisions)
    this.decisions = {}
    this.savedFiles.clear()
    this.sessionAllows.clear()
    this.dismissals.clear()
    this.store.write({ version: 1, decisions: this.decisions })
    for (const key of keys) this.notify(changeFor(key))
  }

  /**
   * Clear browsing data's "Site settings": every per-site decision goes, the defaults the user
   * chose in Settings stay (Chrome clears exceptions the same way).
   */
  resetSites(): void {
    const removed = Object.keys(this.decisions).filter(
      (key) => key.slice(0, key.lastIndexOf('|')) !== DEFAULT_ORIGIN
    )
    if (removed.length === 0 && this.savedFiles.size === 0 && this.sessionAllows.size === 0) return
    for (const key of removed) delete this.decisions[key]
    this.savedFiles.clear()
    this.sessionAllows.clear()
    this.dismissals.clear()
    this.store.write({ version: 1, decisions: this.decisions })
    for (const key of removed) this.notify(changeFor(key))
  }

  // ---------------------------------------------------------------------------
  // Tab lifecycle: "Allow once" grants live with the tab and the site it is on
  // ---------------------------------------------------------------------------

  /** The tab committed a document of `url`: grants for other sites end. */
  onTabNavigated(tabId: string, url: string): void {
    const grants = this.sessionAllows.get(tabId)
    if (!grants) return
    const origin = permissionSite(url)
    for (const key of grants) if (!origin || !key.startsWith(`${origin}|`)) grants.delete(key)
    if (grants.size === 0) this.sessionAllows.delete(tabId)
  }

  onTabGone(tabId: string): void {
    this.sessionAllows.delete(tabId)
  }

  // ---------------------------------------------------------------------------
  // Content settings: decisions made in Settings or the site-information sheet, no prompt
  // ---------------------------------------------------------------------------

  /** The decision stored for an origin and permission (no default, no prompt). */
  get(permission: string, requestingOrigin: string): Decision | undefined {
    const origin = permissionSite(requestingOrigin)
    return origin ? this.decisions[`${origin}|${permission}`] : undefined
  }

  /** Remember a decision for an origin, or forget it with `null`. */
  set(permission: string, requestingOrigin: string, decision: Decision | null): void {
    const origin = permissionSite(requestingOrigin)
    if (!origin) return
    this.update(`${origin}|${permission}`, decision, { permission, origin })
  }

  /**
   * A permission's default for origins without a decision of their own (`undefined`: none set).
   * Defaults are kept per catalogue row: a qualified or aliased name reads its row's.
   */
  defaultFor(permission: string): Decision | undefined {
    return this.decisions[`${DEFAULT_ORIGIN}|${contentSettingId(permission)}`]
  }

  setDefault(permission: string, decision: Decision | null): void {
    const row = contentSettingId(permission)
    this.update(`${DEFAULT_ORIGIN}|${row}`, decision, { permission: row, origin: null })
  }

  /** The default sites without a decision get: the user's, else the catalogue's. */
  effectiveDefault(permission: string): ContentDefault {
    return this.defaultFor(permission) ?? builtInDefault(permission)
  }

  /**
   * Settings chose a default. `ask`, and the built-in default itself, clear the stored one so
   * the catalogue answers again (and the blocking engine's master switch reads its row as before).
   */
  chooseDefault(permission: string, decision: ContentDefault): void {
    const keep = decision !== 'ask' && decision !== builtInDefault(permission)
    this.setDefault(permission, keep ? decision : null)
  }

  /** The effective default of every catalogue row (Settings › Site settings). */
  defaults(rows: Iterable<string>): Record<string, ContentDefault> {
    const out: Record<string, ContentDefault> = {}
    for (const id of rows) out[id] = this.effectiveDefault(id)
    return out
  }

  /** Every origin with its own decision for `permission` (the exception lists in Settings). */
  listForPermission(permission: string): Array<{ origin: string; decision: Decision }> {
    const suffix = `|${permission}`
    const out: Array<{ origin: string; decision: Decision }> = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      if (!key.endsWith(suffix)) continue
      const origin = key.slice(0, -suffix.length)
      if (origin && origin !== DEFAULT_ORIGIN && !origin.includes('|'))
        out.push({ origin, decision })
    }
    return out.sort((a, b) => a.origin.localeCompare(b.origin))
  }

  /** Called after any decision changes (prompt, set, reset); returns the unsubscribe function. */
  subscribe(listener: (change: PermissionChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(key: string, decision: Decision | null, change: PermissionChange): void {
    // A stored answer supersedes any "Allow once" for the same question.
    for (const grants of this.sessionAllows.values()) grants.delete(key)
    if ((this.decisions[key] ?? null) === decision) return
    if (decision === null) delete this.decisions[key]
    else this.decisions[key] = decision
    this.store.write({ version: 1, decisions: this.decisions })
    this.notify(change)
  }

  private notify(change: PermissionChange): void {
    for (const listener of [...this.listeners]) listener(change)
  }

  /** Every remembered decision for an origin (the site-information sheet lists these). */
  listForOrigin(
    requestingOrigin: string
  ): Array<{ permission: string; decision: PermissionDecision }> {
    const origin = permissionSite(requestingOrigin)
    if (!origin) return []
    const out: Array<{ permission: string; decision: PermissionDecision }> = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0 || key.slice(0, split) !== origin) continue
      out.push({ permission: key.slice(split + 1), decision })
    }
    return out.sort((a, b) => a.permission.localeCompare(b.permission))
  }

  /** Forget the decisions of an origin (one permission, or all of them): the site asks again. */
  resetOrigin(requestingOrigin: string, permission?: string): void {
    const origin = permissionSite(requestingOrigin)
    if (!origin) return
    const removed: string[] = []
    for (const key of Object.keys(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0 || key.slice(0, split) !== origin) continue
      if (permission !== undefined && key.slice(split + 1) !== permission) continue
      delete this.decisions[key]
      removed.push(key)
    }
    if (permission === undefined || permission === 'fileSystem') {
      for (const file of this.savedFiles)
        if (file.startsWith(`${origin}|`)) this.savedFiles.delete(file)
    }
    for (const grants of this.sessionAllows.values()) {
      for (const key of grants) {
        if (!key.startsWith(`${origin}|`)) continue
        if (permission === undefined || key.slice(origin.length + 1) === permission)
          grants.delete(key)
      }
    }
    if (removed.length === 0) return
    this.store.write({ version: 1, decisions: this.decisions })
    for (const key of removed) this.notify(changeFor(key))
  }
}

/** The camera / microphone rows a `media` request names (both when the host does not say). */
function mediaRows(details?: PermissionRequestDetails): string[] {
  const types = details?.mediaTypes
  if (!types || types.length === 0) return [...MEDIA_ROWS]
  const rows: string[] = []
  if (types.includes('video')) rows.push('camera')
  if (types.includes('audio')) rows.push('microphone')
  return rows.length > 0 ? rows : [...MEDIA_ROWS]
}

function changeFor(key: string): PermissionChange {
  const split = key.lastIndexOf('|')
  const origin = key.slice(0, split)
  return { permission: key.slice(split + 1), origin: origin === DEFAULT_ORIGIN ? null : origin }
}

/** The stored key for a request; qualifiers keep unrelated answers apart. */
export function decisionKey(
  origin: string,
  permission: string,
  details?: PermissionRequestDetails
): string {
  return `${origin}|${qualifiedPermission(permission, details)}`
}

export function qualifiedPermission(
  permission: string,
  details?: PermissionRequestDetails
): string {
  if (permission === 'openExternal') {
    const scheme = schemeOf(details?.externalUrl ?? '')
    return scheme ? `openExternal:${scheme}` : permission
  }
  if (permission === 'storage-access') {
    const embedder = safeOrigin(details?.embedderUrl ?? '')
    return embedder && embedder !== 'null' ? `storage-access:${embedder}` : permission
  }
  // Viewing the folders a site is handed and editing what it is handed are separate answers.
  if (permission === 'fileSystem' && details?.fileAccessType === 'readable')
    return 'fileSystem:read'
  // Engine variants of a row (approximate location, periodic background sync) share its answer.
  return permission.includes(':') ? permission : contentSettingId(permission)
}

/** The words of a permission prompt, shared by every host so the copy matches everywhere. */
export function permissionPromptCopy(
  permission: string,
  origin: string,
  details: PermissionRequestDetails = {}
): PermissionPromptCopy {
  const site = displayOrigin(origin)
  const remembered = 'Your choice is remembered for this site.'
  switch (permission) {
    case 'openExternal': {
      const scheme = schemeOf(details.externalUrl ?? '')
      const what = scheme ? `${scheme}: links in another app` : 'another app'
      const link = details.externalUrl ? `\n${shorten(details.externalUrl)}` : ''
      const scope = scheme ? `${scheme}: links on this site` : 'this site'
      return {
        message: `Allow ${site} to open ${what}?`,
        detail: `Zenium hands the link to an application outside the browser.${link}\nChoosing Open is remembered for ${scope}.`,
        okLabel: 'Open',
        cancelLabel: 'Cancel'
      }
    }
    case 'fileSystem': {
      const target = details.filePath
        ? `"${shorten(basename(details.filePath))}"`
        : details.isDirectory
          ? 'this folder'
          : 'this file'
      const message =
        details.fileAccessType === 'readable'
          ? `Allow ${site} to view ${details.isDirectory ? `the files in ${target}` : target}?`
          : `Allow ${site} to save changes to ${target}?`
      const scope =
        details.fileAccessType === 'readable'
          ? 'read everything in the folders you pick on it'
          : 'edit the files and folders you pick on it'
      return {
        message,
        detail: `The site can ${scope} until you take the permission away. ${remembered}`,
        okLabel: details.fileAccessType === 'readable' ? 'View files' : 'Save changes',
        cancelLabel: 'Block'
      }
    }
    case 'storage-access': {
      const embedder = safeOrigin(details.embedderUrl ?? '')
      const where =
        embedder && embedder !== 'null' ? ` while you are on ${displayOrigin(embedder)}` : ''
      return {
        message: `Allow ${site} to use cookies and site data it has stored${where}?`,
        detail: `${site} is embedded in the page and wants to see you as signed in there. ${remembered}`,
        okLabel: 'Allow',
        cancelLabel: 'Block'
      }
    }
    default: {
      const label = promptLabelFor(permission) ?? `use "${permission}"`
      return {
        message: `Allow ${site} to ${label}?`,
        detail: remembered,
        okLabel: 'Allow',
        cancelLabel: 'Block'
      }
    }
  }
}

/**
 * `https://example.com` → `example.com`; local files are `file:///`, as Chrome names their site;
 * other schemes keep their prefix so they stay honest.
 */
export function displayOrigin(origin: string): string {
  if (origin === FILE_SITE) return 'file:///'
  return origin.replace(/^https:\/\//, '')
}

export function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
  return m ? m[1].toLowerCase() : ''
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed
}

function shorten(text: string): string {
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * The site a page's permissions are decided for and remembered under: a web page's origin;
 * `FILE_SITE` for every local file, whose origin is opaque (`new URL('file:///x').origin` is
 * 'null') but which Chrome treats as one site; null for pages that have no site to remember
 * anything for (`zen://`, `chrome-error://`, `data:`, `about:blank`) and for what is not a URL.
 */
export function permissionSite(url: string): string | null {
  const parsed = safeUrl(url)
  if (!parsed) return null
  if (parsed.protocol === 'file:') return FILE_SITE
  return parsed.origin && parsed.origin !== 'null' ? parsed.origin : null
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

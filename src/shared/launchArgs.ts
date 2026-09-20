/**
 * Command-line and OS handoff parsing shared by the desktop hosts: `zenium [flags] [urls|files]`
 * from the initial argv, a second instance, a file-association or protocol launch. Pure – no Node
 * `path` module – so Windows and POSIX paths are handled by hand and the renderer can test it.
 */
import { inputToUrl } from './url'

/** Where launch URLs go: the focused window, a new synced window, a blank one or a private one. */
export type LaunchWindowMode = 'current' | 'new' | 'blank' | 'private'

export interface LaunchArgs {
  /** Navigable URLs in command-line order; file paths are already `file://` URLs. */
  urls: string[]
  window: LaunchWindowMode
  /** `--make-default-browser`: the Windows registration's ReinstallCommand (build/installer.nsh). */
  makeDefault: boolean
  /**
   * `--app=<url>` (Chrome's app mode, what an installed web app's launcher runs): the page opens
   * in a standalone app window of its own instead of a tab. Null without the flag.
   */
  app: string | null
}

const MAKE_DEFAULT_FLAG = '--make-default-browser'
const APP_FLAG = '--app='

/** Zen Browser ships `--blank-window` and `--private-window`; Chrome's spellings are accepted too. */
const WINDOW_FLAGS: Record<string, LaunchWindowMode> = {
  '--new-window': 'new',
  '--blank-window': 'blank',
  '--private-window': 'private',
  '--incognito': 'private',
  '--inprivate': 'private'
}

/** A more specific window kind wins when several flags are given. */
const WINDOW_RANK: Record<LaunchWindowMode, number> = { current: 0, new: 1, blank: 2, private: 3 }

/** Extensions Zenium registers for; a bare `name.ext` argument with one of these is a file. */
export const DOCUMENT_EXTENSIONS = [
  'htm',
  'html',
  'shtml',
  'xht',
  'xhtml',
  'mhtml',
  'mht',
  'svg',
  'webp',
  'avif',
  'pdf'
]

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

export function parseLaunchArgs(argv: readonly string[], cwd: string): LaunchArgs {
  const urls: string[] = []
  let window: LaunchWindowMode = 'current'
  let makeDefault = false
  let app: string | null = null
  for (const raw of argv) {
    const arg = unquote(raw)
    if (!arg) continue
    const flag = WINDOW_FLAGS[arg.toLowerCase()]
    if (flag) {
      if (WINDOW_RANK[flag] > WINDOW_RANK[window]) window = flag
      continue
    }
    if (arg.toLowerCase() === MAKE_DEFAULT_FLAG) {
      makeDefault = true
      continue
    }
    if (arg.toLowerCase().startsWith(APP_FLAG)) {
      // The launcher's value may itself be quoted (`--app="https://…"`), or the whole argument
      // may be (`"--app=https://…"`); the last flag wins.
      const trimmed = raw.trim()
      const value = trimmed.toLowerCase().startsWith(APP_FLAG)
        ? unquote(trimmed.slice(APP_FLAG.length))
        : arg.slice(APP_FLAG.length)
      const url = launchArgToUrl(value, cwd)
      if (url) app = url
      continue
    }
    // Chromium switches (`--no-sandbox`, `--original-process-start-time=…`) and the `-psn_…`
    // argument macOS used to add for Finder launches are not documents.
    if (arg.startsWith('-')) continue
    const url = launchArgToUrl(arg, cwd)
    if (url) urls.push(url)
  }
  return { urls, window, makeDefault, app }
}

/**
 * One positional argument as a URL: web and `file:` URLs pass through, absolute and relative
 * paths become `file:///…`, a bare host becomes `https://host`; anything else (other schemes,
 * plain words) is dropped.
 */
export function launchArgToUrl(arg: string, cwd: string): string | null {
  if (WINDOWS_DRIVE_RE.test(arg) || arg.startsWith('\\\\') || arg.startsWith('/'))
    return pathToFileUrl(arg)
  const scheme = SCHEME_RE.exec(arg)?.[1].toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'file') return arg
    return null
  }
  if (looksLikeRelativePath(arg)) return pathToFileUrl(resolvePath(cwd, arg))
  const url = inputToUrl(arg)
  return url && /^https?:\/\//.test(url) ? url : null
}

/**
 * `file:` URL for an absolute path. Windows drives become `file:///C:/…`, UNC shares
 * `file://server/share/…`; every segment is percent-encoded so spaces, `#`, `?` and `%` survive.
 */
export function pathToFileUrl(path: string): string {
  if (WINDOWS_DRIVE_RE.test(path)) {
    const slashed = path.replace(/\\/g, '/')
    return `file:///${slashed[0].toUpperCase()}:${encodePath(slashed.slice(2))}`
  }
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const rest = path.slice(2).replace(/\\/g, '/')
    const slash = rest.indexOf('/')
    const host = slash < 0 ? rest : rest.slice(0, slash)
    const tail = slash < 0 ? '/' : rest.slice(slash)
    return `file://${host}${encodePath(tail)}`
  }
  return `file://${encodePath(path)}`
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Strip the quotes a `"%1"` shell command or a hand-typed command line may leave on an argument. */
function unquote(raw: string): string {
  let arg = raw.trim()
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1)
  else if (arg.endsWith('"') && !arg.startsWith('"')) arg = arg.slice(0, -1)
  return arg.trim()
}

function looksLikeRelativePath(arg: string): boolean {
  if (/^\.{1,2}([\\/]|$)/.test(arg)) return true
  const last = arg.split(/[\\/]/).pop() ?? ''
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return false
  return DOCUMENT_EXTENSIONS.includes(last.slice(dot + 1).toLowerCase())
}

/** Join `rel` onto `cwd` and fold `.` / `..` segments, on either path syntax. */
function resolvePath(cwd: string, rel: string): string {
  const windows = WINDOWS_DRIVE_RE.test(cwd) || cwd.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  let root: string
  let body: string
  if (WINDOWS_DRIVE_RE.test(cwd)) {
    root = `${cwd[0].toUpperCase()}:${separator}`
    body = cwd.slice(3)
  } else if (cwd.startsWith('\\\\')) {
    const parts = cwd.slice(2).split(/[\\/]+/)
    root = `\\\\${parts.slice(0, 2).join('\\')}\\`
    body = parts.slice(2).join('\\')
  } else {
    root = '/'
    body = cwd
  }
  const segments: string[] = []
  for (const segment of `${body}${separator}${rel}`.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return root + segments.join(separator)
}

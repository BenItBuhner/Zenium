import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { AgentSkillStatus, AgentSkillTarget } from '../../shared/types'
import type { AgentSkillsHost, StoreIO } from '../../core/platform'
import skillMarkdown from '../../../resources/skills/zenium-browser/SKILL.md?raw'

/**
 * The `zenium-browser` Agent Skill (`resources/skills/zenium-browser/SKILL.md`, the open Agent
 * Skills format Claude Code, Cursor, Codex, Gemini CLI, Copilot CLI and OpenCode read) and its
 * one-click install into each coding harness's global skills directory. Desktop only: the
 * harnesses live on the same machine as the browser, and the Android host never sees this
 * module.
 *
 * Every install is a real directory `<skills dir>/zenium-browser/` with real files (Codex skips
 * symlinks), the skill's `metadata.version` stamped with the app's version. A manifest in the
 * profile (`zen/skills.json`) remembers what was written and its hashes, so an uninstall removes
 * only what is still Zenium's – a copy the user edited stays, and the status says so – and an
 * app update rewrites every installed copy once, at the next start.
 */

/** The skill directory's name; the spec requires it to equal the frontmatter `name`. */
export const SKILL_NAME = 'zenium-browser'
/** The manifest's document name under the profile's `zen/` directory. */
export const SKILLS_MANIFEST = 'skills.json'

/** One file of the skill as shipped: its path inside the skill directory and its text. */
export interface SkillFile {
  path: string
  text: string
}

/** The shipped skill: `SKILL.md` (and `references/…` when the body outgrows the file). */
export const SKILL_FILES: readonly SkillFile[] = [{ path: 'SKILL.md', text: skillMarkdown }]

/** Where a harness reads user-level skills from, relative to the home directory. */
export interface SkillTargetSpec {
  id: string
  label: string
  /** Path segments of the skills directory under `~`. */
  skillsDir: readonly string[]
  /** The harness is on this machine when any of these directories (under `~`) exists. */
  detect: readonly (readonly string[])[]
}

/**
 * Targets researched 2026-09-24. Claude Code reads only its own directory (not `.agents`);
 * Cursor's own; Codex still reads its own (its preferred location is the shared one); the
 * shared `~/.agents/skills/` is the open standard's folder, read by Codex, Cursor, Gemini CLI,
 * GitHub Copilot CLI and OpenCode – one row, detected when any of those harnesses is present.
 */
export const SKILL_TARGETS: readonly SkillTargetSpec[] = [
  { id: 'claude', label: 'Claude Code', skillsDir: ['.claude', 'skills'], detect: [['.claude']] },
  { id: 'cursor', label: 'Cursor', skillsDir: ['.cursor', 'skills'], detect: [['.cursor']] },
  { id: 'codex', label: 'Codex', skillsDir: ['.codex', 'skills'], detect: [['.codex']] },
  {
    id: 'agents',
    label: 'Shared skills folder',
    skillsDir: ['.agents', 'skills'],
    detect: [['.agents'], ['.gemini'], ['.copilot'], ['.config', 'opencode']]
  }
]

interface ManifestFile {
  path: string
  sha256: string
}

interface ManifestEntry {
  target: string
  dir: string
  files: ManifestFile[]
}

/** `zen/skills.json`: which app version wrote the installed copies, and what it wrote where. */
export interface SkillsManifest {
  version: string
  installed: ManifestEntry[]
}

export interface SkillInstallerOptions {
  /** The home directory the harnesses' folders are under (`os.homedir()`; a test's temp dir). */
  home?: string
  /** The app's version, stamped into every installed copy and recorded in the manifest. */
  version: string
  /** The profile's document store, for the manifest. */
  io: StoreIO
  /** The skill's files; the shipped ones unless a test brings its own. */
  files?: readonly SkillFile[]
  targets?: readonly SkillTargetSpec[]
}

/** Vite's `?raw` on the main bundle: the skill's text, for the tests that read what ships. */
export function shippedSkill(): string {
  return skillMarkdown
}

/**
 * Stamp the frontmatter's `metadata.version` with the app's version, so an installed copy says
 * which Zenium wrote it (the file in the repository carries the version of its last release).
 */
export function stampVersion(text: string, version: string): string {
  const end = frontmatterEnd(text)
  if (end < 0) return text
  const head = text.slice(0, end)
  const stamped = head.replace(/^(\s+version:\s*).*$/m, `$1${version}`)
  return stamped + text.slice(end)
}

/** Index just past the frontmatter's closing `---` line; -1 when the text has none. */
function frontmatterEnd(text: string): number {
  if (!text.startsWith('---\n')) return -1
  const close = text.indexOf('\n---\n', 4)
  return close < 0 ? -1 : close + '\n---\n'.length
}

/** The `metadata.version` of an installed copy, or null when the file has none. */
export function versionOf(text: string): string | null {
  const end = frontmatterEnd(text)
  if (end < 0) return null
  const m = /^\s+version:\s*(\S+)\s*$/m.exec(text.slice(0, end))
  return m ? m[1] : null
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `~/.claude/skills/zenium-browser` for the rows, whatever the OS's separator. */
export function displayPath(home: string, dir: string): string {
  const rel = relative(home, dir)
  if (!rel || rel.startsWith('..')) return dir
  return `~/${rel.split(sep).join('/')}`
}

/**
 * The installer behind Settings → AI Agents → Agent skill. Every operation ends with a fresh
 * status; failures land in `status.error` (or a target's `note`) rather than being thrown, since
 * the startup refresh runs unattended.
 */
export class SkillInstaller implements AgentSkillsHost {
  private readonly home: string
  private readonly version: string
  private readonly io: StoreIO
  private readonly files: readonly SkillFile[]
  private readonly targets: readonly SkillTargetSpec[]
  /** Operations run one after the other: a switch flipped twice must not race itself. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: SkillInstallerOptions) {
    this.home = options.home ?? homedir()
    this.version = options.version
    this.io = options.io
    this.files = options.files ?? SKILL_FILES
    this.targets = options.targets ?? SKILL_TARGETS
  }

  status(options: { sync?: boolean } = {}): Promise<AgentSkillStatus> {
    return this.serial(async () => {
      const manifest = await this.readManifest()
      if (options.sync && manifest.installed.length && manifest.version !== this.version) {
        // An update: every installed copy is rewritten once, then the manifest follows.
        const notes = new Map<string, string>()
        for (const entry of manifest.installed) {
          const spec = this.targets.find((t) => t.id === entry.target)
          if (!spec) continue
          try {
            const written = await this.writeSkill(this.skillDir(spec))
            entry.dir = written.dir
            entry.files = written.files
          } catch (error) {
            notes.set(entry.target, `Could not refresh: ${(error as Error).message}`)
          }
        }
        manifest.version = this.version
        await this.writeManifest(manifest)
        return this.describe(manifest, notes)
      }
      return this.describe(manifest)
    })
  }

  install(targets?: readonly string[]): Promise<AgentSkillStatus> {
    return this.serial(async () => {
      const manifest = await this.readManifest()
      const notes = new Map<string, string>()
      for (const spec of await this.chosen(targets)) {
        try {
          const written = await this.writeSkill(this.skillDir(spec))
          const entry: ManifestEntry = { target: spec.id, ...written }
          const at = manifest.installed.findIndex((e) => e.target === spec.id)
          if (at >= 0) manifest.installed[at] = entry
          else manifest.installed.push(entry)
        } catch (error) {
          notes.set(spec.id, `Could not install: ${(error as Error).message}`)
        }
      }
      manifest.version = this.version
      await this.writeManifest(manifest)
      return this.describe(manifest, notes)
    })
  }

  uninstall(targets?: readonly string[]): Promise<AgentSkillStatus> {
    return this.serial(async () => {
      const manifest = await this.readManifest()
      const notes = new Map<string, string>()
      const wanted = new Set((await this.chosen(targets)).map((t) => t.id))
      const keep: ManifestEntry[] = []
      for (const entry of manifest.installed) {
        if (!wanted.has(entry.target)) {
          keep.push(entry)
          continue
        }
        try {
          const left = await this.removeSkill(entry)
          if (left.length)
            notes.set(
              entry.target,
              `Left in place: ${left.join(', ')} – it was edited since Zenium installed it`
            )
        } catch (error) {
          notes.set(entry.target, `Could not remove: ${(error as Error).message}`)
          keep.push(entry)
        }
      }
      manifest.installed = keep
      await this.writeManifest(manifest)
      return this.describe(manifest, notes)
    })
  }

  // ---------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private skillDir(spec: SkillTargetSpec): string {
    return join(this.home, ...spec.skillsDir, SKILL_NAME)
  }

  /** The named targets, or every detected one when none are named. */
  private async chosen(ids?: readonly string[]): Promise<SkillTargetSpec[]> {
    if (ids && ids.length) {
      const set = new Set(ids)
      return this.targets.filter((t) => set.has(t.id))
    }
    const out: SkillTargetSpec[] = []
    for (const spec of this.targets) if (await this.detected(spec)) out.push(spec)
    return out
  }

  private async detected(spec: SkillTargetSpec): Promise<boolean> {
    for (const segments of spec.detect) if (await exists(join(this.home, ...segments))) return true
    return false
  }

  /** Write every skill file under `dir` (real files, the version stamped) and hash what was written. */
  private async writeSkill(dir: string): Promise<{ dir: string; files: ManifestFile[] }> {
    const files: ManifestFile[] = []
    for (const file of this.files) {
      const text = stampVersion(file.text, this.version)
      const path = join(dir, ...file.path.split('/'))
      await fs.mkdir(dirname(path), { recursive: true })
      // A temp file renamed into place: a harness never reads a half-written skill.
      const tmp = `${path}.${process.pid}.tmp`
      await fs.writeFile(tmp, text, 'utf8')
      await fs.rename(tmp, path)
      files.push({ path: file.path, sha256: sha256(text) })
    }
    return { dir, files }
  }

  /**
   * Remove the files the manifest recorded, as long as their hash still matches – an edited
   * copy is the user's now and stays – then the directories they leave empty. Resolves with the
   * paths left behind.
   */
  private async removeSkill(entry: ManifestEntry): Promise<string[]> {
    const left: string[] = []
    for (const file of entry.files) {
      const path = join(entry.dir, ...file.path.split('/'))
      let current: string | null
      try {
        current = await fs.readFile(path, 'utf8')
      } catch {
        current = null
      }
      if (current === null) continue
      if (sha256(current) !== file.sha256) {
        left.push(file.path)
        continue
      }
      await fs.rm(path, { force: true })
    }
    // Deepest first, so `references/` goes before the skill directory; a directory that still
    // holds something (an edited copy, a user's file) is not ours to remove.
    const dirs = new Set<string>()
    for (const file of entry.files) {
      let d = dirname(join(entry.dir, ...file.path.split('/')))
      while (d.startsWith(entry.dir)) {
        dirs.add(d)
        if (d === entry.dir) break
        d = dirname(d)
      }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      await fs.rmdir(d).catch(() => undefined)
    }
    return left
  }

  private async describe(
    manifest: SkillsManifest,
    notes: Map<string, string> = new Map()
  ): Promise<AgentSkillStatus> {
    const targets: AgentSkillTarget[] = []
    for (const spec of this.targets) {
      const dir = this.skillDir(spec)
      const entry = manifest.installed.find((e) => e.target === spec.id)
      const skillPath = join(dir, 'SKILL.md')
      let onDisk: string | null
      try {
        onDisk = await fs.readFile(skillPath, 'utf8')
      } catch {
        onDisk = null
      }
      const installed = entry !== undefined && onDisk !== null
      let note = notes.get(spec.id) ?? null
      if (!note && !entry && onDisk !== null)
        note = 'A copy Zenium did not install is there; installing replaces it'
      targets.push({
        id: spec.id,
        label: spec.label,
        dir: displayPath(this.home, dir),
        detected: await this.detected(spec),
        installed,
        installedVersion: installed && onDisk !== null ? versionOf(onDisk) : null,
        note
      })
    }
    return { version: this.version, targets, error: null }
  }

  private async readManifest(): Promise<SkillsManifest> {
    try {
      const raw = this.io.read
        ? await this.io.read(SKILLS_MANIFEST)
        : this.io.readSync(SKILLS_MANIFEST)
      if (!raw) return { version: this.version, installed: [] }
      const parsed = JSON.parse(raw) as Partial<SkillsManifest>
      const installed = Array.isArray(parsed.installed)
        ? parsed.installed.filter(
            (e): e is ManifestEntry =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.target === 'string' &&
              typeof e.dir === 'string' &&
              Array.isArray(e.files)
          )
        : []
      return { version: typeof parsed.version === 'string' ? parsed.version : '', installed }
    } catch {
      return { version: this.version, installed: [] }
    }
  }

  private async writeManifest(manifest: SkillsManifest): Promise<void> {
    if (!manifest.installed.length) {
      if (this.io.remove) await this.io.remove(SKILLS_MANIFEST)
      else
        await this.io.write(
          SKILLS_MANIFEST,
          JSON.stringify({ version: manifest.version, installed: [] })
        )
      return
    }
    await this.io.write(SKILLS_MANIFEST, JSON.stringify(manifest, null, 2))
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

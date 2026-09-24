import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStoreIO } from '../../platform/storeIo'
import type { StoreIO, StoreWriteOptions } from '../../../core/platform'
import type { AgentSkillStatus } from '../../../shared/types'
import {
  SKILL_FILES,
  SKILL_NAME,
  SKILL_TARGETS,
  SKILLS_MANIFEST,
  SkillInstaller,
  displayPath,
  failedAt,
  failedToRecord,
  sha256,
  shippedSkill,
  stampVersion,
  versionOf,
  type SkillsManifest
} from '../skills'

/**
 * The `zenium-browser` Agent Skill: the shipped file against the Agent Skills spec and the
 * program's Contract v2 tool surface, and the installer against a temporary home directory –
 * detection by the harnesses' folders, real files with the version stamped, the hashed manifest,
 * an uninstall that spares an edited copy, the once-per-update rewrite, and what a failure says
 * (the folder the row names, never a path) and leaves behind (nothing the record does not know
 * of). The failures are provoked without chmod – CI may run as root – by a file where a folder
 * should be, and by a profile store whose writes refuse.
 */

/** A Node-shaped error: the message carries what must never reach a row. */
function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `${code}: permission denied, open '/home/someone/.config/zenium/zen/skills.json.4242.1.tmp'`
  )
  error.code = code
  return error
}

/** The profile's document store with a switch that makes every write refuse as a read-only profile folder would. */
class RefusingIO implements StoreIO {
  refusing = false

  constructor(private readonly inner: FileStoreIO) {}

  readSync(name: string): string | null {
    return this.inner.readSync(name)
  }

  exists(name: string): boolean {
    return this.inner.exists(name)
  }

  write(name: string, text: string, options?: StoreWriteOptions): Promise<void> {
    if (this.refusing) return Promise.reject(errno('EACCES'))
    return this.inner.write(name, text, options)
  }

  writeSync(name: string, text: string, options?: StoreWriteOptions): void {
    if (this.refusing) throw errno('EACCES')
    this.inner.writeSync(name, text, options)
  }

  remove(name: string): Promise<void> {
    if (this.refusing) return Promise.reject(errno('EACCES'))
    return this.inner.remove(name)
  }
}

/** Nothing a status shows may carry a temp file, an absolute path or a raw error prefix. */
function expectShowable(status: AgentSkillStatus): void {
  const shown = [status.error, ...status.targets.flatMap((t) => [t.label, t.dir, t.note])]
  for (const text of shown) {
    if (text === null) continue
    for (const leak of ['.tmp', '/home/', '/tmp/', 'EACCES:', 'ENOTDIR:'])
      expect(text, `"${text}" carries ${leak}`).not.toContain(leak)
  }
}

/** Every tool of Contract v2 (`internal/mcp-agents/plan.md`), in the order the skill documents them. */
const CONTRACT_V2_TOOLS = [
  'zen_status',
  'zen_session',
  'zen_groups',
  'zen_spaces',
  'zen_mode',
  'zen_history',
  'browser_tabs',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_scroll',
  'browser_select_option',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_read_page',
  'browser_evaluate'
]

/** The frontmatter's top-level scalars and the `metadata` block, without a YAML library. */
function parseFrontmatter(text: string): {
  fields: Map<string, string>
  metadata: Map<string, string>
  body: string
} {
  expect(text.startsWith('---\n')).toBe(true)
  const close = text.indexOf('\n---\n', 4)
  expect(close).toBeGreaterThan(0)
  const lines = text.slice(4, close).split('\n')
  const fields = new Map<string, string>()
  const metadata = new Map<string, string>()
  let inMetadata = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
      expect(m, `frontmatter line "${line}"`).not.toBeNull()
      fields.set(m![1], m![2])
      inMetadata = m![1] === 'metadata' && m![2] === ''
    } else if (inMetadata) {
      const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
      expect(m, `metadata line "${line}"`).not.toBeNull()
      metadata.set(m![1], m![2])
    }
  }
  return { fields, metadata, body: text.slice(close + '\n---\n'.length) }
}

describe('the shipped SKILL.md', () => {
  const text = shippedSkill()
  const { fields, metadata, body } = parseFrontmatter(text)

  it('is bundled from resources/skills/zenium-browser/SKILL.md', async () => {
    const onDisk = await fs.readFile(
      join(__dirname, '../../../../resources/skills/zenium-browser/SKILL.md'),
      'utf8'
    )
    expect(text).toBe(onDisk)
    expect(SKILL_FILES.map((f) => f.path)).toEqual(['SKILL.md'])
  })

  it('keeps the Agent Skills frontmatter constraints', () => {
    // The name is the directory's name: lowercase, hyphens, at most 64 characters.
    expect(fields.get('name')).toBe(SKILL_NAME)
    expect(SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/)
    // One line, third person, under Codex's 500-character limit, with the trigger words.
    const description = fields.get('description') ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(500)
    expect(description).not.toMatch(/^\s*(I|You)\b/)
    for (const word of ['Zenium', 'browser', 'MCP', 'tabs', 'web page', 'screenshot', 'form'])
      expect(description).toContain(word)
    expect(fields.get('license')).toBe('Apache-2.0')
    expect(fields.get('compatibility')).toMatch(/Settings > AI Agents/)
    expect(fields.has('allowed-tools')).toBe(false)
    expect(metadata.get('source')).toBe('zenium')
    expect(metadata.get('version')).toMatch(/^\d+\.\d+\.\d+/)
    // Nothing before the opening `---`, no emoji anywhere.
    expect(text.startsWith('---\nname: ')).toBe(true)
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })

  it('documents every Contract v2 tool under its own heading, in order', () => {
    const headings = [...body.matchAll(/^### (\S+)$/gm)].map((m) => m[1])
    expect(headings).toEqual(CONTRACT_V2_TOOLS)
    for (const tool of CONTRACT_V2_TOOLS) expect(body).toContain(`\`${tool} {`)
  })

  it('teaches the etiquette the program asks for', () => {
    for (const phrase of [
      'zen_status',
      'allowForeign',
      'closeTabs',
      'Notice:',
      'adopt',
      'lease',
      '[ref=e12]',
      'never a position'
    ])
      expect(body).toContain(phrase)
  })
})

describe('stampVersion / versionOf', () => {
  it('rewrites metadata.version inside the frontmatter only', () => {
    const stamped = stampVersion(shippedSkill(), '9.9.9')
    expect(versionOf(stamped)).toBe('9.9.9')
    expect(stamped.split('\n---\n')[1]).toBe(shippedSkill().split('\n---\n')[1])
    expect(stampVersion('no frontmatter\nversion: 1', '2')).toBe('no frontmatter\nversion: 1')
    expect(versionOf('plain text')).toBeNull()
  })
})

describe('displayPath', () => {
  it('shortens the home directory to ~ with forward slashes', () => {
    const home = join(tmpdir(), 'zen-home')
    expect(displayPath(home, join(home, '.claude', 'skills', 'zenium-browser'))).toBe(
      '~/.claude/skills/zenium-browser'
    )
    expect(displayPath(home, '/elsewhere/skills')).toBe('/elsewhere/skills')
  })
})

describe('the failure sentences', () => {
  const folder = '~/.codex/skills/zenium-browser'

  it('name the folder the row names and say why, from the error code', () => {
    expect(failedAt('install', errno('EACCES'), folder)).toBe(
      'Could not install: no permission to write ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('refresh', errno('EPERM'), folder)).toBe(
      'Could not refresh: no permission to write ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('remove', errno('EACCES'), folder)).toBe(
      'Could not remove: no permission to change ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('install', errno('EROFS'), folder)).toBe(
      'Could not install: the disk is read-only at ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('install', errno('ENOSPC'), folder)).toBe(
      'Could not install: the disk is full at ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('install', errno('ENOTDIR'), folder)).toBe(
      'Could not install: something else is in the way at ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('install', errno('EEXIST'), folder)).toBe(
      'Could not install: something else is in the way at ~/.codex/skills/zenium-browser'
    )
    // A code the words do not cover rides along in brackets; no code, no brackets.
    expect(failedAt('install', errno('EIO'), folder)).toBe(
      'Could not install: it could not be written at ~/.codex/skills/zenium-browser (EIO)'
    )
    expect(failedAt('remove', errno('EBUSY'), folder)).toBe(
      'Could not remove: it could not be changed at ~/.codex/skills/zenium-browser (EBUSY)'
    )
    expect(failedAt('install', new Error('plain'), folder)).toBe(
      'Could not install: it could not be written at ~/.codex/skills/zenium-browser'
    )
    expect(failedAt('install', 'not even an error', folder)).toBe(
      'Could not install: it could not be written at ~/.codex/skills/zenium-browser'
    )
  })

  it('say when the record in the profile folder could not be saved', () => {
    expect(failedToRecord('install', errno('EACCES'))).toBe(
      'Could not install: Zenium could not save its record in its profile folder (no permission to write); the copies were removed again.'
    )
    expect(failedToRecord('refresh', errno('ENOSPC'))).toBe(
      'Could not refresh: Zenium could not save its record in its profile folder (the disk is full); the copies were removed again.'
    )
    expect(failedToRecord('remove', errno('EACCES'))).toBe(
      'Could not remove: Zenium could not save its record in its profile folder (no permission to change).'
    )
    expect(failedToRecord('install', errno('EIO'))).toBe(
      'Could not install: Zenium could not save its record in its profile folder (EIO); the copies were removed again.'
    )
  })
})

describe('SkillInstaller', () => {
  let root: string
  let home: string
  let io: RefusingIO
  const version = '0.4.51'
  const make = (v = version): SkillInstaller => new SkillInstaller({ home, version: v, io })
  const manifest = async (): Promise<SkillsManifest | null> => {
    const raw = io.readSync(SKILLS_MANIFEST)
    return raw ? (JSON.parse(raw) as SkillsManifest) : null
  }
  const skillPath = (dir: string): string => join(home, ...dir.split('/'), SKILL_NAME, 'SKILL.md')
  const onDisk = (dir: string): Promise<boolean> =>
    fs.stat(skillPath(dir)).then(
      () => true,
      () => false
    )
  const byId = (status: AgentSkillStatus, id: string): AgentSkillStatus['targets'][number] => {
    const target = status.targets.find((t) => t.id === id)
    if (!target) throw new Error(`no target ${id}`)
    return target
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'zen-skills-'))
    home = join(root, 'home')
    await fs.mkdir(join(home, '.claude'), { recursive: true })
    await fs.mkdir(join(home, '.cursor'), { recursive: true })
    await fs.mkdir(join(home, '.gemini'), { recursive: true })
    io = new RefusingIO(new FileStoreIO(join(root, 'profile', 'zen')))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('detects harnesses by their configuration directories', async () => {
    const status = await make().status()
    expect(status.error).toBeNull()
    expect(status.version).toBe(version)
    expect(status.targets.map((t) => t.id)).toEqual(SKILL_TARGETS.map((t) => t.id))
    const byId = new Map(status.targets.map((t) => [t.id, t]))
    expect(byId.get('claude')?.detected).toBe(true)
    expect(byId.get('cursor')?.detected).toBe(true)
    expect(byId.get('codex')?.detected).toBe(false)
    // The shared folder's row stands for Gemini CLI too.
    expect(byId.get('agents')?.detected).toBe(true)
    expect(status.targets.every((t) => !t.installed && t.installedVersion === null)).toBe(true)
    expect(byId.get('claude')?.dir).toBe('~/.claude/skills/zenium-browser')
    // The rows' labels (§6: no parenthesised aside – the path beneath says `.agents`), and
    // nothing that reaches the UI says "harness" (the #460 gate).
    expect(status.targets.map((t) => t.label)).toEqual([
      'Claude Code',
      'Cursor',
      'Codex',
      'Shared skills folder'
    ])
    expect(byId.get('agents')?.dir).toBe('~/.agents/skills/zenium-browser')
    for (const t of status.targets) expect(`${t.label} ${t.note ?? ''}`).not.toMatch(/harness/i)
    expect(await manifest()).toBeNull()
  })

  it('installs real files into every detected harness and records their hashes', async () => {
    const status = await make().install()
    const installed = status.targets.filter((t) => t.installed).map((t) => t.id)
    expect(installed).toEqual(['claude', 'cursor', 'agents'])
    for (const dir of ['.claude/skills', '.cursor/skills', '.agents/skills']) {
      const stat = await fs.lstat(skillPath(dir))
      expect(stat.isFile()).toBe(true)
      expect(stat.isSymbolicLink()).toBe(false)
      const text = await fs.readFile(skillPath(dir), 'utf8')
      expect(text).toBe(stampVersion(shippedSkill(), version))
      expect(versionOf(text)).toBe(version)
    }
    expect(await fs.stat(join(home, '.codex')).catch(() => null)).toBeNull()
    const m = await manifest()
    expect(m?.version).toBe(version)
    expect(m?.installed.map((e) => e.target)).toEqual(['claude', 'cursor', 'agents'])
    for (const entry of m!.installed) {
      expect(entry.files).toEqual([
        { path: 'SKILL.md', sha256: sha256(stampVersion(shippedSkill(), version)) }
      ])
      expect(entry.dir).toBe(join(home, ...entry.dir.replace(home, '').split(/[\\/]/)))
    }
    expect(status.targets.find((t) => t.id === 'claude')?.installedVersion).toBe(version)
  })

  it('installs into the named targets only, detected or not', async () => {
    const status = await make().install(['codex'])
    expect(status.targets.filter((t) => t.installed).map((t) => t.id)).toEqual(['codex'])
    expect(await fs.readFile(skillPath('.codex/skills'), 'utf8')).toContain('name: zenium-browser')
  })

  it('uninstalls what it wrote and leaves an edited copy in place', async () => {
    const installer = make()
    await installer.install()
    // The user edited Cursor's copy: it is theirs now.
    await fs.appendFile(skillPath('.cursor/skills'), '\n## My notes\n')
    const status = await installer.uninstall()
    expect(status.targets.every((t) => !t.installed)).toBe(true)
    expect(await fs.stat(skillPath('.claude/skills')).catch(() => null)).toBeNull()
    expect(await fs.stat(join(home, '.claude', 'skills', SKILL_NAME)).catch(() => null)).toBeNull()
    // The harness's own skills directory is not ours to remove.
    expect((await fs.stat(join(home, '.claude', 'skills'))).isDirectory()).toBe(true)
    expect(await fs.readFile(skillPath('.cursor/skills'), 'utf8')).toContain('## My notes')
    const cursor = status.targets.find((t) => t.id === 'cursor')
    expect(cursor?.note).toMatch(/Left in place: SKILL\.md/)
    expect(await manifest()).toBeNull()
    // A later look still says a copy is there that Zenium does not manage.
    const later = await make().status()
    expect(later.targets.find((t) => t.id === 'cursor')?.note).toMatch(/installing replaces it/)
    expect(later.targets.find((t) => t.id === 'claude')?.note).toBeNull()
  })

  it('uninstalls one target and keeps the others in the manifest', async () => {
    const installer = make()
    await installer.install()
    const status = await installer.uninstall(['claude'])
    expect(status.targets.filter((t) => t.installed).map((t) => t.id)).toEqual(['cursor', 'agents'])
    expect((await manifest())?.installed.map((e) => e.target)).toEqual(['cursor', 'agents'])
  })

  it('rewrites every installed copy once when the app version changed', async () => {
    await make('0.4.50').install()
    expect(versionOf(await fs.readFile(skillPath('.claude/skills'), 'utf8'))).toBe('0.4.50')
    // A plain status read changes nothing on disk.
    await make().status()
    expect(versionOf(await fs.readFile(skillPath('.claude/skills'), 'utf8'))).toBe('0.4.50')
    const synced = await make().status({ sync: true })
    for (const dir of ['.claude/skills', '.cursor/skills', '.agents/skills'])
      expect(versionOf(await fs.readFile(skillPath(dir), 'utf8'))).toBe(version)
    expect((await manifest())?.version).toBe(version)
    expect(synced.targets.find((t) => t.id === 'claude')?.installedVersion).toBe(version)
    expect(synced.targets.filter((t) => t.installed)).toHaveLength(3)
  })

  it('reports a target it could not write on its row and on the status line, and installs the rest', async () => {
    // A file where Codex's skills directory should be: mkdir fails (ENOTDIR), whoever runs this.
    await fs.mkdir(join(home, '.codex'))
    await fs.writeFile(join(home, '.codex', 'skills'), 'not a directory')
    const status = await make().install()
    const sentence =
      'Could not install: something else is in the way at ~/.codex/skills/zenium-browser'
    expect(byId(status, 'codex')).toMatchObject({ installed: false, note: sentence })
    expect(status.error).toBe(sentence)
    expect(byId(status, 'claude')).toMatchObject({ installed: true, note: null })
    expect(byId(status, 'cursor')).toMatchObject({ installed: true, note: null })
    expect((await manifest())?.installed.map((e) => e.target)).toEqual([
      'claude',
      'cursor',
      'agents'
    ])
    expectShowable(status)
    // A plain look afterwards carries no failure: the line was the operation's, not the state's.
    const later = await make().status()
    expect(later.error).toBeNull()
    expect(byId(later, 'codex').note).toBeNull()
  })

  it('rolls the copies back when its record cannot be saved, and says so without a note', async () => {
    io.refusing = true
    const status = await make().install()
    expect(status.error).toBe(
      'Could not install: Zenium could not save its record in its profile folder (no permission to write); the copies were removed again.'
    )
    expect(status.error?.startsWith('Could not install: Zenium could not save its record')).toBe(
      true
    )
    expect(status.targets.every((t) => !t.installed && t.note === null)).toBe(true)
    for (const dir of ['.claude/skills', '.cursor/skills', '.agents/skills']) {
      expect(await onDisk(dir)).toBe(false)
      expect(await fs.stat(join(home, ...dir.split('/'), SKILL_NAME)).catch(() => null)).toBeNull()
    }
    // The agents' own skills folders were made on the way in and are not ours to remove.
    expect((await fs.stat(join(home, '.claude', 'skills'))).isDirectory()).toBe(true)
    expect(await manifest()).toBeNull()
    expectShowable(status)
    // With the profile folder writable again, the same click installs.
    io.refusing = false
    const again = await make().install()
    expect(again.error).toBeNull()
    expect(again.targets.filter((t) => t.installed).map((t) => t.id)).toEqual([
      'claude',
      'cursor',
      'agents'
    ])
  })

  it('rolls back only what the operation changed: a copy already on record as it is stays', async () => {
    await make().install(['claude'])
    io.refusing = true
    const status = await make().install()
    expect(status.error?.startsWith('Could not install: Zenium could not save its record')).toBe(
      true
    )
    // Claude Code's copy was rewritten with the bytes the record already holds: it stays put.
    expect(byId(status, 'claude')).toMatchObject({ installed: true, note: null })
    expect(await onDisk('.claude/skills')).toBe(true)
    expect(byId(status, 'cursor')).toMatchObject({ installed: false, note: null })
    expect(byId(status, 'agents')).toMatchObject({ installed: false, note: null })
    expect(await onDisk('.cursor/skills')).toBe(false)
    expect(await onDisk('.agents/skills')).toBe(false)
    expect((await manifest())?.installed.map((e) => e.target)).toEqual(['claude'])
  })

  it('rolls a refresh back the same way when its record cannot be saved', async () => {
    await make('0.4.50').install()
    io.refusing = true
    const status = await make().status({ sync: true })
    expect(status.error).toBe(
      'Could not refresh: Zenium could not save its record in its profile folder (no permission to write); the copies were removed again.'
    )
    expect(status.targets.every((t) => !t.installed && t.note === null)).toBe(true)
    for (const dir of ['.claude/skills', '.cursor/skills', '.agents/skills'])
      expect(await onDisk(dir)).toBe(false)
    expect((await manifest())?.version).toBe('0.4.50')
    expectShowable(status)
    // The record still lists them, so the next start with a writable profile puts them back.
    io.refusing = false
    const restored = await make().status({ sync: true })
    expect(restored.error).toBeNull()
    expect(restored.targets.filter((t) => t.installed)).toHaveLength(3)
    expect((await manifest())?.version).toBe(version)
  })

  it('says when a removal could not be recorded, with the copies gone and no misleading note', async () => {
    const installer = make()
    await installer.install()
    io.refusing = true
    const one = await installer.uninstall(['claude'])
    expect(one.error).toBe(
      'Could not remove: Zenium could not save its record in its profile folder (no permission to change).'
    )
    expect(one.error?.startsWith('Could not remove:')).toBe(true)
    expect(byId(one, 'claude')).toMatchObject({ installed: false, note: null })
    expect(await onDisk('.claude/skills')).toBe(false)
    expect(byId(one, 'cursor')).toMatchObject({ installed: true, note: null })
    expectShowable(one)
    // Removing everything goes through the store's `remove`, which refuses the same way.
    const all = await installer.uninstall()
    expect(all.error?.startsWith('Could not remove: Zenium could not save its record')).toBe(true)
    expect(all.targets.every((t) => !t.installed && t.note === null)).toBe(true)
    expect(await onDisk('.cursor/skills')).toBe(false)
    // The record still lists them; the rows read the disk, so nothing shows as installed.
    expect((await manifest())?.installed.map((e) => e.target)).toEqual([
      'claude',
      'cursor',
      'agents'
    ])
    const later = await make().status()
    expect(later.targets.every((t) => !t.installed && t.note === null)).toBe(true)
    expectShowable(all)
  })

  it('shows nothing of temp files, absolute paths or raw error prefixes in any failure', async () => {
    const statuses: AgentSkillStatus[] = []
    await fs.mkdir(join(home, '.codex'))
    await fs.writeFile(join(home, '.codex', 'skills'), 'not a directory')
    statuses.push(await make().install())
    io.refusing = true
    statuses.push(await make().install())
    statuses.push(await make().uninstall())
    statuses.push(await make().status({ sync: true }))
    io.refusing = false
    await make('0.4.50').install(['claude', 'cursor'])
    io.refusing = true
    statuses.push(await make().status({ sync: true }))
    expect(statuses.filter((s) => s.error !== null).length).toBeGreaterThanOrEqual(4)
    for (const status of statuses) expectShowable(status)
  })

  it('treats a missing installation as not installed even if the manifest lists it', async () => {
    const installer = make()
    await installer.install()
    await fs.rm(join(home, '.claude', 'skills', SKILL_NAME), { recursive: true })
    const status = await installer.status()
    expect(status.targets.find((t) => t.id === 'claude')?.installed).toBe(false)
    expect(status.targets.find((t) => t.id === 'cursor')?.installed).toBe(true)
  })
})

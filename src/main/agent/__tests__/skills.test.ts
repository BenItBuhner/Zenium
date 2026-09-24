import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStoreIO } from '../../platform/storeIo'
import {
  SKILL_FILES,
  SKILL_NAME,
  SKILL_TARGETS,
  SKILLS_MANIFEST,
  SkillInstaller,
  displayPath,
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
 * an uninstall that spares an edited copy, and the once-per-update rewrite.
 */

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

describe('SkillInstaller', () => {
  let root: string
  let home: string
  let io: FileStoreIO
  const version = '0.4.51'
  const make = (v = version): SkillInstaller => new SkillInstaller({ home, version: v, io })
  const manifest = async (): Promise<SkillsManifest | null> => {
    const raw = io.readSync(SKILLS_MANIFEST)
    return raw ? (JSON.parse(raw) as SkillsManifest) : null
  }
  const skillPath = (dir: string): string => join(home, ...dir.split('/'), SKILL_NAME, 'SKILL.md')

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'zen-skills-'))
    home = join(root, 'home')
    await fs.mkdir(join(home, '.claude'), { recursive: true })
    await fs.mkdir(join(home, '.cursor'), { recursive: true })
    await fs.mkdir(join(home, '.gemini'), { recursive: true })
    io = new FileStoreIO(join(root, 'profile', 'zen'))
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

  it('reports a target it could not write instead of throwing', async () => {
    // A file where Claude Code's skills directory should be: mkdir fails.
    await fs.writeFile(join(home, '.claude', 'skills'), 'not a directory')
    const status = await make().install()
    const claude = status.targets.find((t) => t.id === 'claude')
    expect(claude?.installed).toBe(false)
    expect(claude?.note).toMatch(/^Could not install: /)
    expect(status.targets.find((t) => t.id === 'cursor')?.installed).toBe(true)
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

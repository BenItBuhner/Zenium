import { describe, expect, it } from 'vitest'
import {
  STAGING_DIR,
  installIntoLayout,
  isManagedPath,
  pickVersionDir,
  pruneOtherVersions,
  removeInstall,
  sweepStaging,
  versionDirName,
  type LayoutFs
} from '../installLayout'

/** A path-set filesystem: enough of a tree to exercise the layout logic without touching disk. */
class MemoryFs implements LayoutFs {
  readonly dirs = new Set<string>()
  readonly files = new Map<string, string>()
  readonly log: string[] = []

  join(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/')
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    for (let i = 1; i <= segments.length; i++) this.dirs.add('/' + segments.slice(0, i).join('/'))
  }

  /** Atomic like the real thing: no await between the checks and the move. */
  async rename(from: string, to: string): Promise<void> {
    const has = (path: string): boolean => this.dirs.has(path) || this.files.has(path)
    if (!has(from)) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' })
    if (has(to)) throw Object.assign(new Error(`ENOTEMPTY: ${to}`), { code: 'ENOTEMPTY' })
    this.log.push(`rename ${from} -> ${to}`)
    const move = (path: string): string => (path === from ? to : to + path.slice(from.length))
    for (const dir of [...this.dirs]) {
      if (dir === from || dir.startsWith(`${from}/`)) {
        this.dirs.delete(dir)
        this.dirs.add(move(dir))
      }
    }
    for (const [file, content] of [...this.files]) {
      if (file.startsWith(`${from}/`)) {
        this.files.delete(file)
        this.files.set(move(file), content)
      }
    }
  }

  async remove(path: string): Promise<void> {
    this.log.push(`remove ${path}`)
    for (const dir of [...this.dirs])
      if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir)
    for (const file of [...this.files.keys()])
      if (file === path || file.startsWith(`${path}/`)) this.files.delete(file)
  }

  async list(path: string): Promise<string[]> {
    const names = new Set<string>()
    for (const entry of [...this.dirs, ...this.files.keys()]) {
      if (!entry.startsWith(`${path}/`)) continue
      const name = entry.slice(path.length + 1).split('/')[0]
      if (name) names.add(name)
    }
    return [...names].sort()
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path)
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content)
    void this.mkdir(path.slice(0, path.lastIndexOf('/')))
  }
}

const ROOT = '/data/extensions'
const ID = 'bcjindcccaagfpapjjmafapmmgkkhgoa'

describe('versionDirName', () => {
  it('keeps Chrome-style versions and escapes anything else', () => {
    expect(versionDirName('0.7.2')).toBe('0.7.2')
    expect(versionDirName('2026.914.1325')).toBe('2026.914.1325')
    expect(versionDirName('1.0-beta_2')).toBe('1.0-beta_2')
    expect(versionDirName('1.0/../x y')).toBe('1.0_.._x_y')
    expect(versionDirName('')).toBe('unversioned')
    expect(versionDirName('..')).toBe('unversioned')
    expect(versionDirName('.')).toBe('unversioned')
  })
})

describe('pickVersionDir', () => {
  it('returns <root>/<id>/<version>, then _1, _2 while those exist', async () => {
    const fs = new MemoryFs()
    expect(await pickVersionDir(fs, ROOT, ID, '1.2.3')).toBe(`${ROOT}/${ID}/1.2.3`)
    await fs.mkdir(`${ROOT}/${ID}/1.2.3`)
    expect(await pickVersionDir(fs, ROOT, ID, '1.2.3')).toBe(`${ROOT}/${ID}/1.2.3_1`)
    await fs.mkdir(`${ROOT}/${ID}/1.2.3_1`)
    expect(await pickVersionDir(fs, ROOT, ID, '1.2.3')).toBe(`${ROOT}/${ID}/1.2.3_2`)
  })

  it('gives up rather than probing forever', async () => {
    const fs = new MemoryFs()
    fs.exists = async () => true
    await expect(pickVersionDir(fs, ROOT, ID, '1')).rejects.toThrow(/Too many installs/)
  })
})

describe('installIntoLayout', () => {
  it('writes into a staging folder and renames it into place in one step', async () => {
    const fs = new MemoryFs()
    let stagingDir = ''
    const target = await installIntoLayout(fs, ROOT, ID, '0.7.2', async (dir) => {
      stagingDir = dir
      expect(dir.startsWith(`${ROOT}/${STAGING_DIR}/`)).toBe(true)
      expect(await fs.exists(dir)).toBe(true)
      // Nothing under <root>/<id> is visible to a loader while the package is being written.
      expect(await fs.list(`${ROOT}/${ID}`)).toEqual([])
      fs.writeFile(`${dir}/manifest.json`, '{}')
      fs.writeFile(`${dir}/js/bg.js`, 'x')
    })
    expect(target).toBe(`${ROOT}/${ID}/0.7.2`)
    expect(await fs.exists(`${target}/manifest.json`)).toBe(true)
    expect(await fs.exists(`${target}/js/bg.js`)).toBe(true)
    expect(await fs.exists(stagingDir)).toBe(false)
    expect(await fs.list(`${ROOT}/${STAGING_DIR}`)).toEqual([])
    expect(fs.log.filter((l) => l.startsWith('rename'))).toEqual([
      `rename ${stagingDir} -> ${target}`
    ])
  })

  it('lands a reinstall of the same version next to the running one', async () => {
    const fs = new MemoryFs()
    const write = async (dir: string): Promise<void> => fs.writeFile(`${dir}/manifest.json`, '{}')
    const first = await installIntoLayout(fs, ROOT, ID, '0.7.2', write)
    const second = await installIntoLayout(fs, ROOT, ID, '0.7.2', write)
    expect(first).toBe(`${ROOT}/${ID}/0.7.2`)
    expect(second).toBe(`${ROOT}/${ID}/0.7.2_1`)
    expect(await fs.exists(`${first}/manifest.json`)).toBe(true)
    expect(await fs.exists(`${second}/manifest.json`)).toBe(true)
  })

  it('removes the staging folder and rethrows when writing fails', async () => {
    const fs = new MemoryFs()
    let stagingDir = ''
    await expect(
      installIntoLayout(fs, ROOT, ID, '0.7.2', async (dir) => {
        stagingDir = dir
        fs.writeFile(`${dir}/partial.js`, 'x')
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    expect(await fs.exists(stagingDir)).toBe(false)
    expect(await fs.exists(`${ROOT}/${ID}/0.7.2`)).toBe(false)
    expect(await fs.list(`${ROOT}/${ID}`)).toEqual([])
  })

  it('survives concurrent installs racing for the same version directory', async () => {
    const fs = new MemoryFs()
    const seen: string[] = []
    const targets = await Promise.all(
      ['1.0', '1.1', '1.0'].map((version) =>
        installIntoLayout(fs, ROOT, ID, version, async (dir) => {
          seen.push(dir)
          fs.writeFile(`${dir}/manifest.json`, version)
        })
      )
    )
    expect(new Set(seen).size).toBe(3)
    expect(targets.sort()).toEqual([
      `${ROOT}/${ID}/1.0`,
      `${ROOT}/${ID}/1.0_1`,
      `${ROOT}/${ID}/1.1`
    ])
    expect(await fs.list(`${ROOT}/${ID}`)).toEqual(['1.0', '1.0_1', '1.1'])
    expect(fs.files.get(`${ROOT}/${ID}/1.1/manifest.json`)).toBe('1.1')
    expect(await fs.list(`${ROOT}/${STAGING_DIR}`)).toEqual([])
  })

  it('does not retry a move that failed for another reason', async () => {
    const fs = new MemoryFs()
    let renames = 0
    fs.rename = async () => {
      renames += 1
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    await expect(
      installIntoLayout(fs, ROOT, ID, '1.0', async (dir) => fs.writeFile(`${dir}/m.json`, '{}'))
    ).rejects.toThrow('EACCES')
    expect(renames).toBe(1)
    expect(await fs.list(`${ROOT}/${STAGING_DIR}`)).toEqual([])
  })
})

describe('pruneOtherVersions, removeInstall and sweepStaging', () => {
  it('prunes every version directory but the one kept', async () => {
    const fs = new MemoryFs()
    for (const v of ['1.0', '1.1', '1.1_1', '2.0'])
      fs.writeFile(`${ROOT}/${ID}/${v}/manifest.json`, v)
    const removed = await pruneOtherVersions(fs, ROOT, ID, `${ROOT}/${ID}/2.0`)
    expect(removed.sort()).toEqual([
      `${ROOT}/${ID}/1.0`,
      `${ROOT}/${ID}/1.1`,
      `${ROOT}/${ID}/1.1_1`
    ])
    expect(await fs.list(`${ROOT}/${ID}`)).toEqual(['2.0'])
    expect(await fs.exists(`${ROOT}/${ID}/2.0/manifest.json`)).toBe(true)
  })

  it('removes the whole id tree on uninstall and tolerates an absent one', async () => {
    const fs = new MemoryFs()
    fs.writeFile(`${ROOT}/${ID}/1.0/manifest.json`, '{}')
    fs.writeFile(`${ROOT}/other/1.0/manifest.json`, '{}')
    await removeInstall(fs, ROOT, ID)
    expect(await fs.exists(`${ROOT}/${ID}`)).toBe(false)
    expect(await fs.exists(`${ROOT}/other/1.0/manifest.json`)).toBe(true)
    await expect(removeInstall(fs, ROOT, 'never-installed')).resolves.toBeUndefined()
  })

  it('sweeps whatever an interrupted install left in staging', async () => {
    const fs = new MemoryFs()
    fs.writeFile(`${ROOT}/${STAGING_DIR}/abc/manifest.json`, '{}')
    fs.writeFile(`${ROOT}/${STAGING_DIR}/def/x.js`, '')
    fs.writeFile(`${ROOT}/${ID}/1.0/manifest.json`, '{}')
    expect((await sweepStaging(fs, ROOT)).sort()).toEqual([
      `${ROOT}/${STAGING_DIR}/abc`,
      `${ROOT}/${STAGING_DIR}/def`
    ])
    expect(await fs.list(`${ROOT}/${STAGING_DIR}`)).toEqual([])
    expect(await fs.exists(`${ROOT}/${ID}/1.0/manifest.json`)).toBe(true)
    expect(await sweepStaging(new MemoryFs(), ROOT)).toEqual([])
  })
})

describe('isManagedPath', () => {
  it('recognises paths under the managed root on both path styles', () => {
    expect(isManagedPath(ROOT, `${ROOT}/${ID}/1.0`)).toBe(true)
    expect(isManagedPath('C:\\Users\\u\\ext', 'C:\\Users\\u\\ext\\abc\\1.0')).toBe(true)
    expect(isManagedPath(ROOT, ROOT)).toBe(false)
    expect(isManagedPath(ROOT, '/data/extensions-old/abc')).toBe(false)
    expect(isManagedPath(ROOT, '/home/u/dev/my-extension')).toBe(false)
  })
})

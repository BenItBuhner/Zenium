import { rollup, type Plugin as RollupPlugin } from 'rollup'
import { describe, expect, it } from 'vitest'
import { singleFilePreloads } from './single-file-preloads'

/** An in-memory module graph, so the test needs no files on disk. */
function virtual(files: Record<string, string>): RollupPlugin {
  return {
    name: 'virtual',
    resolveId(id) {
      return id in files ? id : null
    },
    load(id) {
      return id in files ? files[id] : null
    }
  }
}

async function bundle(files: Record<string, string>, input: string[]): Promise<string[]> {
  const build = await rollup({
    input,
    plugins: [virtual(files), singleFilePreloads() as unknown as RollupPlugin],
    onwarn: () => undefined
  })
  try {
    const { output } = await build.generate({ format: 'cjs' })
    return output.map((o) => o.fileName)
  } finally {
    await build.close()
  }
}

describe('singleFilePreloads (the preload bundle guard)', () => {
  it('fails the build when two preload entries share a module, naming the chunk and the module', async () => {
    const files = {
      'shared.ts': 'export const NAME = "zenium"',
      'page.ts': 'import { NAME } from "shared.ts"; console.log("page", NAME)',
      'extension.ts': 'import { NAME } from "shared.ts"; console.log("extension", NAME)'
    }
    await expect(bundle(files, ['page.ts', 'extension.ts'])).rejects.toThrow(
      /preload scripts must be single files; shared chunk: .*shared\.ts/
    )
  })

  it('passes a bundle whose entries share nothing: one file per entry', async () => {
    const files = {
      'page.ts': 'console.log("page")',
      'extension.ts': 'console.log("extension")'
    }
    const names = await bundle(files, ['page.ts', 'extension.ts'])
    expect(names.sort()).toEqual(['extension.js', 'page.js'])
  })

  it('passes a single entry that imports a module: the module is inlined, no chunk is emitted', async () => {
    const files = {
      'shared.ts': 'export const NAME = "zenium"',
      'page.ts': 'import { NAME } from "shared.ts"; console.log(NAME)'
    }
    expect(await bundle(files, ['page.ts'])).toEqual(['page.js'])
  })
})

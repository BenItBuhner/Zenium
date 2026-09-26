import { build } from 'esbuild'
import { resolve } from 'path'
import type { Plugin } from 'vite'

/**
 * A browser script bundled at build time and served as a string. Each module id names an entry
 * file; esbuild follows its imports (`src/shared` included) into one IIFE, and the virtual
 * module's default export is that source – for the main process to run in a document it does
 * not own and can set no preload on after the fact (`webContents.executeJavaScript` into a
 * DevTools frontend, `platform/devtoolsKeys.ts`).
 *
 * Why not a preload entry: the preload build forbids two entries sharing a module
 * (`single-file-preloads.ts` – Rollup would hoist the shared module into a chunk a sandboxed
 * preload cannot require), and `preload/page.ts` already carries `shared/quitHoldPanel.ts`. A
 * script bundled on its own shares the source and duplicates the bytes, which is the point.
 *
 * Used by `electron.vite.config.ts` on the main build and by `vitest.config.ts`, so a test runs
 * the same bytes the app does.
 */

/** The scripts the desktop build inlines, by module id (the ids are declared in `src/main/env.d.ts`). */
export const INLINE_SCRIPTS: Readonly<Record<string, string>> = {
  'virtual:zenium-devtools-quit-hold-panel': 'src/main/platform/devtoolsQuitHoldPanel.ts'
}

/** The entry bundled: its source as one IIFE and the files it was made from (for the watcher). */
export async function inlineScriptSource(
  entry: string,
  root: string = process.cwd()
): Promise<{ code: string; inputs: string[] }> {
  const result = await build({
    entryPoints: [resolve(root, entry)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true
  })
  const code = result.outputFiles.map((file) => file.text).join('\n')
  const inputs = Object.keys(result.metafile.inputs).map((input) => resolve(root, input))
  return { code, inputs }
}

/** The module's source: the script as a string literal, its default export. */
export function inlineScriptModuleSource(code: string): string {
  return `export default ${JSON.stringify(code)}\n`
}

/**
 * The Vite plugin: each id in `scripts` resolves to a virtual module whose default export is the
 * entry's bundled source, built once per id per build (again on a change of any file it was made
 * from, under the dev server).
 */
export function inlineScriptPlugin(
  scripts: Readonly<Record<string, string>> = INLINE_SCRIPTS,
  root: string = process.cwd()
): Plugin {
  const ids = new Map(Object.keys(scripts).map((id) => [`\0${id}`, id]))
  const cache = new Map<string, Promise<string>>()
  return {
    name: 'zenium:inline-script',
    resolveId(id) {
      return id in scripts ? `\0${id}` : null
    },
    async load(resolved) {
      const id = ids.get(resolved)
      if (id === undefined) return null
      let pending = cache.get(id)
      if (!pending) {
        pending = inlineScriptSource(scripts[id]!, root).then(({ code, inputs }) => {
          for (const input of inputs) this.addWatchFile(input)
          return inlineScriptModuleSource(code)
        })
        cache.set(id, pending)
      }
      return pending
    },
    watchChange() {
      cache.clear()
    }
  }
}

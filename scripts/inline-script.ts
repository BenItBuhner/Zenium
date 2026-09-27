import { build } from 'esbuild'
import { resolve } from 'path'
import type { Plugin } from 'vite'

/**
 * A browser script bundled at build time and served as a string. Each module id names an entry
 * file; esbuild follows its imports (`src/shared` included) into one IIFE, and the virtual
 * module's default export is that source – for the main process to run in a document it does
 * not own and can set no preload on after the fact (`webContents.executeJavaScript` into a
 * DevTools frontend, `platform/devtoolsKeys.ts`), or for a page builder to write into a
 * document it serves (Roll's runtime in the two documents that carry the game,
 * `shared/game/inlineRuntime.ts`).
 *
 * Why not a preload entry: the preload build forbids two entries sharing a module
 * (`single-file-preloads.ts` – Rollup would hoist the shared module into a chunk a sandboxed
 * preload cannot require), and `preload/page.ts` already carries `shared/quitHoldPanel.ts`. A
 * script bundled on its own shares the source and duplicates the bytes, which is the point.
 *
 * Used by `electron.vite.config.ts` on the main and renderer builds, by `vite.android.config.ts`
 * on the chrome's, and by `vitest.config.ts`, so a test runs the same bytes the app does.
 */

/** An entry to inline: the file, and whether its bytes are minified (a script a page ships pays for each). */
export interface InlineScript {
  entry: string
  /** Minify the bundle (default false: a script run once in a DevTools frontend reads better raw). */
  minify?: boolean
  /** The syntax target (default `es2022`; a script for the phone's WebView keeps to the page script's). */
  target?: string
}

/** The scripts the builds inline, by module id (the ids are declared in `src/main/env.d.ts`). */
export const INLINE_SCRIPTS: Readonly<Record<string, string | InlineScript>> = {
  'virtual:zenium-devtools-quit-hold-panel': 'src/main/platform/devtoolsQuitHoldPanel.ts',
  // Roll's runtime: written into the no-connection page and `zen://game` (`zenPages.ts`), so
  // every byte rides in every such document – minified, at the phone page script's syntax level.
  'virtual:zenium-game-runtime': {
    entry: 'src/shared/game/runtimeEntry.ts',
    minify: true,
    target: 'es2020'
  }
}

/** An entry as declared, in its full form. */
export function inlineScriptOf(script: string | InlineScript): InlineScript {
  return typeof script === 'string' ? { entry: script } : script
}

/** The entry bundled: its source as one IIFE and the files it was made from (for the watcher). */
export async function inlineScriptSource(
  script: string | InlineScript,
  root: string = process.cwd()
): Promise<{ code: string; inputs: string[] }> {
  const { entry, minify = false, target = 'es2022' } = inlineScriptOf(script)
  const result = await build({
    entryPoints: [resolve(root, entry)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target,
    minify,
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
  scripts: Readonly<Record<string, string | InlineScript>> = INLINE_SCRIPTS,
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

import { relative } from 'path'
import type { Plugin, Rollup } from 'vite'

/**
 * Every preload entry must bundle to one file: sandboxed preloads (pages, extension contexts,
 * service workers) cannot `require` a second one. Rollup hoists a module that two entries share
 * into a common chunk, so one shared import between, say, `page.ts` and `extension.ts` breaks
 * every preload at load time in the packaged build with no compile error (#146). This fails the
 * build instead and names the module; the entries spell such shared bits out as literals.
 *
 * Used by `electron.vite.config.ts` on the preload build; `single-file-preloads.test.ts` holds it
 * to its word against a two-entry bundle that shares a module.
 */
export function singleFilePreloads(): Plugin {
  return {
    name: 'zenium:single-file-preloads',
    apply: 'build',
    generateBundle(_options, bundle) {
      const shared = Object.values(bundle).filter(
        (output): output is Rollup.OutputChunk => output.type === 'chunk' && !output.isEntry
      )
      if (shared.length === 0) return
      const lines = shared.map(
        (chunk) =>
          `${chunk.fileName} (${Object.keys(chunk.modules)
            .map((id) => relative(process.cwd(), id))
            .join(', ')})`
      )
      this.error(
        `preload scripts must be single files; shared chunk${shared.length > 1 ? 's' : ''}: ${lines.join('; ')}`
      )
    }
  }
}

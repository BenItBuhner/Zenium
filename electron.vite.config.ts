import { relative, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin, Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Every preload entry must bundle to one file: sandboxed preloads (pages, extension contexts,
 * service workers) cannot `require` a second one. Rollup hoists a module that two entries share
 * into a common chunk, so one shared import between, say, `page.ts` and `extension.ts` breaks
 * every preload at load time in the packaged build with no compile error. This fails the build
 * instead and names the module; the entries spell such shared bits out as literals.
 */
function singleFilePreloads(): Plugin {
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

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: {
      // The Apple team id of the signing identity (release builds); it names the keychain access
      // group of Touch ID passkeys. Empty for unsigned builds.
      __ZENIUM_APPLE_TEAM_ID__: JSON.stringify(process.env.APPLE_TEAM_ID ?? '')
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [singleFilePreloads()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          page: resolve('src/preload/page.ts'),
          webstore: resolve('src/preload/webstore.ts'),
          extension: resolve('src/preload/extension.ts'),
          tts: resolve('src/preload/tts.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      port: 41733,
      strictPort: true
    }
  }
})

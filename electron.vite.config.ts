import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { inlineScriptPlugin } from './scripts/inline-script'
import { licencesPlugin } from './scripts/licences'
import { singleFilePreloads } from './scripts/single-file-preloads'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Every character past ASCII in the main process's chunks written as a `\u` escape – valid in a
 * string, a template, a regular expression and an identifier alike, a code unit at a time – so
 * V8 holds their source as a one-byte string, half the size.
 */
function asciiOutput(): Plugin {
  return {
    name: 'zenium-ascii-output',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !/[\u0080-\uffff]/.test(chunk.code)) continue
        // A character escaped already (`\…`, an identity escape) loses its backslash to the
        // `\u` escape that replaces it.
        chunk.code = chunk.code.replace(
          /(\\*)([\u0080-\uffff])/g,
          (_m, slashes: string, c: string) => {
            const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes
            return `${kept}\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
          }
        )
      }
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
    // The scripts the main process runs in documents it does not own (a DevTools toolbox's
    // held-key notice), bundled here from their entries into strings (`virtual:zenium-*`).
    plugins: [inlineScriptPlugin(), asciiOutput()],
    // The main process keeps its bundle's whole source in memory (V8 compiles functions from
    // it lazily), and one character past ASCII makes all of it a two-byte string: 5.8 MB of
    // source held as 23 MB. Whitespace, comments and syntax are minified and the output kept
    // ASCII (`asciiOutput`; esbuild's own `charset` leaves regular expressions alone); names
    // stay, so stack traces still read.
    build: { minify: 'esbuild' },
    esbuild: { minifyIdentifiers: false, charset: 'ascii' },
    define: {
      // The Apple team id of the signing identity (release builds); it names the keychain access
      // group of Touch ID passkeys. Empty for unsigned builds.
      __ZENIUM_APPLE_TEAM_ID__: JSON.stringify(process.env.APPLE_TEAM_ID ?? ''),
      // The Zenium account deployment sync talks to (`core/sync/accountEndpoints.ts`): `dev` for
      // the development one, anything else production.
      __ZENIUM_ACCOUNTS_ENV__: JSON.stringify(process.env.ZENIUM_ACCOUNTS_ENV ?? 'prod')
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
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core')
      }
    },
    // The open-source licences list (`virtual:zenium-licences`, Settings › About), collected
    // from the installed tree at build time; the desktop's carries Electron itself. The inlined
    // scripts resolve here too: the chrome imports `shared/zenPages.ts` for its constants, and
    // that module carries Roll's runtime (`virtual:zenium-game-runtime`) for the documents it
    // builds – unused by the chrome, so Rollup drops the string from its bundle.
    plugins: [react(), tailwindcss(), licencesPlugin({ electron: true }), inlineScriptPlugin()],
    server: {
      port: 41733,
      strictPort: true
    }
  }
})

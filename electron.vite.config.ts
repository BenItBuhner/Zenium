import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { inlineScriptPlugin } from './scripts/inline-script'
import { licencesPlugin } from './scripts/licences'
import { singleFilePreloads } from './scripts/single-file-preloads'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // The scripts the main process runs in documents it does not own (a DevTools toolbox's
    // held-key notice), bundled here from their entries into strings (`virtual:zenium-*`).
    plugins: [inlineScriptPlugin()],
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

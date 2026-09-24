import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import { licencesPlugin } from './scripts/licences'

export default defineConfig({
  // The Licences page's `virtual:zenium-licences` resolves to the real tree here, as in a build;
  // a test that wants a short list mocks the module.
  plugins: [licencesPlugin({ electron: true })],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.ts',
      '.github/smoke/**/*.test.mjs',
      '.github/scripts/**/*.test.mjs'
    ],
    environment: 'node',
    // Vitest empties every `.css` import, query or not; the chrome's stylesheet imported as text
    // (`main.css?raw` in shared/zenPages.ts and shared/newTabPage.ts, the source of the v2 token
    // blocks for the error and new tab pages) must come through as Vite's `?raw` export.
    // Stylesheets imported as styles stay empty.
    css: { include: [/\.css\?raw$/] }
  }
})

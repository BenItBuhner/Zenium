import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Vitest empties every `.css` import, query or not; the chrome's stylesheet imported as text
    // (`main.css?raw` in shared/zenPages.ts, the error page's source of the v2 rules) must come
    // through as Vite's `?raw` export. Stylesheets imported as styles stay empty.
    css: { include: [/\.css\?raw$/] }
  }
})

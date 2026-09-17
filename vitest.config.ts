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
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Vitest empties every stylesheet import unless told otherwise; `newTabPage.ts` reads main.css
    // as text (`?raw`) for its token blocks and needs the real file.
    css: { include: [/\.css\?raw$/] }
  }
})

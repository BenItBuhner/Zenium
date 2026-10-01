import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    setupFiles: ['tests/setup.ts'],
    server: { deps: { inline: ['convex-test', '@convex-dev/rate-limiter'] } }
  }
})

import { defineConfig } from 'vitest/config'

/**
 * Against a live deployment: `ZENIUM_SITE`, `ZENIUM_CLOUD` and a Clerk secret key of the same
 * environment's instance in `ZENIUM_CLERK_SECRET_KEY` (development instances only: it mints
 * sessions for a throwaway test user).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})

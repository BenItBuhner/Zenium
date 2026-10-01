/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly ZENIUM_CONVEX_URL: string
  readonly ZENIUM_CLERK_PUBLISHABLE_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

import type { ZenApi } from './index'

declare global {
  interface Window {
    zen: ZenApi
  }
}

export {}

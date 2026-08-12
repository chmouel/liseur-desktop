import type { LiseurApi } from '../preload/preload'

declare global {
  interface Window {
    liseur: LiseurApi
  }
}

export {}

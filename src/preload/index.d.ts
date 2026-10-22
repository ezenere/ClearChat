import type { FullClearApi } from '../shared/ipc'

declare global {
  interface Window {
    api: FullClearApi
  }
}

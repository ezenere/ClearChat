import type { ClearApi } from '../shared/ipc'

declare global {
  interface Window {
    api: ClearApi
  }
}

import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // Production deps (package.json "dependencies") are externalized by default.
      // better-sqlite3 is a native addon and must never be bundled.
      externalizeDeps: true,
      rolldownOptions: { external: ['better-sqlite3'] }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Preload runs sandboxed: it may only require('electron'), so everything else is bundled.
      externalizeDeps: false,
      rolldownOptions: { external: ['electron'] }
    }
  },
  renderer: {
    resolve: {
      alias: {
        ...shared,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})

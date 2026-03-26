import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: [
      {
        find: '@aurora/style.css',
        replacement: fileURLToPath(new URL('../style.css', import.meta.url))
      },
      {
        find: '@aurora',
        replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url))
      }
    ]
  },
  server: {
    port: 3001
  },
  plugins: [react()]
})

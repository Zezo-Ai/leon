import dns from 'node:dns'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

dotenv.config()

dns.setDefaultResultOrder('verbatim')

// Map necessary Leon's env vars as Vite only expose VITE_*
process.env.VITE_LEON_NODE_ENV = process.env.LEON_NODE_ENV
process.env.VITE_LEON_HOST = process.env.LEON_HOST
process.env.VITE_LEON_PORT = process.env.LEON_PORT

export default defineConfig({
  root: 'app/src',
  resolve: {
    alias: [
      {
        find: '@aurora/style.css',
        replacement: fileURLToPath(
          new URL('../aurora/style.css', import.meta.url)
        )
      },
      {
        find: '@aurora',
        replacement: fileURLToPath(
          new URL('../aurora/src/index.ts', import.meta.url)
        )
      }
    ]
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    port: 3000
  },
  plugins: [react()]
})

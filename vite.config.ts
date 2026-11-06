import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { appVersion } from './shared/version.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'application-version',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: appVersion }) }) },
  }],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4410', ws: true } } },
})

import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// The production Content-Security-Policy lives in src/renderer/index.html.
// The Vite dev server needs an inline React Refresh preamble and a websocket
// for hot reload, so in `serve` mode only, that meta tag is swapped for a
// looser one. Built output always carries the strict policy.
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'"

function devCsp(): Plugin {
  return {
    name: 'cloud-watchdog:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      const devHtml = html.replace(
        /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1${DEV_CSP}$2`
      )
      // Fail loudly rather than run the dev server with a policy that breaks it.
      if (devHtml === html) throw new Error('dev-csp: Content-Security-Policy meta tag not found in index.html')
      return devHtml
    }
  }
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rolldownOptions: {
        // Sandboxed preload scripts must be CommonJS, even though the
        // package is "type": "module".
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), devCsp()]
  }
})

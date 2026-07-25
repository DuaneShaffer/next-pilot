import { defineConfig } from 'vite'

// GitHub Pages serves project sites from /<repo>/, so assets must resolve there.
// Local dev and tests use '/' so nothing has to know about the deploy path.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/next-pilot/' : '/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
})

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import solid from 'vite-plugin-solid'
import { resolve } from 'node:path'

const shared = {
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
}

const mainOutput = {
  // utilityProcess (the worker) does not support ESM entry points, so the
  // whole Node side builds as CJS. package.json has "type": "module" for the
  // renderer, hence explicit .cjs names here; "main" points at main.cjs.
  format: 'cjs' as const,
  entryFileNames: '[name].cjs',
}

export default defineConfig({
  main: {
    ...shared,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The worker runs as an Electron utilityProcess and must be a
        // separate entry file, not bundled into main.
        input: {
          main: resolve(import.meta.dirname, 'src/main/main.ts'),
          worker: resolve(import.meta.dirname, 'src/worker/worker.ts'),
        },
        output: mainOutput,
      },
    },
  },
  preload: {
    ...shared,
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'src/preload/preload.ts', formats: ['cjs'] },
      rollupOptions: {
        output: {
          // Sandboxed preload scripts cannot use ESM.
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    ...shared,
    root: 'src/renderer',
    plugins: [solid()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
  },
})

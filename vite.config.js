import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    sveltekit(),
    // @ts-expect-error default export quirk
    (monacoEditorPlugin.default ?? monacoEditorPlugin)({
      languageWorkers: ['editorWorkerService'],
    }),
  ],

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    hmr: { port: 5183 },
    watch: {
      ignored: ["**/electron/**"],
    },
    warmup: {
      clientFiles: [
        './src/routes/+page.svelte',
        './src/lib/Editor.svelte',
        './src/lib/Terminal.svelte',
        './src/lib/FileTree.svelte',
      ],
    },
  },

  optimizeDeps: {
    include: ['@xterm/xterm', '@xterm/addon-fit'],
    exclude: ['electron'],
  },

  build: {
    target: 'chrome132',
    minify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        /** @param {string} id */
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@xterm') || id.includes('xterm')) return 'vendor-xterm'
            if (id.includes('lucide-svelte')) return 'vendor-lucide'
            if (id.includes('monaco-editor')) return 'monaco'
            return 'vendor'
          }
        },
      },
    },
  },
}));

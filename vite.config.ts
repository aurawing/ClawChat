import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': {
        target: 'ws://localhost:18888',
        ws: true,
      },
      '/upload': {
        target: 'http://localhost:18888',
      },
      '/health': {
        target: 'http://localhost:18888',
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'markdown': ['react-markdown', 'remark-gfm', 'rehype-highlight', 'rehype-raw', 'highlight.js'],
        },
      },
    },
  },
})

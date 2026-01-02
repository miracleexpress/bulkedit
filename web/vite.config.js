import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: '../dist/client'
  },
  server: {
    port: 3000,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
    proxy: {
      '^/api/.*': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false
      },
       '^/auth/.*': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false
      }
    }
  }
});

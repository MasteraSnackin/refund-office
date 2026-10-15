import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envDir: false,
  cacheDir: 'node_modules/.vite-runtime-rehearsal',
  plugins: [react()],
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 4273, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4274' }, allowedHosts: ['127.0.0.1', 'localhost'] },
});

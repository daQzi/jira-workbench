import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 开发时前端走 Vite，/api 全部转发给本地 Node 代理（server/index.mjs）
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
  },
});

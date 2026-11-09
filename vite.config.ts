import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 开发时前端走 Vite，/api 全部转发给本地 Node 代理（server/index.mjs）
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/mcp': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      // 保留浏览器访问的 Host，与 Origin 一致；Vite 字符串简写会隐式开启 changeOrigin。
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
  },
});

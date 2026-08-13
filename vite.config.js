import { defineConfig } from 'vite';

export default defineConfig({
  base: '/coins/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'worker/src/**/*.test.js'],
  },
});

import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? '/',
  plugins: mode === 'phone' ? [basicSsl()] : [],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
}));

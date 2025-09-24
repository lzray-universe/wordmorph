import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',            // 自定义域/子域名用根路径
  build: { sourcemap: false }
})

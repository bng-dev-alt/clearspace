import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
    // Existující testy gateway používají libovolného přihlášeného uživatele; owner-only chování testují src/__tests__/ai/ownerAccess.test.ts samostatně.
    env: { AI_ALLOW_ALL_AUTHENTICATED: '1' },
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'e2e/**/*', 'scripts/**/*.test.mjs'],   // scripts/*.test.mjs = node --test
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

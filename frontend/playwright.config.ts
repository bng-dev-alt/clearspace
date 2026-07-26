import { defineConfig, devices } from '@playwright/test';

// Port se odvozuje z adresy, ne zadrátuje. Jinak PLAYWRIGHT_TEST_BASE_URL sice
// přesměruje testy, ale server pořád nastartuje na 3001 -- a když tam z minula
// visí cizí `next dev` s jinou konfigurací, Playwright ho recykluje a padne
// celá sada.
const baseUrl = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3001';
const port = new URL(baseUrl).port || '3001';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: baseUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Port musí být explicitní: `next dev` jinak startuje na 3000 a pokud je
    // volný, Playwright na 3001 marně čeká. Dřív to procházelo jen náhodou,
    // když byl 3000 obsazený a Next si sám vybral 3001.
    command: `npm run dev -- -p ${port}`,
    url: baseUrl,
    reuseExistingServer: !process.env.CI,
    // Studený start Turbopacku (prázdná .next cache) se do výchozích 60 s nevejde.
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    /**
     * E2E běží záměrně v demo režimu (localStorage + mock auth).
     *
     * Testy ověřují chování UI, které je v obou režimech shodné, a demo režim
     * je sám o sobě podporovaná varianta aplikace -- takhle zůstává pokrytý.
     * Zároveň se testy nedotknou ostré databáze a nepotřebují testovací účty.
     *
     * Přepíná se přes NEXT_PUBLIC_FORCE_DEMO, ne prázdnou hodnotou Supabase
     * proměnných -- prázdný řetězec Next.js považuje za nenastavený
     * a přepsal by ho hodnotou z `.env.local`.
     */
    env: {
      // Rozšíření, ne náhrada -- `env` jinak nahradí celé process.env
      // a příkaz ztratí PATH.
      ...(process.env as Record<string, string>),
      NEXT_PUBLIC_FORCE_DEMO: '1',
    },
  },
});

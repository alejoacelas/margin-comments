import { defineConfig } from '@playwright/test';

export const PORTS = {
  backend: 18787,
  proxy: 18788,
  fakeResend: 18901,
  fixtures: 18902,
};

const WEBHOOK_SECRET = 'whsec_dGVzdC13ZWJob29rLXNlY3JldC0xMjM0NTY3ODkw';

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'e2e', testDir: 'tests/e2e' },
    { name: 'anchoring', testDir: 'tests/anchoring', timeout: 300_000 },
  ],
  webServer: [
    {
      command: 'node tests/support/servers.mjs',
      url: `http://localhost:${PORTS.fakeResend}/_test/sent`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 120_000,
      env: {
        FAKE_RESEND_PORT: String(PORTS.fakeResend),
        FIXTURES_PORT: String(PORTS.fixtures),
        PROXY_PORT: String(PORTS.proxy),
        BACKEND_PORT: String(PORTS.backend),
        WEBHOOK_SECRET,
      },
    },
    {
      command: 'node scripts/build-server.mjs && node build/server/index.js',
      url: `http://127.0.0.1:${PORTS.backend}/healthz`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
      env: {
        PORT: String(PORTS.backend),
        HOST: '127.0.0.1',
        PUBLIC_URL: `http://localhost:${PORTS.proxy}`,
        DATABASE_PATH: ':memory:',
        APP_SECRET: 'e2e-app-secret-0123456789abcdef',
        ADMIN_TOKEN: 'e2e-admin',
        RESEND_API_KEY: 're_test_e2e',
        RESEND_API_BASE: `http://127.0.0.1:${PORTS.fakeResend}`,
        RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EMAIL_DOMAIN: 'mail.test',
        REPLY_DOMAIN: 'reply.mail.test',
        EMAIL_WORKER_INTERVAL_MS: '200',
        EXTENSION_IDS: 'igipapgffolpgikiojpjbpdngefekkbg',
        LOG_LEVEL: 'warn',
      },
    },
  ],
});

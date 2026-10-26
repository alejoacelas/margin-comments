import { defineConfig } from '@playwright/test';

// Production smoke test: no local servers.
export default defineConfig({ testDir: '.', timeout: 120_000, workers: 1, reporter: [['list']] });

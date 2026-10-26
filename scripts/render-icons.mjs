import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const dir = process.argv[2];
const svg = readFileSync(`${dir}/icon.svg`, 'utf8');
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `${dir}/icon-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();

// v1 app icon (full-bleed, maskable-safe): the app's blue with a white rounded checkbox and check.
// Renders the SVG with the preinstalled Chromium. Run: node scripts/make-v1-icons.mjs
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const { chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/v1');
// Content stays inside the central 60% (Android maskable safe zone is a circle of 80%)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4A93FF"/><stop offset="1" stop-color="#2D7FF9"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <rect x="166" y="166" width="180" height="180" rx="40" fill="#fff"/>
  <path d="M206 258 l38 38 l68 -78" fill="none" stroke="#2D7FF9" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: path.join(out, `icon-${size}.png`), omitBackground: false });
}
await browser.close();
console.log('wrote public/v1/icon-192.png, icon-512.png');

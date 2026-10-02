import { chromium } from 'playwright-core';
import fs from 'fs';
const AXE = fs.readFileSync('/home/ubuntu/repos/ripple-alexa/docs/tools/axe.min.js', 'utf8');
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();

const run = async (tag) => {
  const m = await page.evaluate(() => ({
    cw: document.documentElement.clientWidth,
    sw: document.documentElement.scrollWidth,
    appW: document.querySelector('.app')?.clientWidth,
    appSw: document.querySelector('.app')?.scrollWidth,
  }));
  const v = await page.evaluate(async () => {
    const r = await axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length, t: x.nodes.slice(0,4).map(n => n.target.join(' ')) }));
  });
  console.log(`=== ${tag} ===`, JSON.stringify(m), '\nviolations:', JSON.stringify(v, null, 1));
};

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(AXE);

await page.setViewportSize({ width: 1165, height: 900 });
await page.waitForTimeout(400);
await run('desktop 1165');

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await run('viewport 390 desktop-mode');

// toggle phone-size within 390 viewport
await page.evaluate(() => {
  const lbl = [...document.querySelectorAll('.hero-controls label')].find(l => l.textContent.includes('Phone'));
  lbl?.querySelector('input')?.click();
});
await page.waitForTimeout(400);
await run('viewport 390 phone-toggle');

// phone toggle at desktop width — container-internal overflow check
await page.setViewportSize({ width: 1165, height: 900 });
await page.waitForTimeout(400);
const inner = await page.evaluate(() => {
  const app = document.querySelector('.app');
  const bad = [];
  for (const el of app.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > app.getBoundingClientRect().right + 1 && r.width > 20) bad.push(`${el.tagName}.${String(el.className).slice(0,30)} right=${Math.round(r.right)}`);
    if (bad.length > 10) break;
  }
  return { appW: app.clientWidth, appSw: app.scrollWidth, bad };
});
console.log('=== phone-toggle @1165 ===', JSON.stringify(inner, null, 1));
await page.close();
await browser.close().catch(() => {});
process.exit(0);

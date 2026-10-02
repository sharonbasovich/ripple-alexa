import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
const misses = [];
page.on('requestfailed', r => misses.push('FAILED ' + r.url()));
page.on('response', r => { if (r.status() >= 400) misses.push(r.status() + ' ' + r.url()); });
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
console.log('=== network >=400 ===', JSON.stringify(misses));

// real keyboard Tab navigation to an Approve button -> :focus-visible
await page.click('button.preset');
await page.waitForTimeout(400);
// Tab into the modal first (Apply change)
let log = [];
for (let i = 0; i < 30; i++) {
  await page.keyboard.press('Tab');
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return `${el.tagName}:${(el.textContent||'').trim().slice(0,40)} | outline=${cs.outlineStyle} ${cs.outlineWidth} color=${cs.outlineColor}`;
  });
  log.push(info);
  if (/Apply change/.test(info)) break;
}
console.log('=== tab sequence (modal) ===\n' + log.join('\n'));
await page.keyboard.press('Enter'); // apply the preview
await page.waitForTimeout(600);
// keep tabbing until an Approve button on an op card is focused
log = [];
for (let i = 0; i < 50; i++) {
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return `${el.tagName}:${(el.textContent||'').trim().slice(0,45)} | outline=${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
  });
  if (/^BUTTON:Approve/.test(info)) { log.push('** ' + info); break; }
  await page.keyboard.press('Tab');
}
console.log('=== reached op Approve via Tab ===\n' + log.join('\n'));
await page.screenshot({ path: '/home/ubuntu/repos/ripple-alexa/docs/screenshots/12-focus-visible.png' });
await browser.close();

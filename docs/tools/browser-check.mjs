import { chromium } from 'playwright-core';
import fs from 'fs';

const AXE = fs.readFileSync('/home/ubuntu/repos/ripple-alexa/node_modules/axe-core/axe.min.js', 'utf8');
const OUT = '/home/ubuntu/repos/ripple-alexa/docs/screenshots';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0,200)}`); });
page.on('pageerror', e => errors.push(`[pageerror] ${String(e.message).slice(0,200)}`));

async function measure(tag) {
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if ((r.width > de.clientWidth + 1 || r.right > de.clientWidth + 1) && r.width > 30) {
        const cls = String(el.className || '').slice(0, 40);
        wide.push(`${el.tagName}.${cls} w=${Math.round(r.width)} right=${Math.round(r.right)}`);
        if (wide.length > 12) break;
      }
    }
    const cols = getComputedStyle(document.querySelector('.board')).gridTemplateColumns.split(' ').length;
    return { cw: de.clientWidth, sw: de.scrollWidth, boardCols: cols, wide };
  });
  console.log(`=== ${tag} ===`, JSON.stringify(m, null, 1));
}

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// --- 390px ---
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await measure('390px');
await page.screenshot({ path: `${OUT}/10-phone-390.png`, fullPage: true });

// --- axe 390 ---
await page.evaluate(AXE);
const axe390 = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, t: v.nodes.slice(0,3).map(n=>n.target.join(' ')) })));
console.log('=== axe 390 ===', JSON.stringify(axe390, null, 1));

// --- 1165px ---
await page.setViewportSize({ width: 1165, height: 900 });
await page.waitForTimeout(400);
await measure('1165px');
await page.screenshot({ path: `${OUT}/11-desktop-1165.png`, fullPage: true });

// --- axe 1165 ---
const axe1165 = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, t: v.nodes.slice(0,3).map(n=>n.target.join(' ')) })));
console.log('=== axe 1165 ===', JSON.stringify(axe1165, null, 1));

// --- keyboard path at desktop: preset -> apply -> tab through to decision buttons ---
await page.click('button.preset');
await page.waitForTimeout(400);
await page.click('.modal-actions button.primary'); // Apply change in preview
await page.waitForTimeout(500);
const tabRun = await page.evaluate(async () => {
  const seq = [];
  const step = () => new Promise(res => {
    const el = document.activeElement;
    seq.push(`${el.tagName}.${String(el.className||'').slice(0,20)}:${(el.textContent||'').trim().slice(0,40)}`);
    const fe = [...document.querySelectorAll('button,input,a[href],[tabindex]')].filter(e => !e.disabled && e.offsetParent !== null);
    const i = fe.indexOf(el);
    (fe[i+1] || fe[0]).focus();
    res();
  });
  document.body.focus();
  // tab through up to 60 focusables, record order
  for (let i = 0; i < 60; i++) { const el = document.activeElement; const fe=[...document.querySelectorAll('button,input,a[href],[tabindex]')].filter(e=>!e.disabled&&e.offsetParent!==null); const idx=fe.indexOf(el); const next=fe[idx+1]||fe[0]; next.focus(); }
  const fe=[...document.querySelectorAll('button,input,a[href],[tabindex]')].filter(e=>!e.disabled&&e.offsetParent!==null);
  return fe.map(e => `${e.tagName}:${(e.textContent||e.getAttribute('aria-label')||e.placeholder||'').trim().slice(0,45)}`);
});
console.log('=== focusables after preset applied ===');
console.log(tabRun.join('\n'));
// check focus-visible outline on an approve button
const focusVis = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.op-actions button')].find(b => /Approve/.test(b.textContent));
  if (!btn) return 'no approve button';
  btn.focus();
  const cs = getComputedStyle(btn);
  const rect = btn.getBoundingClientRect();
  const focused = document.activeElement === btn;
  return `focused=${focused} outline=${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} boxshadow=${cs.boxShadow} at ${Math.round(rect.x)},${Math.round(rect.y)}`;
});
console.log('=== focus-visible ===', focusVis);
await page.screenshot({ path: `${OUT}/12-focus-visible.png` });

console.log('=== console errors ===', JSON.stringify(errors));
await browser.close();

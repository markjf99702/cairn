// Renders the README screenshots (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Math.random is seeded, so the sky and the stones come out the same each time.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const SEED = 4;
const browser = await pw.chromium.launch();

async function open(viewport, deviceScaleFactor) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript(seed => {
    let a = seed; // mulberry32
    Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    localStorage.setItem('cairn.best', '9');
  }, SEED);
  await page.goto(base);
  await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// Lets each stone go as it swings over the middle, until the cairn is n stones tall.
async function stack(page, n) {
  while ((await page.evaluate(() => window.cairn.peek().count)) < n) {
    const before = await page.evaluate(() => window.cairn.peek().count);
    await page.evaluate(() => new Promise(done => {
      const tick = () => {
        const p = window.cairn.peek();
        if (p.state === 'hover' && Math.abs(p.hoverX - p.width / 2) < 2) { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); done(); } else requestAnimationFrame(tick);
      };
      tick();
    }));
    await page.waitForFunction(c => { const p = window.cairn.peek(); return p.state === 'over' || (p.state === 'hover' && p.count > c); }, before, { timeout: 15000 });
    if ((await page.evaluate(() => window.cairn.peek().state)) === 'over') throw new Error('the cairn fell while stacking; try another SEED');
  }
}

// The stone in hand, caught just off the middle so the plumb line shows.
async function holdOffCenter(page, px) {
  await page.waitForFunction(() => !document.getElementById('hint').textContent, null, { timeout: 8000 }); // the first-gust hint
  await page.evaluate(px => new Promise(done => {
    const tick = () => { const p = window.cairn.peek(); if (p.state === 'hover' && Math.abs(p.hoverX - p.width / 2 - px) < 3) done(); else requestAnimationFrame(tick); };
    tick();
  }), px);
}

// Phone: a cairn going up, and one knocked into the stream.
{
  const page = await open({ width: 390, height: 844 }, 2);
  await stack(page, 7);
  await holdOffCenter(page, -24);
  await page.screenshot({ path: join(root, 'docs/phone-stack.png') });

  await page.evaluate(() => window.cairn.stones().slice(-3).forEach((s, i) => { window.Matter.Sleeping.set(s, false); window.Matter.Body.setVelocity(s, { x: 5 + i * 1.5, y: -2 }); }));
  await page.waitForSelector('#over', { state: 'visible' });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: join(root, 'docs/phone-fell.png') });
  await page.context().close();
}

// Link preview.
{
  const page = await open({ width: 1200, height: 630 }, 1);
  await stack(page, 8);
  await holdOffCenter(page, 30);
  await page.screenshot({ path: join(root, 'og.png') });
  await page.context().close();
}

await browser.close();
server.close();
console.log('screenshots written');

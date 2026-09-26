// Plays Cairn in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Stacks stones, turns the phone sideways, knocks the cairn into the stream, checks the best score
// survives a reload, tries zen mode, and plays once more with the network off.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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

const peek = page => page.evaluate(() => window.cairn.peek());

// Waits for the stone in hand to swing over the middle, lets it go, and waits for the next one.
async function dropCentered(page) {
  const before = await peek(page);
  await page.evaluate(() => new Promise(done => {
    const tick = () => {
      const p = window.cairn.peek();
      if (p.state === 'hover' && p.hoverX != null && Math.abs(p.hoverX - p.width / 2) < 2) {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        done();
      } else requestAnimationFrame(tick);
    };
    tick();
  }));
  await page.waitForFunction(n => { const p = window.cairn.peek(); return p.state === 'over' || (p.state === 'hover' && p.count > n); }, before.count, { timeout: 15000 });
  return peek(page);
}

// Drops a standing stone into the water.
const sink = page => page.evaluate(() => {
  const s = window.cairn.stones()[0];
  window.Matter.Body.setStatic(s, false);
  window.Matter.Body.setPosition(s, { x: s.position.x, y: window.cairn.peek().waterY + 100 });
});

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

await page.goto(base);
await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
assert.equal(await page.textContent('#best'), '0');
assert.ok(await page.isVisible('#intro'), 'the first-time hint shows');

// A tap anywhere lets the first stone go; it lands on the rock and counts.
await page.touchscreen.tap(195, 420);
await page.waitForFunction(() => window.cairn.peek().count === 1, null, { timeout: 15000 });
assert.ok(await page.isHidden('#intro'), 'the hint goes away after the first stone');
assert.equal(await page.textContent('#countLbl'), 'stone');

let p;
for (let i = 0; i < 3; i++) p = await dropCentered(page);
assert.equal(p.state, 'hover', 'four stones dropped over the middle stay up');
assert.equal(p.count, 4);
assert.equal(await page.textContent('#count'), '4');
assert.equal(await page.textContent('#countLbl'), 'stones');

// Turning the phone sideways moves the rock to the new middle, and the cairn goes with it.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(2500);
p = await peek(page);
assert.equal(p.state, 'hover', 'the cairn survives the phone turning sideways');
assert.equal(p.count, 4);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(2500);
assert.equal((await peek(page)).state, 'hover', 'and turning back');

// A stone in the stream ends it, and four is the new best.
await sink(page);
await page.waitForSelector('#over', { state: 'visible' });
assert.equal(await page.textContent('#best'), '4');
assert.match(await page.textContent('#overP'), /4 stones stood — your best\./);
assert.equal(await page.evaluate(() => localStorage.getItem('cairn.best')), '4');

await page.click('#again');
p = await peek(page);
assert.equal(p.state, 'hover');
assert.equal(p.count, 0);
assert.ok(await page.isHidden('#over'));

// The best score is still there after a reload.
await page.reload();
await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
assert.equal(await page.textContent('#best'), '4');

// Zen: a stone in the water washes away and the game goes on.
await page.click('#zen');
assert.equal(await page.textContent('#zen'), 'zen · on');
await dropCentered(page);
await dropCentered(page);
await sink(page);
await page.waitForTimeout(600);
p = await peek(page);
assert.notEqual(p.state, 'over', 'zen never ends');
assert.ok(await page.isHidden('#over'));
assert.equal((await page.evaluate(() => window.cairn.stones().length)), 1, 'the sunk stone washed away');

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');

// Offline: once the page has loaded, it plays with no network.
await page.evaluate(() => navigator.serviceWorker.ready);
await ctx.setOffline(true);
await page.reload();
await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
await dropCentered(page);
assert.equal((await peek(page)).count, 1, 'plays offline');
await ctx.setOffline(false);

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');
await browser.close();
server.close();
console.log('cairn e2e: all passed');

// Plays Cairn in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Stacks stones, turns the phone sideways, knocks the cairn into the stream, checks the best score
// survives a reload, presses the buttons from the keyboard, tries zen mode, and plays once more with the
// network off.
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

// The hint under the stone fits between the round buttons: they stay round and zen stays in the middle.
async function controlsInPlace(page, when) {
  const c = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const L = r('rotL'), Z = r('zen'), R = r('rotR');
    return { sizes: [L.width, L.height, R.width, R.height], zenOff: Z.left + Z.width / 2 - innerWidth / 2 };
  });
  assert.deepEqual(c.sizes, [52, 52, 52, 52], `the rotate buttons stay round ${when}`);
  assert.ok(Math.abs(c.zenOff) < 1, `zen stays in the middle ${when} (it is ${c.zenOff.toFixed(1)}px off)`);
}

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

// A button clicked with the mouse keeps the focus, but Space still lets the stone go.
await page.click('#rotR');
await page.keyboard.press('Space');
assert.equal((await peek(page)).state, 'falling', 'Space after clicking ⟳ drops the stone');

// The best score is still there after a reload.
await page.reload();
await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
assert.equal(await page.textContent('#best'), '4');

// Keyboard: Tab reaches the buttons, and Enter or Space presses the one in focus instead of letting the
// stone go. Zen has no key of its own.
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'rotL');
await page.keyboard.press('Enter');
assert.equal((await peek(page)).state, 'hover', 'Enter on ⟲ does not drop the stone');
await page.waitForFunction(() => window.cairn.peek().angle < -0.2, null, { timeout: 5000 });
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'zen');
await page.keyboard.press('Enter');
p = await peek(page);
assert.equal(p.zen, true, 'Enter on zen turns it on');
assert.equal(p.state, 'hover', 'Enter on zen does not drop the stone');
await page.keyboard.press('Space');
p = await peek(page);
assert.equal(p.zen, false, 'Space on zen turns it off again');
assert.equal(p.state, 'hover', 'Space on zen does not drop the stone');
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
assert.ok(await page.evaluate(() => document.activeElement === document.body), 'Tab leads back out of the buttons');

// From the fifth stone the wind blows, and the first gust says so under the stone (Math.random is held at 0
// for a moment so that it comes now). The hint, and zen's own, fit between the buttons.
for (let i = 0; i < 5; i++) p = await dropCentered(page);
assert.equal(p.state, 'hover', 'five stones dropped over the middle stay up');
assert.equal(p.count, 5);
await page.evaluate(() => { const r = Math.random; Math.random = () => 0; requestAnimationFrame(() => requestAnimationFrame(() => { Math.random = r; })); });
await page.waitForFunction(() => document.getElementById('hint').textContent.startsWith('wind'), null, { timeout: 5000 });
await controlsInPlace(page, 'under the wind hint');
await page.click('#zen');
assert.equal(await page.textContent('#hint'), 'no wind, nothing ends');
await controlsInPlace(page, 'under the zen hint');
await page.click('#zen');
await controlsInPlace(page, 'with no hint');
await sink(page);
await page.waitForSelector('#over', { state: 'visible' });
await page.click('#again');
assert.equal((await peek(page)).count, 0);

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

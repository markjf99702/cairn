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
let offline = false; // while true the server hangs up, so only the offline copy can answer
const server = createServer(async (req, res) => {
  if (offline) { req.socket.destroy(); return; }
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
    let was = null;
    const tick = () => {
      const p = window.cairn.peek(), off = p.state === 'hover' && p.hoverX != null ? p.hoverX - p.width / 2 : null;
      // Within 2px of the middle, or just past it after a slow frame.
      if (off != null && (Math.abs(off) < 2 || (was != null && Math.sign(off) !== Math.sign(was) && Math.abs(off) < 8))) {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        done();
      } else { was = off; requestAnimationFrame(tick); }
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
const watch = page => {
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('requestfailed', r => problems.push('failed: ' + r.url()));
  page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });
};
watch(page);

await page.goto(base);
await page.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
assert.equal(await page.textContent('#best'), '0');
assert.ok(await page.isVisible('#intro'), 'the first-time hint shows');

// Notes every frame where the stone in hand jumps instead of swinging (a new one used to show for a frame
// at the top of the screen first).
await page.evaluate(() => {
  window.jumps = [];
  let was = null;
  const tick = () => {
    const p = window.cairn.peek(), now = p.state === 'hover' ? { count: p.count, x: Math.round(p.hoverX), y: Math.round(p.hoverY) } : null;
    if (now && was && now.count === was.count && Math.abs(now.y - was.y) > 30) window.jumps.push([was, now]);
    was = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

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
await page.waitForTimeout(300);
assert.deepEqual(await page.evaluate(() => window.jumps), [], 'each new stone first shows where it swings');

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
assert.equal(await page.evaluate(() => document.activeElement.id), 'rotR');
await page.keyboard.press('Space');
assert.equal((await peek(page)).state, 'hover', 'Space on ⟳ does not drop the stone');
await page.waitForFunction(() => Math.abs(window.cairn.peek().angle) < 0.01, null, { timeout: 5000 }); // straight again
await page.keyboard.press('Tab');
assert.ok(await page.evaluate(() => document.activeElement === document.body), 'Tab leads back out of the buttons');

// A phone locked just after a drop gets no frames until it's back (here the clock jumps 12 s at once). The
// stone still has to land before it counts and the next one comes.
await page.evaluate(() => new Promise(done => {
  const tick = () => {
    const p = window.cairn.peek();
    if (p.state === 'hover' && Math.abs(p.hoverX - p.width / 2) < 8) {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      const clock = performance.now.bind(performance);
      performance.now = () => clock() + 12000;
      done();
    } else requestAnimationFrame(tick);
  };
  tick();
}));
await page.waitForFunction(() => window.cairn.peek().state !== 'falling', null, { timeout: 15000 });
p = await peek(page);
assert.equal(p.count, 1, 'the stone dropped before the phone was locked counts');
assert.equal(await page.evaluate(() => window.cairn.stones().length), 1, 'the next stone waits until it has landed');

// From the fifth stone the wind blows, and the first gust says so under the stone (Math.random is held at 0
// for a moment so that it comes now). The hint, and zen's own, fit between the buttons.
for (let i = 0; i < 4; i++) p = await dropCentered(page);
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

// Offline: opened once, it plays with no network. It starts from a first visit, when the list in sw.js is all
// the offline copy has, and the server hangs up as well, because Playwright's offline switch doesn't reach the
// service worker's own requests.
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page2 = await ctx2.newPage();
watch(page2);
await page2.goto(base);
await page2.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
await page2.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 })
  .catch(() => assert.fail('the offline copy never took over (does every file in sw.js exist?)'));
offline = true;
await ctx2.setOffline(true);
await page2.reload().catch(e => assert.fail('it did not load offline: ' + e.message.split('\n')[0]));
await page2.waitForFunction(() => window.cairn && window.cairn.peek().state === 'hover');
assert.deepEqual(await page2.evaluate(() => document.fonts.ready.then(f => [...f].filter(x => x.status === 'error').map(x => x.family + ' ' + x.weight))), [], 'the fonts load offline');
await dropCentered(page2);
assert.equal((await peek(page2)).count, 1, 'plays offline');
offline = false;
await ctx2.setOffline(false);

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');
await browser.close();
server.close();
console.log('cairn e2e: all passed');

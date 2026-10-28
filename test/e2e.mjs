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

// Waits for the stone in hand to swing over the middle of the top stone (or of the rock), lets it go, and waits for
// the next one. Over the middle of the screen instead, a stone could hang off the edge of a first one tapped down
// off-centre, and fall. If the round is over there's nothing to let go, and the caller's checks say so.
async function dropOnTop(page) {
  const before = await peek(page);
  await page.evaluate(() => new Promise(done => {
    let was = null;
    const tick = () => {
      const p = window.cairn.peek();
      if (p.state === 'over') { done(); return; }
      const top = window.cairn.stones().reduce((t, s) => (!t || s.bounds.min.y < t.bounds.min.y ? s : t), null);
      const off = p.state === 'hover' && p.hoverX != null ? p.hoverX - (top ? top.position.x : p.width / 2) : null;
      // Within 2px of it, or just past it after a slow frame.
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

// Fits a phone: nothing scrolls sideways or sticks out past the sides of the screen. (html and body don't scroll
// at all here, so the page's own width would pass whatever stuck out; each element is checked as well.)
const sticksOut = () => page.evaluate(() => [
  ...(document.documentElement.scrollWidth > innerWidth ? ['the page'] : []),
  ...[...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); })
    .map(el => el.id || el.className || el.tagName),
]);
assert.deepEqual(await sticksOut(), [], 'nothing sticks out sideways on a phone');

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
for (let i = 0; i < 3; i++) p = await dropOnTop(page);
assert.equal(p.state, 'hover', 'four stones let go on top of each other stay up');
assert.equal(p.count, 4);
assert.equal(await page.textContent('#count'), '4');
assert.equal(await page.textContent('#countLbl'), 'stones');
assert.equal(await page.textContent('#best'), '4', 'the best goes up with the cairn');
assert.equal(await page.evaluate(() => localStorage.getItem('cairn.best')), '4', 'and is saved while the cairn still stands');
await page.waitForTimeout(300);
assert.deepEqual(await page.evaluate(() => window.jumps), [], 'each new stone first shows where it swings');

// Turning the phone sideways moves the rock to the new middle, and the cairn goes with it.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(2500);
p = await peek(page);
assert.equal(p.state, 'hover', 'the cairn survives the phone turning sideways');
assert.equal(p.count, 4);
assert.deepEqual(await sticksOut(), [], 'nothing sticks out sideways with the phone turned');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(2500);
assert.equal((await peek(page)).state, 'hover', 'and turning back');

// A stone in the stream ends it, and four is the best.
await sink(page);
await page.waitForSelector('#over', { state: 'visible' });
assert.deepEqual(await sticksOut(), [], 'nothing on the card sticks out sideways');
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

// And still does after coming back to the tab. Chrome then fires focus at the window, and focus and focusin at
// ⟳ again; by then the Space pressed since the click has made ⟳ look keyboard-focused.
await page.waitForFunction(() => window.cairn.peek().state === 'hover', null, { timeout: 15000 });
assert.ok(await page.evaluate(() => document.activeElement.id === 'rotR' && document.activeElement.matches(':focus-visible')),
  'the test needs ⟳ to have the focus and look keyboard-focused here');
await page.evaluate(() => {
  const el = document.activeElement;
  window.dispatchEvent(new FocusEvent('focus'));
  el.dispatchEvent(new FocusEvent('focus'));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
});
await page.keyboard.press('Space');
assert.equal((await peek(page)).state, 'falling', 'Space after coming back to the tab still drops the stone');

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

// Once five stones stand the wind blows, and the first gust says so under the stone (Math.random is held at 0
// for a moment so that it comes now). The hint, and zen's own, fit between the buttons.
for (let i = 0; i < 4; i++) p = await dropOnTop(page);
assert.equal(p.state, 'hover', 'five stones let go on top of each other stay up');
assert.equal(p.count, 5);
await page.evaluate(() => { const r = Math.random; Math.random = () => 0; requestAnimationFrame(() => requestAnimationFrame(() => { Math.random = r; })); });
await page.waitForFunction(() => document.getElementById('hint').textContent.startsWith('wind'), null, { timeout: 5000 });
const fiveSeconds = page.evaluate(() => new Promise(done => setTimeout(done, 5000))); // ends after the hint's own timer
await controlsInPlace(page, 'under the wind hint');
await page.click('#zen');
assert.equal(await page.textContent('#hint'), 'no wind, nothing ends');
await controlsInPlace(page, 'under the zen hint');
// The wind hint goes after five seconds, but zen's stays as long as zen is on.
await fiveSeconds;
assert.equal(await page.textContent('#hint'), 'no wind, nothing ends', "the wind hint's timer leaves zen's hint alone");
await page.click('#zen');
await controlsInPlace(page, 'with no hint');
await sink(page);
await page.waitForSelector('#over', { state: 'visible' });

// Holding Space down at the card starts one new round, and doesn't let its first stone go as well.
await page.keyboard.down('Space');
await page.keyboard.down('Space'); // the key repeating
await page.keyboard.down('Space');
await page.keyboard.up('Space');
p = await peek(page);
assert.equal(p.state, 'hover', 'holding Space down starts a round and nothing more');
assert.equal(p.count, 0);
assert.equal(await page.evaluate(() => window.cairn.stones().length), 0, 'the new round keeps its first stone in hand');
assert.ok(await page.isHidden('#over'));

// Zen: a stone in the water washes away and the game goes on.
await page.click('#zen');
assert.equal(await page.textContent('#zen'), 'zen · on');
await dropOnTop(page);
await dropOnTop(page);
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
await dropOnTop(page2);
assert.equal((await peek(page2)).count, 1, 'plays offline');
offline = false;
await ctx2.setOffline(false);

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');
// Offline, checked the junkdrawer house kit's way, from a server that answers like GitHub Pages: a browser may keep
// each file for ten minutes, and asks again by its ETag. `net` is the connection: 'up', 'down' (the server drops every
// connection) or 'stalled' (a plane's or a train's wifi: it takes each request and holds on to it). With `release`
// set it serves the next release. The server's own switches are needed because the browser's offline switch can't
// make a stall, and in some Chromium builds it doesn't stop the service worker's own requests.
{
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  let net = 'up', release = false;
  const held = [];
  const server = createServer((req, res) => {
    if (net === 'down') { req.socket.destroy(); return; }
    if (net === 'stalled') { held.push([req, res]); return; }
    serve(req, res);
  }).listen(0);
  async function serve(req, res) {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    let body;
    try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
    if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
    if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
    res.writeHead(200, head);
    res.end(body);
  }
  const base = `http://localhost:${server.address().port}/`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  const title = await page.title();

  // Works offline once it has been opened.
  net = 'down';
  await ctx.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), title, 'the page did not open offline');
  await ctx.setOffline(false);

  // On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
  // the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
  net = 'stalled';
  const t0 = Date.now();
  await page.reload({ timeout: 10000 }).catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
  assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);

  // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
  // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
  release = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  for (const end = Date.now() + 10000; !(await page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')));) {
    assert.ok(Date.now() < end, "the new release's offline copy kept the old index.html");
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(problems, [], 'problems while offline or on a stalled connection');
  await ctx.close();
  server.close();

  // sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js
  // is a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
  // index.html; the first 8 hex of the sha1 of those).
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
  const all = createHash('sha1');
  for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
  const files = all.digest('hex').slice(0, 8);
  assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
}

await browser.close();
server.close();
console.log('cairn e2e: all passed');

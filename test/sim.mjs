// Plays Cairn headless:  node test/sim.mjs  (needs only Node)
// The real js/matter.min.js and js/cairn.js run in a Node vm on a stand-in page, with a seeded Math.random and a
// clock that only moves when the test takes a physics step (1/60 s). So each game here comes out the same every
// run, and the stone in hand can be followed step by step, which the browser test can't do (its frames don't line
// up with the physics steps).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEP = 1000 / 60;
const matterJs = new vm.Script(readFileSync(join(root, 'js/matter.min.js'), 'utf8'), { filename: 'matter.min.js' });
const cairnJs = new vm.Script('"use strict";\n' + readFileSync(join(root, 'js/cairn.js'), 'utf8'), { filename: 'cairn.js' });

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Opens the game on a stand-in phone page. `storage` is its localStorage (a Map), so two pages can share one.
function open({ seed = 1, width = 390, height = 844, storage = new Map() } = {}) {
  const on = (list, type, f) => { (list[type] ||= []).push(f); };
  const fire = (list, type) => (list[type] || []).forEach(f => f({}));
  const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) }); // nothing is drawn here
  const els = {};
  for (const id of ['stage', 'count', 'countLbl', 'best', 'wind', 'intro', 'rotL', 'hint', 'zen', 'rotR', 'over', 'overT', 'overP', 'again']) {
    let text = '';
    els[id] = {
      id, hidden: id === 'over', style: {}, ls: {}, classList: { toggle() {} }, getContext: () => ctx,
      get textContent() { return text; }, set textContent(v) { text = String(v); }, // a page keeps text as a string
      addEventListener(type, f) { on(this.ls, type, f); },
    };
  }
  const timers = [], clock = { now: 1000 };
  const page = {
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 0, // the test takes the steps itself
    setTimeout: (f, ms) => timers.push({ at: clock.now + ms, f }),
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    document: { getElementById: id => els[id], querySelector: () => ({ addEventListener() {} }), addEventListener() {} },
    addEventListener() {},
    navigator: {}, innerWidth: width, innerHeight: height, devicePixelRatio: 2,
  };
  page.window = page;
  vm.createContext(page);
  page.seeded = mulberry32(seed);
  vm.runInContext('Math.random = seeded; delete globalThis.seeded;', page);
  matterJs.runInContext(page);
  const M = page.Matter, create = M.Engine.create;
  let engine;
  M.Engine.create = o => (engine = create(o)); // keeps the game's own engine, so the test can step it
  cairnJs.runInContext(page);
  M.Engine.create = create;

  const g = {
    M, storage,
    peek: () => page.cairn.peek(),
    stones: () => page.cairn.stones(),
    text: id => els[id].textContent,
    step() {
      clock.now += STEP;
      for (const t of timers) if (t.f && t.at <= clock.now) { const f = t.f; t.f = null; f(); }
      M.Engine.update(engine, STEP);
    },
    tap: () => fire(els.stage.ls, 'pointerdown'),
    click: id => fire(els[id].ls, 'click'),
    hold(seconds, each) { for (let k = 0; k < seconds * 60; k++) { g.step(); if (each) each(g.peek()); } },
    // Lets the stone go as it passes over x, then waits for the next stone (or the end).
    dropAt(x) {
      const before = g.peek().count;
      let was = g.peek().hoverX;
      for (let k = 0; k < 60 * 60 && g.peek().state === 'hover'; k++) {
        g.step();
        const now = g.peek().hoverX;
        if ((was - x) * (now - x) <= 0) g.tap();
        was = now;
      }
      assert.equal(g.peek().state, 'falling', `the stone in hand never passed over x = ${Math.round(x)}`);
      for (let k = 0; k < 60 * 15; k++) {
        g.step();
        const p = g.peek();
        if (p.state === 'over' || (p.state === 'hover' && p.count > before)) return p;
      }
      assert.fail('the stone let go never settled');
    },
    // Lets each stone go over the middle of the one on top until n stand.
    stack(n) {
      while (g.peek().count < n) {
        const top = g.stones().reduce((t, s) => (!t || s.bounds.min.y < t.bounds.min.y ? s : t), null);
        const p = g.dropAt(top ? top.position.x : g.peek().width / 2);
        assert.notEqual(p.state, 'over', `the test's own cairn fell at ${p.count} stones (seed ${seed}); try another seed`);
      }
    },
    // Puts the bottom stone in the stream.
    sink() {
      const s = g.stones()[0];
      M.Body.setStatic(s, false);
      M.Body.setPosition(s, { x: s.position.x, y: g.peek().waterY + 100 });
      g.step();
    },
  };
  return g;
}

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message.split('\n')[0]); }
}

check('the wind waits until five stones stand', () => {
  const g = open({ seed: 3 });
  g.stack(4);
  let most = 0;
  g.hold(60, p => { most = Math.max(most, p.wind); });
  assert.equal(most, 0, 'no wind while the fifth stone is in hand');
  g.stack(5);
  g.hold(60, p => { most = Math.max(most, p.wind); });
  assert.ok(most > 0, 'the wind blows on the sixth');
});

// A gust pulls the stone in hand up to 80 px over. It used to get there between one frame and the next, too fast to
// see coming, so a tap already on its way missed. Now it glides there: from one step to the next the stone's speed
// changes by no more than a few px a step (the swing alone changes it by under 1).
check('the wind pulls the stone in hand over smoothly, never in a jump', () => {
  const g = open({ seed: 5 });
  g.click('zen'); // stacked with zen on, so no gust gets in the way
  g.stack(9);
  g.click('zen');
  const xs = [];
  let strongest = 0;
  g.hold(180, p => { xs.push(p.hoverX); strongest = Math.max(strongest, p.wind); });
  assert.ok(strongest > 1, `a strong gust blew while the stone was held (the strongest was ${strongest.toFixed(2)})`);
  let worst = 0;
  for (let k = 2; k < xs.length; k++) worst = Math.max(worst, Math.abs(xs[k] - 2 * xs[k - 1] + xs[k - 2]));
  assert.ok(worst < 6, `the stone in hand jumped: its speed changed by ${worst.toFixed(1)} px a step all at once`);
});

check('a wide window swings the stone no wider than a big phone does', () => {
  const widest = width => {
    const g = open({ seed: 17, width, height: 800 });
    g.click('zen'); // no wind, so the swing is all there is
    g.stack(15);
    let most = 0;
    g.hold(20, p => { most = Math.max(most, Math.abs(p.hoverX - width / 2)); });
    return most;
  };
  assert.ok(Math.abs(widest(390) - 390 * 0.34) < 0.5, 'a phone swings to a third of its width, as before');
  const wide = widest(1280);
  assert.ok(wide < 430 * 0.34 + 0.5, `at 15 stones a 1280 px window swung ${wide.toFixed(0)} px each way`);
});

check('the best is saved as soon as the cairn passes it', () => {
  const g = open({ seed: 7, storage: new Map([['cairn.best', '2']]) });
  assert.equal(g.text('best'), '2');
  g.stack(3);
  assert.equal(g.storage.get('cairn.best'), '3', 'saved while the cairn still stands, so closing the page now keeps it');
  assert.equal(g.text('best'), '3', 'and the corner shows it');
  assert.equal(open({ seed: 8, storage: g.storage }).text('best'), '3', 'a page opened now starts from it');
});

check("a better best saved since in another tab isn't overwritten", () => {
  const storage = new Map([['cairn.best', '2']]);
  const a = open({ seed: 7, storage }), b = open({ seed: 9, storage }); // both opened with a best of 2
  b.stack(5);
  a.stack(3);
  a.sink();
  assert.equal(a.peek().state, 'over');
  assert.equal(storage.get('cairn.best'), '5');
  assert.equal(a.text('best'), '5');
  assert.equal(a.text('overP'), '3 stones stood.', "and the card doesn't call 3 your best");
});

check("a cairn built with zen on doesn't become the best", () => {
  const g = open({ seed: 11 });
  g.click('zen');
  g.stack(3);
  g.click('zen');
  g.sink();
  assert.equal(g.peek().state, 'over');
  assert.equal(g.storage.get('cairn.best'), undefined);
  assert.equal(g.text('best'), '0');
  assert.equal(g.text('overP'), '3 stones stood.');
  // Nor does a round where zen goes on and off again with stones up (it stops a gust on the stone in hand).
  g.click('again');
  g.stack(2);
  assert.equal(g.storage.get('cairn.best'), '2');
  g.click('zen');
  g.click('zen');
  g.stack(4);
  assert.equal(g.storage.get('cairn.best'), '2', 'zen on and off again mid-round');
});

check('trying zen before the first stone still lets the round set the best', () => {
  const g = open({ seed: 13 });
  g.click('zen');
  g.click('zen');
  g.stack(2);
  assert.equal(g.storage.get('cairn.best'), '2');
});

if (failed) { console.log(`cairn sim: ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`cairn sim: all ${passed} passed`);

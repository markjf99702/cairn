// Cairn: stack river stones on a rock in a stream. The physics is matter-js (js/matter.min.js).
// A stone swings above the stack; tap (or Space) to let it go. Once nothing is moving, it counts.
// Once five stones stand, gusts of wind pull at the stone you're holding. Zen mode has no wind,
// and a stone that falls in the water just washes away instead of ending the game.

const $ = id => document.getElementById(id);

if (!window.Matter) {
  $('hint').textContent = 'the physics library did not load';
  throw new Error('matter-js missing');
}
const { Engine, Bodies, Body, Composite, Events, Vertices, Sleeping } = window.Matter;

const cv = $('stage'), ctx = cv.getContext('2d');
const BEST_KEY = 'cairn.best';
const STEP = 1000 / 60; // the physics takes fixed 60 Hz steps, so a 120 Hz phone plays at the same speed as a laptop
const PALETTE = ['#8A8F93', '#7C7670', '#9AA0A3', '#6F6D6A', '#A39A8C', '#7D8A8C', '#928B80', '#5F6B6E', '#B0AAA0'];

let W = 0, H = 0, DPR = 1;
let waterY = 0, baseTop = 0, base = null;
let stones = [], hover = null, state = 'hover', count = 0, zen = false;
let zenRound = false; // zen helped this round (no wind, nothing ends), so it can't set the best
let settleT = 0, fallT = 0, rot = 0;
let wind = 0, gust = 0, windDir = 1, windSeen = false, pull = 0;
let cam = 0, hue0 = skyHue(), t0 = performance.now();

let best = 0;
try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch { }
$('best').textContent = best;

const engine = Engine.create({ gravity: { x: 0, y: 0.75 }, enableSleeping: true }), world = engine.world;
engine.positionIterations = 12;
engine.velocityIterations = 8;

// Where a round's dusk starts: a blue (190), violet, plum or red (340) sky.
function skyHue() { return 190 + Math.random() * 150; }

// ---------- the scene ----------
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  waterY = H * 0.86;
  buildBase();
}

// The rock in the stream. When the window changes size (a phone turned sideways), the rock moves
// to the new middle and the stones on it move with it.
function buildBase() {
  const old = base && { x: base.position.x, y: base.position.y };
  if (base) Composite.remove(world, base);
  const bw = Math.min(W * 0.62, 260), bh = 54;
  const verts = [
    { x: -bw / 2, y: -bh / 2 }, { x: -bw * 0.36, y: -bh * 0.7 }, { x: 0, y: -bh * 0.7 }, { x: bw * 0.38, y: -bh * 0.7 },
    { x: bw / 2, y: -bh / 2 }, { x: bw * 0.44, y: bh / 2 }, { x: -bw * 0.44, y: bh / 2 },
  ];
  base = Bodies.fromVertices(W / 2, waterY - 18, [verts], { isStatic: true, friction: 1, restitution: 0 }, true);
  base.render = { fill: '#5D5A57' };
  baseTop = waterY - 18 - bh * 0.7;
  Composite.add(world, base);
  if (old) {
    const d = { x: base.position.x - old.x, y: base.position.y - old.y };
    stones.forEach(s => Body.translate(s, d));
  }
}

// A slab: dead-flat bottom, a nearly flat (slightly tilted) top, rounded ends.
function stoneVerts(r, elong) {
  const L = r * elong * (0.85 + Math.random() * 0.3), R = r * elong * (0.85 + Math.random() * 0.3), h = r;
  const tl = -h * (1 + (Math.random() - 0.5) * 0.22), tr = -h * (1 + (Math.random() - 0.5) * 0.22);
  const pts = [
    { x: -L * 0.92, y: h }, { x: R * 0.92, y: h },
    { x: R, y: h * 0.45 }, { x: R * 1.02, y: -h * 0.1 }, { x: R * 0.9, y: tr * 0.75 }, { x: R * 0.7, y: tr },
    { x: 0, y: (tl + tr) / 2 - h * 0.03 },
    { x: -L * 0.7, y: tl }, { x: -L * 0.9, y: tl * 0.75 }, { x: -L * 1.02, y: -h * 0.1 }, { x: -L, y: h * 0.45 },
  ];
  return Vertices.clockwiseSort(Vertices.hull(pts));
}

function newStone() {
  const r = 11 + Math.random() * 9, el = 2.2 + Math.random() * 1.4;
  const b = Bodies.fromVertices(W / 2, 110, [stoneVerts(r, el)], { friction: 1, frictionStatic: 1.5, restitution: 0, density: 0.004, frictionAir: 0.015 }, true);
  b.render = { fill: PALETTE[Math.floor(Math.random() * PALETTE.length)], hi: 'rgba(255,255,255,' + (0.10 + Math.random() * 0.12) + ')' };
  Body.setStatic(b, true);
  rot = 0;
  return b;
}

// The stone in hand swings over the stack, wider and faster as it grows, and the wind pushes it. The swing stops
// widening where it does on a big phone (430 px), so on a wide window it doesn't cross the cairn any faster.
function placeHover(now) {
  const amp = Math.min(Math.min(W, 430) * 0.34, 48 + count * 9), sp = 0.0013 + count * 0.0001;
  const x = W / 2 + Math.sin(now * sp) * amp + pull * 55;
  Body.setPosition(hover, { x, y: towerTop() - 85 });
  Body.setAngle(hover, rot);
  hover.sleepCounter = 0;
}

// A new stone goes straight to its place in the swing, so it never shows (or drops) from where it was made.
function spawn() { hover = newStone(); Composite.add(world, hover); state = 'hover'; settleT = 0; placeHover(performance.now()); }

// matter-js lets a stone that is barely moving fall asleep, and a sleeping stone stays put, so one tipping slowly off
// an edge could stop part-way over and count. The stone let go can't fall asleep (sleepThreshold 0) until it counts.
function drop() {
  if (state !== 'hover' || !hover) return;
  Body.setStatic(hover, false); Sleeping.set(hover, false); hover.sleepCounter = 0; hover.sleepThreshold = 0;
  Body.setAngularVelocity(hover, 0); Body.setVelocity(hover, { x: 0, y: 1.5 });
  stones.push(hover); hover = null; state = 'falling'; fallT = 0;
  if (zen) zenRound = true;
  $('intro').hidden = true;
}

// Still enough to count. A stone still turning 0.003 rad a step (10 degrees a second) is still tipping over.
function allSettled() {
  return stones.every(s => s.isSleeping || (s.speed <= 0.12 && Math.abs(s.angularSpeed) <= 0.003));
}
function towerTop() { let y = baseTop; stones.forEach(s => { if (s.bounds.min.y < y) y = s.bounds.min.y; }); return y; }
function showHint(t) { $('hint').textContent = t; }

function setCount(n) {
  count = n;
  $('count').textContent = count;
  $('countLbl').textContent = count === 1 ? 'stone' : 'stones';
}

// The best is saved as soon as the cairn passes it, so a record still standing when the page closes is kept.
// Another tab (or the installed app) may have saved a better one since this page opened, so that's read first.
function noteBest() {
  try { best = Math.max(best, Number(localStorage.getItem(BEST_KEY)) || 0); } catch { }
  if (count > best && !zenRound) {
    best = count;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch { }
  }
  $('best').textContent = best;
}

function gameOver() {
  state = 'over';
  noteBest();
  $('overT').textContent = count >= 12 ? 'That was a real cairn' : count >= 6 ? 'The cairn fell' : 'The stream took it';
  $('overP').textContent = count === 1 ? 'One stone. It happens.'
    : count + ' stones stood' + (count === best && count > 0 && !zenRound ? ' — your best.' : '.') + (wind > 0.5 ? ' The wind had opinions.' : '');
  $('over').hidden = false;
}

function reset() {
  stones.forEach(s => Composite.remove(world, s));
  if (hover) Composite.remove(world, hover);
  stones = []; hover = null; wind = 0; gust = 0; pull = 0; cam = 0; hue0 = skyHue(); zenRound = false;
  setCount(0);
  $('wind').textContent = '';
  $('over').hidden = true;
  spawn();
}

// ---------- the rules, once per physics step ----------
Events.on(engine, 'beforeUpdate', () => {
  const now = performance.now();

  if (state === 'hover' && hover) placeHover(now);

  if (!zen && count >= 5) {
    if (gust > 0) gust -= 0.006;
    else if (Math.random() < 0.0015 + count * 0.0003) {
      gust = 0.5 + Math.random() * Math.min(1, 0.4 + count * 0.08);
      windDir = Math.random() < 0.5 ? -1 : 1;
      if (!windSeen) { // the first gust says what it does for five seconds, unless zen puts its own hint up first
        windSeen = true;
        const hint = 'wind — it pulls the stone you are holding';
        showHint(hint);
        setTimeout(() => { if ($('hint').textContent === hint) showHint(''); }, 5000);
      }
    }
    wind = Math.max(0, gust);
  }
  // The stone in hand follows the wind over about a third of a second, so a gust pulls it across instead of moving
  // it in one frame, too fast to see coming. It drifts back the same way when the wind drops, or zen stops it.
  // A gust fades as the stone catches up, so the stone only goes 60-80% as far as the gust alone would push it.
  pull += (windDir * wind - pull) * 0.05;

  // A stone in the water or off the edge ends the game (or, in zen, washes away).
  stones.slice().forEach(s => {
    if (s.position.y <= waterY + 30 && s.position.x >= -80 && s.position.x <= W + 80) return;
    if (s.position.y > waterY + 600 || zen) { Composite.remove(world, s); stones = stones.filter(z => z !== s); return; }
    if (state !== 'over') gameOver();
  });

  // Once everything has been still for a moment, count what's standing and hand over the next stone.
  // fallT counts physics time, which stops with the frames while the game is out of sight.
  if (state === 'falling') {
    fallT += STEP;
    if (fallT > 500 && allSettled()) {
      settleT += 1;
      if (settleT > 40 && stones.every(s => s.position.y <= waterY + 30)) {
        // A stone that has counted gets heavier, and sleeps again when still (matter's usual 60 steps).
        stones.forEach(s => { if (!s.settledDensity) { s.settledDensity = true; Body.setDensity(s, 0.011); s.sleepThreshold = 60; } });
        setCount(stones.length);
        noteBest();
        spawn();
      }
    } else settleT = 0;
    if (fallT > 9000 && state === 'falling') spawn();
  }

  $('wind').textContent = wind > 0.05 ? 'wind ' + (windDir < 0 ? '←' : '→') + ' ' + '·'.repeat(Math.ceil(wind * 3)) : '';
});

// ---------- drawing ----------
function outline(b) {
  const v = b.vertices;
  ctx.beginPath(); ctx.moveTo(v[0].x, v[0].y);
  for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
  ctx.closePath();
}

function draw(now, dt) {
  const t = (now - t0) / 1000;

  // Sky: a dusk that changes slowly, swinging back and forth across 80 degrees of hue every ten minutes or so. It
  // stays inside 190-340 (blue to red), so it never drifts round to a brown or green sky.
  const mid = Math.min(300, Math.max(230, hue0)), h1 = mid + 40 * Math.sin(t / 90 + Math.asin((hue0 - mid) / 40));
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'hsl(' + h1 + ' 30% 16%)');
  g.addColorStop(0.55, 'hsl(' + ((h1 + 25) % 360) + ' 32% 32%)');
  g.addColorStop(1, 'hsl(' + ((h1 + 60) % 360) + ' 45% 58%)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Distant hills.
  ctx.fillStyle = 'hsla(' + ((h1 + 200) % 360) + ' 20% 22% / .55)';
  ctx.beginPath(); ctx.moveTo(0, H * 0.7);
  for (let x = 0; x < W + 20; x += 20) ctx.lineTo(x, H * 0.7 - 30 * Math.sin(x / 140 + 1.2) - 18 * Math.sin(x / 57));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
  ctx.fillStyle = 'hsla(' + ((h1 + 210) % 360) + ' 22% 16% / .6)';
  ctx.beginPath(); ctx.moveTo(0, H * 0.78);
  for (let x = 0; x < W + 20; x += 20) ctx.lineTo(x, H * 0.78 - 22 * Math.sin(x / 90 + 3) - 10 * Math.sin(x / 33));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();

  // The camera rises with the cairn.
  const target = Math.max(0, H * 0.42 - towerTop());
  cam += (target - cam) * (1 - Math.pow(0.94, dt / STEP));
  ctx.save(); ctx.translate(0, cam);

  const bodies = Composite.allBodies(world);
  bodies.forEach(b => {
    outline(b);
    ctx.fillStyle = b.render.fill; ctx.fill();
    const shade = ctx.createLinearGradient(0, b.bounds.min.y, 0, b.bounds.max.y);
    shade.addColorStop(0, b.render.hi || 'rgba(255,255,255,.14)'); shade.addColorStop(1, 'rgba(0,0,0,.28)');
    ctx.fillStyle = shade; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; ctx.stroke();
    if (b === hover) { // a dotted plumb line from the stone in hand
      ctx.save(); ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(244,239,230,.35)';
      ctx.beginPath(); ctx.moveTo(b.position.x, b.bounds.max.y + 4); ctx.lineTo(b.position.x, waterY); ctx.stroke();
      ctx.restore();
    }
  });

  // Water, and the cairn's reflection in it. The stream keeps a blue-teal of its own (hue 175-200), a little bluer
  // under a blue sky and a little greener under a red one.
  const wh = 200 - (h1 - 190) / 6, wg = ctx.createLinearGradient(0, waterY, 0, H);
  wg.addColorStop(0, 'hsla(' + wh + ' 45% 40% / .85)');
  wg.addColorStop(1, 'hsla(' + (wh + 10) + ' 45% 20% / .95)');
  ctx.fillStyle = wg;
  ctx.beginPath(); ctx.moveTo(0, waterY);
  for (let x = 0; x < W + 8; x += 8) ctx.lineTo(x, waterY + 3 * Math.sin(x / 38 + t * 1.6) + 2 * Math.sin(x / 17 - t * 2.3));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
  ctx.save(); ctx.globalAlpha = 0.18; ctx.translate(0, 2 * waterY); ctx.scale(1, -1);
  bodies.forEach(b => { if (b.bounds.max.y > waterY) return; outline(b); ctx.fillStyle = b.render.fill; ctx.fill(); });
  ctx.restore();
  ctx.restore();

  // Streaks in the air while the wind blows.
  if (wind > 0.05) {
    ctx.strokeStyle = 'rgba(244,239,230,' + (0.10 * wind) + ')'; ctx.lineWidth = 1;
    for (let k = 0; k < 6; k++) {
      const yy = 120 + k * 70 + (t * 40 * windDir) % 30;
      let xs = ((t * 260 * windDir * wind) + k * 170) % (W + 200); if (xs < 0) xs += W + 200; xs -= 100;
      ctx.beginPath(); ctx.moveTo(xs, yy); ctx.quadraticCurveTo(xs + 40 * windDir, yy - 6, xs + 90 * windDir, yy); ctx.stroke();
    }
  }
}

let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min(250, now - last); last = now;
  acc += dt;
  while (acc >= STEP) { Engine.update(engine, STEP); acc -= STEP; }
  draw(now, dt);
  requestAnimationFrame(frame);
}

// ---------- input ----------
// Space and Enter let the stone go (or start the next round), except on a button or link reached with Tab,
// which they press as usual: that's the only way to zen without a mouse. A click leaves the focus on a button
// too, so where the focus came from is noted when it arrives (a key pressed later turns :focus-visible on anyway).
// Coming back to the tab, the window gets focus first and then the button that had it gets focusin again. That
// isn't the focus arriving (a clicked button looks keyboard-focused by then if a key was pressed since), so it
// changes nothing.
let keyFocus = false, refocus = null;
window.addEventListener('focus', () => { refocus = document.activeElement; });
document.addEventListener('focusin', e => {
  const back = e.target === refocus; refocus = null;
  if (back) return;
  try { keyFocus = e.target.matches(':focus-visible'); } catch { keyFocus = true; }
});
cv.addEventListener('pointerdown', () => { if (state !== 'over') drop(); });
document.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'Enter') {
    if (keyFocus && e.target.closest && e.target.closest('button, a')) return;
    e.preventDefault();
    if (e.repeat) return; // a key held down lets one stone go, or starts one round, and that's all
    if (state === 'over') reset(); else drop();
  }
  if (e.code === 'ArrowLeft') rot -= 0.26;
  if (e.code === 'ArrowRight') rot += 0.26;
});
$('rotL').addEventListener('click', () => { rot -= 0.26; });
$('rotR').addEventListener('click', () => { rot += 0.26; });
$('again').addEventListener('click', reset);
// Enter on a footer link should follow the link, not start the next round.
document.querySelector('.jd-foot').addEventListener('keydown', e => e.stopPropagation());
$('zen').addEventListener('click', () => {
  zen = !zen;
  if (zen && stones.length) zenRound = true; // on with stones up, it also stops a gust on the stone in hand
  $('zen').textContent = 'zen · ' + (zen ? 'on' : 'off');
  $('zen').classList.toggle('on', zen);
  wind = 0; gust = 0;
  showHint(zen ? 'no wind, nothing ends' : '');
});
window.addEventListener('resize', resize);

// A read-only look at the game, for test/e2e.mjs and tools/screenshots.mjs.
window.cairn = {
  peek: () => ({ state, count, best, zen, wind, waterY, width: W, hoverX: hover ? hover.position.x : null, hoverY: hover ? hover.position.y : null, angle: hover ? hover.angle : null }),
  stones: () => stones.slice(),
};

resize();
spawn();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

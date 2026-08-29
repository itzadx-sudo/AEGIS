// two canvases behind the app: .living-grid repaints only on resize, .living-field draws per
// frame and idles when nothing animates. Elements opt in with data-fx; the scan uses Field.*

const CW = 13, CH = 7, GAP = 2.5;

let gridEl = null, fieldEl = null, ctx = null, gctx = null;
let cols = 0, rows = 0, dpr = 1, W = 0, H = 0;
let energy = null;
let effects = [];
let scan = null;     // analysis: the persistent orbit scan (or null)
let radar = null;    // results: reactor synced to the radar sweep (or null)
let raf = 0;
let lastBusy = 0, idleCleared = false;
let seed = 987654321;
let reduce = false;

// deterministic PRNG (Math.random-free so the field is reproducible frame to frame)
function rnd() { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; }
function easeOut(p) { return 1 - Math.pow(1 - p, 3); }

// colour ramp: warm ember-grey → crimson → crimson-light (matches the app's brand reds)
function paint(e) {
  let cr, cg, cb, t;
  if (e < 0.5) { t = e / 0.5; cr = 168 + (255 - 168) * t; cg = 96 + (59 - 96) * t; cb = 96 + (74 - 96) * t; }
  else { t = (e - 0.5) / 0.5; cr = 255; cg = 59 + (124 - 59) * t; cb = 74 + (115 - 74) * t; }
  return [cr | 0, cg | 0, cb | 0];
}
function rrect(c, x, y, w, h, rad) { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, rad); else c.rect(x, y, w, h); c.fill(); }
function hash(c, r) { const x = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453; return x - Math.floor(x); }

function addEnergy(cx, cy, radius, amount) {
  if (!energy) return;
  const c0 = Math.max(0, Math.floor((cx - radius) / CW)), c1 = Math.min(cols - 1, Math.ceil((cx + radius) / CW));
  const r0 = Math.max(0, Math.floor((cy - radius) / CH)), r1 = Math.min(rows - 1, Math.ceil((cy + radius) / CH));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const ex = c * CW + CW / 2, ey = r * CH + CH / 2, d = Math.hypot(ex - cx, ey - cy);
    if (d > radius) continue;
    const i = r * cols + c, add = amount * (1 - d / radius);
    if (add > 0) energy[i] = Math.min(1.3, energy[i] + add);
  }
}
function depositRing(cx, cy, radius, band, amp) {
  const outer = radius + band;
  const c0 = Math.max(0, Math.floor((cx - outer) / CW)), c1 = Math.min(cols - 1, Math.ceil((cx + outer) / CW));
  const r0 = Math.max(0, Math.floor((cy - outer) / CH)), r1 = Math.min(rows - 1, Math.ceil((cy + outer) / CH));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const ex = c * CW + CW / 2, ey = r * CH + CH / 2, d = Math.hypot(ex - cx, ey - cy);
    const g = 1 - Math.abs(d - radius) / band;
    if (g <= 0) continue;
    const i = r * cols + c, v = amp * g * g;
    if (energy[i] < v) energy[i] = v;
  }
}
function sparkle(cx, cy, radius, count, amp) {
  for (let s = 0; s < count; s++) {
    const a = rnd() * 6.2832, rr = radius * (0.55 + 0.45 * rnd());
    addEnergy(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 6.5, amp);
  }
}

// ─────────────── effects ───────────────
function ripple(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const born = performance.now(), dur = o.dur || 1050, maxR = o.maxR || 118, band = o.band || 16,
        strength = o.strength || 1.35, sparks = o.sparks || 6;
  let sparked = false;
  effects.push((now) => {
    const p = (now - born) / dur;
    if (p >= 1) return false;
    const radius = maxR * easeOut(p), fade = (1 - p) * (1 - p);
    depositRing(x, y, radius, band, strength * fade);
    addEnergy(x, y, Math.max(6, radius * 0.34), strength * fade * 0.65);
    if (!sparked && p > 0.1) { sparked = true; sparkle(x, y, radius, sparks, 1.3); }
    return true;
  });
}
function bloom(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const born = performance.now(), dur = o.dur || 1300, maxR = o.maxR || 140, strength = o.strength || 1.5;
  let sparked = false;
  effects.push((now) => {
    const p = (now - born) / dur;
    if (p >= 1) return false;
    const radius = maxR * easeOut(p), fade = 1 - p;
    addEnergy(x, y, radius, strength * fade * 0.7);
    depositRing(x, y, radius, 15, strength * fade * 1.15);
    if (!sparked && p > 0.05) { sparked = true; sparkle(x, y, radius * 0.7, 12, 1.3); }
    return true;
  });
}
function burst(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const born = performance.now(), dur = o.dur || 1200, maxR = o.maxR || 150, strength = o.strength || 1.5,
        rays = o.rays || 12, base = rnd() * 6.2832;
  effects.push((now) => {
    const p = (now - born) / dur;
    if (p >= 1) return false;
    const radius = maxR * easeOut(p), fade = (1 - p) * (1 - p);
    for (let k = 0; k < rays; k++) {
      const a = base + k / rays * 6.2832;
      addEnergy(x + Math.cos(a) * radius, y + Math.sin(a) * radius, 7, strength * fade);
      addEnergy(x + Math.cos(a) * radius * 0.6, y + Math.sin(a) * radius * 0.6, 5.5, strength * fade * 0.5);
    }
    addEnergy(x, y, 10, strength * fade * 0.5);
    return true;
  });
}
function swirl(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const born = performance.now(), dur = o.dur || 1400, maxR = o.maxR || 128, strength = o.strength || 1.45,
        arms = o.arms || 4, turns = o.turns || 1.4;
  effects.push((now) => {
    const p = (now - born) / dur;
    if (p >= 1) return false;
    const radius = maxR * easeOut(p), fade = 1 - p, rot = p * 6.2832 * turns;
    for (let k = 0; k < arms; k++) for (let j = 0; j < 4; j++) {
      const rr = radius * (0.35 + 0.22 * j), a = rot + k / arms * 6.2832 - j * 0.45;
      addEnergy(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 6.5, strength * fade);
    }
    return true;
  });
}
function cascade(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const born = performance.now(), dur = o.dur || 1200, dist = o.dist || 134, strength = o.strength || 1.4, streams = o.streams || 6;
  const jit = []; for (let q = 0; q < streams; q++) jit.push((rnd() - 0.5) * 6);
  effects.push((now) => {
    const p = (now - born) / dur;
    if (p >= 1) return false;
    const fade = 1 - p, head = dist * easeOut(p);
    for (let k = 0; k < streams; k++) {
      const xx = x + (k - (streams - 1) / 2) * 11 + jit[k];
      addEnergy(xx, y + head, 6, strength * fade);
      addEnergy(xx, y + head * 0.62, 5, strength * fade * 0.6);
    }
    return true;
  });
}
function scatter(x, y, o = {}) {
  if (!fieldEl || reduce) return;
  const rad = o.radius || 42, n = o.count || 12, born = performance.now();
  let puffed = false;
  sparkle(x, y, rad, n, 1.3);
  effects.push((now) => {
    if (now - born < 90) return true;
    if (!puffed) { puffed = true; sparkle(x, y, rad * 0.7, (n / 2) | 0, 1.2); }
    return false;
  });
}

// ─────────────── the analysis scan — ROAMERS (active-processing across the whole display) ───────────────
// points wandering the whole viewport, seeded so the motion is reproducible frame to frame
const ROAMERS = 18;
function startScan() {
  if (!fieldEl || reduce) return;
  const parts = [];
  for (let i = 0; i < ROAMERS; i++) {
    parts.push({
      x: rnd() * W, y: rnd() * H,
      a: rnd() * 6.2832,                 // heading
      sp: 0.05 + rnd() * 0.13,           // px/ms — a spread of speeds
      turn: (rnd() - 0.5) * 0.0011,      // baseline curve
      wob: rnd() * 6.2832,               // wander phase offset
      ws: 0.5 + rnd() * 1.3,             // wander rate
      rad: 6 + rnd() * 5,                // point radius
      br: 0.8 + rnd() * 0.5,             // per-point brightness
    });
  }
  scan = { on: true, prev: 0, life: 0, parts };
}
function stopScan() { if (scan) scan.on = false; }   // fade the swarm out, then retire
function setScanProgress() {}   // no-op — kept so the loader's call stays safe

function stepScan(now) {
  const s = scan;
  const dt = s.prev ? Math.min(now - s.prev, 40) : 16; s.prev = now;
  s.life = s.on ? Math.min(1, s.life + dt / 900) : Math.max(0, s.life - dt / 700);
  if (!s.on && s.life <= 0) { scan = null; return; }
  for (const p of s.parts) {
    // curve + a wandering term so no two paths track each other → organic, non-repetitive motion
    p.a += p.turn * dt + Math.sin(p.wob + now * 0.0006 * p.ws) * 0.007;
    p.x += Math.cos(p.a) * p.sp * dt;
    p.y += Math.sin(p.a) * p.sp * dt;
    // wrap on every edge so they roam the full screen rather than clustering
    if (p.x < -24) p.x = W + 24; else if (p.x > W + 24) p.x = -24;
    if (p.y < -24) p.y = H + 24; else if (p.y > H + 24) p.y = -24;
    addEnergy(p.x, p.y, p.rad * 2, 0.22 * s.life * p.br);   // soft halo
    addEnergy(p.x, p.y, p.rad, 0.78 * s.life * p.br);       // core (leaves a wake via global decay)
  }
}

// ─────────────── results: radar reactor ───────────────
// reads the radar sweep's rotation each frame and lays a matching arm from the dial centre
function startRadar(hostEl, sweepEl) {
  if (!fieldEl || reduce || !hostEl) return;
  radar = { host: hostEl, sweep: sweepEl };
}
function stopRadar() { radar = null; }

function stepRadar() {
  const r = radar.host.getBoundingClientRect();
  if (!r.width) return;
  if (r.bottom <= 0 || r.top >= window.innerHeight) return;   // dial scrolled off-screen → don't sweep "way up"
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let rot = 0;
  const t = radar.sweep && getComputedStyle(radar.sweep).transform;   // live animated matrix
  if (t && t !== "none") {
    const m = t.slice(t.indexOf("(") + 1, -1).split(",").map(Number);
    rot = Math.atan2(m[1], m[0]);   // rotate(θ) → matrix(cosθ,sinθ,…) → θ = atan2(b,a)
  }
  const ang = rot - Math.PI / 2;              // CSS conic 0° is "up"; align the field arm with the sweep
  const maxR = Math.min(r.width, r.height) * 0.5;   // stay within the dial — no long stick into the field
  for (let s = 0; s < 3; s++) {               // a short, bright wedge — brightest at the leading edge
    const a = ang - s * 0.09, aw = 1 - s * 0.28;
    for (let rr = 12; rr <= maxR; rr += 6) {
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      addEnergy(x, y, 6, (0.4 + 0.8 * (rr / maxR)) * aw);
    }
  }
}

// ─────────────── render loop (self-idling) ───────────────
function busy() { return effects.length > 0 || scan !== null || radar !== null; }
function step(now) {
  for (let i = effects.length - 1; i >= 0; i--) { if (!effects[i](now)) effects.splice(i, 1); }
  if (scan) stepScan(now);
  if (radar) stepRadar();
}
function frame(now) {
  if (!ctx || !energy) return;   // guard against a teardown race (StrictMode remount)
  const b = busy();
  if (b) { lastBusy = now; idleCleared = false; }
  if (!b && now - lastBusy >= 1000) {
    if (!idleCleared) { ctx.clearRect(0, 0, W, H); energy.fill(0); idleCleared = true; }
    raf = requestAnimationFrame(frame);
    return;
  }
  ctx.clearRect(0, 0, W, H);
  step(now);
  const fullW = CW - GAP, fullH = CH - GAP;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    let e = energy[i];
    e *= 0.928; if (e < 0.001) e = 0; energy[i] = e;   // slow decay → soft lingering trails
    const disp = e;
    if (disp < 0.03) continue;
    const s = 0.42 + 0.58 * disp;
    const w = fullW * s, h = fullH * s;
    const x = c * CW + (CW - w) / 2, y = r * CH + (CH - h) / 2;
    const col = paint(disp);
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.06 + 0.9 * disp).toFixed(3)})`;
    rrect(ctx, x, y, w, h, 1.5);
  }
  raf = requestAnimationFrame(frame);
}

function drawGrid() {
  gctx.clearRect(0, 0, W, H);
  const fullW = CW - GAP, fullH = CH - GAP, sc = 0.5, w = fullW * sc, h = fullH * sc;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = 0.04 + 0.05 * hash(c, r), col = paint(v);
    gctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.05 + 0.055 * (v / 0.09)).toFixed(3)})`;
    const x = c * CW + (CW - w) / 2, y = r * CH + (CH - h) / 2;
    rrect(gctx, x, y, w, h, 1.5);
  }
}
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  for (const el of [fieldEl, gridEl]) {
    el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
    el.style.width = W + "px"; el.style.height = H + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
  energy = new Float32Array(cols * rows);
  // roamers keep their coords across a resize; the edge-wrap in stepScan pulls any now-offscreen ones back in
  idleCleared = false;
  drawGrid();
}

// severity → filter-chip burst (intensity + distance both scale with the risk level)
const SEV_FX = {
  all: { maxR: 156, rays: 22, strength: 2.5,  count: 32, radius: 100 },   // the "All" chip — biggest pop
  vh: { maxR: 120, rays: 16, strength: 2.0,  count: 22, radius: 76 },
  h:  { maxR: 100, rays: 13, strength: 1.7,  count: 18, radius: 62 },
  m:  { maxR: 82,  rays: 11, strength: 1.4,  count: 14, radius: 50 },
  mn: { maxR: 62,  rays: 9,  strength: 1.15, count: 10, radius: 38 },
  l:  { maxR: 46,  rays: 7,  strength: 0.9,  count: 6,  radius: 28 },
};

// declarative click routing: an element's `data-fx` decides its effect; plain buttons get a soft ripple
function onClick(e) {
  if (!fieldEl || reduce) return;
  // a script-driven .click() has no pointer coords and would fire in the top-left corner
  if (!e.isTrusted) return;
  const fxEl = e.target.closest("[data-fx]");
  const anchor = fxEl || e.target.closest('button, [role="button"], a');
  if (!anchor) return;
  let x = e.clientX, y = e.clientY;
  // keyboard activation (Enter/Space) reports (0,0) — anchor to the element's centre, not the corner
  if (x === 0 && y === 0) { const r = anchor.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
  if (fxEl) {
    const fx = fxEl.getAttribute("data-fx");
    if (fx === "none") return;             // element opts out; its component fires an effect conditionally
    addEnergy(x, y, 7, 0.95);              // instant spark → feedback is immediate, before the effect ramps in
    switch (fx) {
      case "nav-ripple": ripple(x, y, { dur: 1650, maxR: 134, strength: 1.95, sparks: 13 }); break;
      case "nav-swirl":  swirl(x, y, { dur: 1600, maxR: 140, strength: 1.9, arms: 5, turns: 1.5 }); break;
      case "nav-burst":  burst(x, y, { dur: 1450, maxR: 165, strength: 1.9, rays: 14 }); break;
      case "bloom":      bloom(x, y); break;
      case "cascade":    cascade(x, y); break;
      case "swirl-sm":   swirl(x, y, { maxR: 74, strength: 1.15, arms: 3 }); break;
      case "sevburst": {
        const f = SEV_FX[fxEl.getAttribute("data-sev")] || SEV_FX.m;
        burst(x, y, { maxR: f.maxR, rays: f.rays, strength: f.strength, dur: 950 });
        scatter(x, y, { count: f.count, radius: f.radius });
        break;
      }
      default: ripple(x, y);
    }
    return;
  }
  // plain button/link (anchor is guaranteed non-null here) → soft ripple
  addEnergy(x, y, 7, 0.95); ripple(x, y, { maxR: 96, strength: 1.1 });
}

export const Field = { ripple, bloom, burst, swirl, cascade, scatter, startScan, stopScan, setScanProgress, startRadar, stopRadar };

export function initLivingField(grid, field) {
  if (!grid || !field) return;
  if (raf) cancelAnimationFrame(raf);   // never leave a stray loop running on an unpaired re-init
  gridEl = grid; fieldEl = field;
  ctx = field.getContext("2d"); gctx = grid.getContext("2d");
  reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  effects = []; scan = null; radar = null;
  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("click", onClick);
  if (!reduce) raf = requestAnimationFrame(frame);
}
export function destroyLivingField() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0; effects = []; scan = null; radar = null;
  window.removeEventListener("resize", resize);
  document.removeEventListener("click", onClick);
  gridEl = fieldEl = ctx = gctx = energy = null;
}

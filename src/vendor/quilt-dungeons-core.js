// src/vendor/quilt-dungeons-core.js
// VENDORED-PENDING-MERGE — the quilt-dungeons core contract, minimal implementation.
//
// Provenance: wave-73b lane b (dungeon-syncopation). GET /repos/SuperInstance/
// quilt-dungeons returned 404 at build time (2026-10-03), so per the mission the
// contract is implemented MINIMALLY here and marked vendored-pending-merge.
// Replace by upstream import when SuperInstance/quilt-dungeons is pushable.
//
// THE CONTRACT (three calls everything else builds on):
//   newGame(seed, opts) -> game     // deterministic from seed alone
//   step(game, action)  -> receipt  // one tick; the receipt is the record
//   fork(game)          -> game     // clone at a stable point; replay-safe
// Laws:
//   * byte-deterministic: same seed + same action stream => byte-equal receipt log
//   * fork is a deep clone of (state + rng cursor) — no hidden closures
//   * receipts are append-only; every state change flows through a receipt
//   * no wall-clock, no network, no I/O inside the core
//
// The world: a small dungeon (rooms = open floor bordered by walls). The agent
// collects treasures (+10), drinks potions (+30 hp), steps on hazards (−8 hp),
// touches the exit once (+50), and dies if hp hits 0 (−20 penalty, slot over).

export const DAMAGE = 8;
export const POTION_HEAL = 30;
export const TREASURE_VALUE = 10;
export const EXIT_BONUS = 50;
export const DEATH_PENALTY = 20;

// ── deterministic rng: state lives IN the game (fork-safe, no closures) ─────
function nextRand(g) {
  let s = (g.rngState + 0x6d2b79f5) >>> 0;
  g.rngState = s;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pickFreeCell(g, occupied) {
  for (let i = 0; i < 10000; i++) {
    const x = 1 + Math.floor(nextRand(g) * (g.w - 2));
    const y = 1 + Math.floor(nextRand(g) * (g.h - 2));
    if (g.grid[y][x] !== '.') continue;
    const k = x + ',' + y;
    if (k === occupied.player || k === occupied.exit || occupied.taken.has(k)) continue;
    occupied.taken.add(k);
    return { x, y };
  }
  throw new Error('E_NO_FREE_CELL');
}

export function newGame(seed, opts = {}) {
  const w = opts.w ?? 21, h = opts.h ?? 15;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.');
    grid.push(row);
  }
  const g = {
    seed, w, h, grid, rngState: seed >>> 0,
    t: 0, score: 0, finished: false, finishedAt: null, cause: null,
    player: { x: 1, y: 1 }, exit: { x: w - 2, y: h - 2 },
    hp: 100, maxHp: 100, exitTouched: false,
    treasures: [], potions: [], hazards: [],
    visited: grid.map((row, y) => row.map((_, x) => x === 1 && y === 1)),
    receipts: [], // append-only: one row per step (the replay chain)
  };
  const occupied = { player: '1,1', exit: `${w - 2},${h - 2}`, taken: new Set() };
  const nT = opts.treasures ?? 8, nP = opts.potions ?? 3, nH = opts.hazards ?? 14;
  for (let i = 0; i < nT; i++) g.treasures.push({ ...pickFreeCell(g, occupied), value: TREASURE_VALUE, taken: false });
  for (let i = 0; i < nP; i++) g.potions.push({ ...pickFreeCell(g, occupied), used: false });
  for (let i = 0; i < nH; i++) g.hazards.push({ ...pickFreeCell(g, occupied) });
  return g;
}

const DELTAS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], wait: [0, 0] };

export function step(g, action) {
  if (g.finished) throw new Error('E_FINISHED — slot is over; do not step a finished game');
  const d = DELTAS[action];
  if (!d) throw new Error(`E_BAD_ACTION ${action}`);
  const nx = g.player.x + d[0], ny = g.player.y + d[1];
  let event = 'wait';
  let dScore = 0;
  if (action !== 'wait') {
    if (g.grid[ny]?.[nx] === undefined || g.grid[ny][nx] === '#') {
      event = 'bump';
    } else {
      g.player.x = nx; g.player.y = ny;
      g.visited[ny][nx] = true;
      event = 'move';
      const tr = g.treasures.find((t) => !t.taken && t.x === nx && t.y === ny);
      if (tr) { tr.taken = true; dScore += tr.value; event = 'treasure'; }
      const po = g.potions.find((p) => !p.used && p.x === nx && p.y === ny);
      if (po) { po.used = true; g.hp = Math.min(g.maxHp, g.hp + POTION_HEAL); dScore += 2; if (event === 'move') event = 'potion'; }
      const hz = g.hazards.find((z) => z.x === nx && z.y === ny);
      if (hz) {
        g.hp -= DAMAGE; dScore -= DAMAGE; event = 'hazard';
        if (g.hp <= 0) { g.hp = 0; dScore -= DEATH_PENALTY; event = 'death'; g.finished = true; g.finishedAt = g.t + 1; g.cause = 'death'; }
      }
      if (!g.finished && !g.exitTouched && nx === g.exit.x && ny === g.exit.y) {
        g.exitTouched = true; dScore += EXIT_BONUS; event = 'exit';
      }
    }
  }
  g.t += 1;
  const receipt = { t: g.t, x: g.player.x, y: g.player.y, action, event, dScore, hp: g.hp, score: g.score };
  g.score += dScore;
  receipt.score = g.score; // score AFTER the delta (the receipt is the record)
  g.receipts.push(receipt);
  return receipt;
}

// fork — THE STABLE POINT. Deep clone of state + rng cursor; the fork replays
// byte-identically given the same action stream (tested in tests/core.test.mjs).
export function fork(g) {
  return structuredClone(g);
}

// windowScore — the receipt fold the composer digests: sum of dScore over
// receipts with t in (t0, t1]. A finished slot just stops contributing.
export function windowScore(g, t0, t1) {
  let s = 0, n = 0;
  for (const r of g.receipts) if (r.t > t0 && r.t <= t1) { s += r.dScore; n++; }
  return { score: s, steps: n };
}

// windowEvents — what happened in the window, folded to counts (digest fuel).
export function windowEvents(g, t0, t1) {
  const counts = {};
  for (const r of g.receipts) if (r.t > t0 && r.t <= t1) counts[r.event] = (counts[r.event] ?? 0) + 1;
  return counts;
}

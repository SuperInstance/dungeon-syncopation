// src/strategy.js — the strategy-script schema, the policy that runs one, and
// THE MUTATION MENU (the seeded menu the composer mutates from — the
// system-one path-of-least-resistance: when the slow thought is unavailable,
// the well-worn default is taken and receipted as source:'menu').
//
// A strategy script is DATA: { id, params, priority }. The same policy engine
// runs every script; scripts differ only in parameters and goal priority. That
// is what makes a composer's mutation meaningful and byte-deterministic.



export const PARAM_SCHEMA = {
  treasureWeight: { min: 0.1, max: 4, def: 1.0 },  // pull of treasure tiles
  hazardFear:     { min: 0.1, max: 4, def: 1.0 },  // penalty per hazard on path
  exploreBias:    { min: 0,   max: 4, def: 0.2 },  // pull of unseen floor
  potionAtHp:     { min: 0.15, max: 0.8, def: 0.5 },// seek potions below this hp fraction
  exitEagerHp:    { min: 0.15, max: 0.8, def: 0.35 },// rush exit below this hp fraction
  stepHorizon:    { min: 3, max: 10, def: 6, int: true }, // BFS clairvoyance radius
};
export const PRIORITY_TYPES = ['potion', 'treasure', 'exit', 'explore'];
const PRIORITY_BOOST = [1.15, 1.0, 0.9, 0.82]; // earlier in priority = louder

export function baseScript(id = 'S-base-v0') {
  const params = {};
  for (const [k, v] of Object.entries(PARAM_SCHEMA)) params[k] = v.def;
  return { id, params, priority: [...PRIORITY_TYPES] };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function normalizeScript(s) {
  const params = {};
  for (const [k, v] of Object.entries(PARAM_SCHEMA)) {
    let x = s.params[k];
    x = v.int ? Math.round(clamp(Number(x), v.min, v.max)) : clamp(Number(x), v.min, v.max);
    params[k] = x;
  }
  const priority = [...s.priority];
  return { id: s.id, params, priority };
}

// ── THE MUTATION MENU (deterministic; every op is a rule-based mutation of an
// incumbent: parameter tweaks, threshold flips, priority swaps) ──────────────
export const MENU = [
  { tag: 'treasure-up',    op: 'scale', param: 'treasureWeight', factor: 1.6 },
  { tag: 'treasure-down',  op: 'scale', param: 'treasureWeight', factor: 0.6 },
  { tag: 'fear-up',        op: 'scale', param: 'hazardFear',     factor: 1.8 },
  { tag: 'fear-down',      op: 'scale', param: 'hazardFear',     factor: 0.45 },
  { tag: 'explore-up',     op: 'scale', param: 'exploreBias',    factor: 2.5 },
  { tag: 'explore-down',   op: 'scale', param: 'exploreBias',    factor: 0.3 },
  { tag: 'potion-low',     op: 'set',   param: 'potionAtHp',     value: 0.32 },
  { tag: 'potion-high',    op: 'set',   param: 'potionAtHp',     value: 0.68 },
  { tag: 'exit-low',       op: 'set',   param: 'exitEagerHp',    value: 0.22 },
  { tag: 'exit-high',      op: 'set',   param: 'exitEagerHp',    value: 0.6 },
  { tag: 'horizon-short',  op: 'set',   param: 'stepHorizon',    value: 4 },
  { tag: 'horizon-long',   op: 'set',   param: 'stepHorizon',    value: 9 },
  { op: 'swapPriority', a: 0, b: 1, tag: 'swap-potion-treasure' },
  { op: 'swapPriority', a: 1, b: 2, tag: 'swap-treasure-exit' },
  { op: 'swapPriority', a: 2, b: 3, tag: 'swap-exit-explore' },
];

export function menuOp(idx) { return MENU[((idx % MENU.length) + MENU.length) % MENU.length]; }

// applyMutation — parent script + menu op -> new script (parent untouched).
export function applyMutation(parent, op, newId) {
  const child = normalizeScript(parent);
  child.id = newId;
  if (op.op === 'scale') child.params[op.param] = child.params[op.param] * op.factor;
  else if (op.op === 'set') child.params[op.param] = op.value;
  else if (op.op === 'swapPriority') {
    const a = child.priority[op.a]; child.priority[op.a] = child.priority[op.b]; child.priority[op.b] = a;
  } else throw new Error(`E_BAD_OP ${op.op}`);
  return normalizeScript(child);
}

// mapIdeaToMenu — the model's one idea (system-two) is CONstrained to the same
// menu: {param, direction} -> matching menu entry; unmappable -> null (the
// caller rolls the seeded menu instead). The model suggests; the menu decides.
export function mapIdeaToMenu(idea) {
  if (!idea || typeof idea !== 'object') return null;
  const param = String(idea.param ?? '').trim();
  const direction = String(idea.direction ?? '').trim().toLowerCase();
  if (param === 'priority' || direction === 'swap') {
    return MENU.find((m) => m.op === 'swapPriority') ?? null;
  }
  if (!PARAM_SCHEMA[param]) return null;
  const up = direction === 'up' || direction === 'more' || direction === 'higher';
  const down = direction === 'down' || direction === 'less' || direction === 'lower';
  if (!up && !down) return null;
  return MENU.find((m) => m.param === param && m.op !== 'swapPriority' &&
    ((up && (m.op === 'set' ? (m.value > PARAM_SCHEMA[param].def) : m.factor > 1)) ||
     (down && (m.op === 'set' ? (m.value < PARAM_SCHEMA[param].def) : m.factor < 1)))) ?? null;
}

// ── THE POLICY (one engine, every script) ───────────────────────────────────
// Clairvoyant within stepHorizon: BFS over floor; candidate goals scored as
//   U = base(type) − dist − hazardOnPath·hazardFear·0.8, then ×priority boost.
// base: treasure 10·treasureWeight · potion 30 if hpFrac<=potionAtHp else 3
//       exit 50 if hpFrac<=exitEagerHp, 60 if treasures exhausted, else 10
//       explore 2·exploreBias
// Fallback beyond horizon: full-map BFS to nearest unseen floor, else exit.
// Deterministic tie-breaks everywhere (goal order, then action order).
const ACT_ORDER = ['up', 'left', 'right', 'down'];

export function decide(g, script) {
  if (g.finished) throw new Error('E_FINISHED');
  const p = script.params;
  const s = normalizeScript(script);
  const hpFrac = g.hp / g.maxHp;
  const start = g.player.y * g.w + g.player.x;
  const maxD = s.params.stepHorizon;

  const dist = new Int16Array(g.w * g.h).fill(-1);
  const parent = new Int32Array(g.w * g.h).fill(-1);
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && g.grid[y][x] === '.';
  const hazardAt = new Set(g.hazards.map((z) => z.y * g.w + z.x));
  const q = [start]; dist[start] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % g.w, cy = (c - cx) / g.w, dc = dist[c];
    if (dc >= maxD) continue;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const nx2 = cx + dx, ny2 = cy + dy;
      if (!isFloor(nx2, ny2)) continue;
      const n = ny2 * g.w + nx2;
      if (dist[n] === -1) { dist[n] = dc + 1; parent[n] = c; q.push(n); }
    }
  }

  const pathOf = (cell) => { const path = []; let c = cell; while (c !== start && c !== -1) { path.push(c); c = parent[c]; } return path.reverse(); };
  const hazardPenaltyOf = (cell) => { let h = 0; for (const c of pathOf(cell)) if (hazardAt.has(c)) h++; return h; };

  const goalOf = (list, taken) => {
    let best = null;
    for (const it of list) {
      if (taken(it)) continue;
      const d = dist[it.y * g.w + it.x];
      if (d < 1) continue; // unreachable-in-horizon or current cell
      if (!best || d < best.d) best = { d, cell: it.y * g.w + it.x };
    }
    return best;
  };
  const treasuresLeft = g.treasures.filter((t) => !t.taken).length;
  const cands = [];
  const tr = goalOf(g.treasures, (t) => t.taken);
  if (tr) cands.push({ type: 'treasure', ...tr });
  const po = goalOf(g.potions, (x) => x.used);
  if (po) cands.push({ type: 'potion', ...po });
  const ex = dist[g.exit.y * g.w + g.exit.x] > 0 ? { d: dist[g.exit.y * g.w + g.exit.x], cell: g.exit.y * g.w + g.exit.x } : null;
  if (ex) cands.push({ type: 'exit', ...ex });
  // nearest unseen floor within horizon
  let unseen = null;
  for (let c = 0; c < g.w * g.h; c++) {
    if (dist[c] < 1) continue;
    const cx = c % g.w, cy = (c - cx) / g.w;
    if (g.visited[cy][cx]) continue;
    if (!unseen || dist[c] < unseen.d) unseen = { d: dist[c], cell: c };
  }
  if (unseen) cands.push({ type: 'explore', ...unseen });

  const baseOf = (type) => type === 'treasure' ? 10 * s.params.treasureWeight
    : type === 'potion' ? (hpFrac <= s.params.potionAtHp ? 30 : 3)
    : type === 'exit' ? (hpFrac <= s.params.exitEagerHp ? 50 : (treasuresLeft === 0 ? 60 : 10))
    : 2 * s.params.exploreBias;

  let best = null;
  for (const c of cands) {
    const pi = s.priority.indexOf(c.type);
    const u = (baseOf(c.type) - c.d - hazardPenaltyOf(c.cell) * s.params.hazardFear * 0.8) * PRIORITY_BOOST[pi];
    if (!best || u > best.u + 1e-12) best = { ...c, u };
  }

  if (best && best.u > -1e9 && best.cell !== start) {
    const path = pathOf(best.cell);
    if (path.length > 0) {
      const nxt = path[0], nx2 = nxt % g.w, ny2 = (nxt - nx2) / g.w;
      const cx = g.player.x, cy = g.player.y;
      if (ny2 < cy) return 'up';
      if (nx2 < cx) return 'left';
      if (nx2 > cx) return 'right';
      return 'down';
    }
  }

  // Fallback (nothing scored within horizon): full-map BFS for nearest unseen.
  const dist2 = new Int16Array(g.w * g.h).fill(-1);
  const parent2 = new Int32Array(g.w * g.h).fill(-1);
  const q2 = [start]; dist2[start] = 0;
  let far = null;
  for (let qi = 0; qi < q2.length; qi++) {
    const c = q2[qi], cx = c % g.w, cy = (c - cx) / g.w;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const nx2 = cx + dx, ny2 = cy + dy;
      if (!isFloor(nx2, ny2)) continue;
      const n = ny2 * g.w + nx2;
      if (dist2[n] !== -1) continue;
      dist2[n] = dist2[c] + 1; parent2[n] = c; q2.push(n);
      if (!g.visited[ny2][nx2] && (!far || dist2[n] < dist2[far])) far = n;
    }
  }
  if (far !== null) {
    const path = [];
    let c = far;
    while (c !== start && c !== -1) { path.push(c); c = parent2[c]; }
    path.reverse();
    if (path.length > 0) {
      const nxt = path[0], nx2 = nxt % g.w, ny2 = (nxt - nx2) / g.w;
      const cy = g.player.y, cx = g.player.x;
      if (ny2 < cy) return 'up';
      if (nx2 < cx) return 'left';
      if (nx2 > cx) return 'right';
      return 'down';
    }
  }
  // Nowhere unseen: drift by fixed order toward any open neighbor.
  for (const a of ACT_ORDER) {
    const [dx, dy] = { up: [0, -1], left: [-1, 0], right: [1, 0], down: [0, 1] }[a];
    if (isFloor(g.player.x + dx, g.player.y + dy)) return a;
  }
  return 'wait';
}

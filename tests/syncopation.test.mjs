// tests/syncopation.test.mjs — wave-73b engine laws, zero-network, zero-calls.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newGame, fork, step, windowScore } from '../src/vendor/quilt-dungeons-core.js';
import { baseScript, decide, applyMutation, menuOp, MENU, mapIdeaToMenu, normalizeScript } from '../src/strategy.js';
import { Composer } from '../src/composer.js';

const sha = (x) => 'sha256:' + createHash('sha256').update(JSON.stringify(x)).digest('hex');
const WANDER = ['up', 'right', 'down', 'right', 'up', 'right', 'down', 'down', 'left', 'right'];

// ── core contract ───────────────────────────────────────────────────────────
test('core: byte-deterministic — same seed, same actions, byte-equal receipt log', () => {
  const a = newGame(73001), b = newGame(73001);
  const sa = baseScript(), sb = baseScript();
  while (a.t < 120 && !a.finished) step(a, decide(a, sa));
  while (b.t < 120 && !b.finished) step(b, decide(b, sb));
  assert.equal(sha(a.receipts), sha(b.receipts));
});

test('core: fork is a stable point — forked game replays byte-identically', () => {
  const g = newGame(73007), s = baseScript();
  while (g.t < 57 && !g.finished) step(g, decide(g, s));
  const f = fork(g);
  assert.equal(sha(f.receipts), sha(g.receipts));
  while (!g.finished && g.t < 160) step(g, decide(g, s));
  while (!f.finished && f.t < 160) step(f, decide(f, s));
  assert.equal(sha(f.receipts), sha(g.receipts));
});

test('core: contract is fail-closed — bad action and finished game throw', () => {
  const g = newGame(1);
  assert.throws(() => step(g, 'teleport'), /E_BAD_ACTION/);
  g.finished = true;
  assert.throws(() => step(g, 'up'), /E_FINISHED/);
});

// ── strategy scripts ────────────────────────────────────────────────────────
test('strategy: decide is pure — same forked state + script, same action', () => {
  const g = newGame(73009), s = baseScript();
  while (g.t < 33 && !g.finished) step(g, decide(g, s));
  const f = fork(g);
  assert.equal(decide(f, s), decide(g, normalizeScript(s)));
});

test('strategy: different scripts diverge — the mutation menu has teeth', () => {
  const base = baseScript();
  const mutant = applyMutation(base, menuOp(7), 'mut-potion-high'); // potionAtHp 0.68
  const g1 = newGame(73001), g2 = newGame(73001);
  while (g1.t < 80 && !g1.finished) step(g1, decide(g1, base));
  while (g2.t < 80 && !g2.finished) step(g2, decide(g2, mutant));
  assert.notEqual(sha(g1.receipts), sha(g2.receipts));
});

test('menu: deterministic rolls + model-idea mapping is constrained to the menu', () => {
  const a = new Composer({ seed: 42, pulseInterval: 10 });
  const b = new Composer({ seed: 42, pulseInterval: 10 });
  for (let i = 0; i < 20; i++) assert.equal(Math.floor(a.rand() * MENU.length), Math.floor(b.rand() * MENU.length));
  assert.equal(mapIdeaToMenu({ param: 'treasureWeight', direction: 'up' }).tag, 'treasure-up');
  assert.equal(mapIdeaToMenu({ param: 'hazardFear', direction: 'down' }).tag, 'fear-down');
  assert.equal(mapIdeaToMenu({ param: 'priority', direction: 'swap' }).op, 'swapPriority');
  assert.equal(mapIdeaToMenu({ param: 'nonsense', direction: 'up' }), null);
  assert.equal(mapIdeaToMenu({ param: 'treasureWeight', direction: 'sideways' }), null);
  assert.equal(mapIdeaToMenu(null), null);
});

// ── the trio + composer laws ────────────────────────────────────────────────
async function miniTrio({ seed = 73001, turns = 60, pulse = 20, client = null, composerPatch = null } = {}) {
  const genesis = newGame(seed);
  const slots = [
    { name: 'A', game: fork(genesis), script: baseScript(), installedAtPulse: 0, fixed: true },
    { name: 'B', game: fork(genesis), script: null, installedAtPulse: 0 },
    { name: 'C', game: fork(genesis), script: null, installedAtPulse: 0 },
  ];
  const composer = new Composer({ seed, pulseInterval: pulse, client });
  composer.seedCandidates(slots);
  if (composerPatch) composerPatch(composer);
  for (let t = 1; t <= turns; t++) {
    for (const s of slots) if (!s.game.finished) step(s.game, decide(s.game, s.script));
    if (t % pulse === 0) {
      try { await composer.boundary(slots, t); } catch { composer.pulses.push({ status: 'SKIPPED', frontierTurn: t }); }
    }
  }
  composer.resolvePending(slots, turns);
  return { slots, composer, genesis };
}

test('the script-writer law: composer decide failure -> no toggle, trio keeps playing', async () => {
  const { slots, composer } = await miniTrio({
    composerPatch: (c) => { c.decide = () => { throw new Error('E_COMPOSER_BROKE'); }; },
  });
  assert.equal(slots.every((s) => s.game.t === 60 || s.game.finished), true, 'all slots played the full window');
  const rec = composer.pulses.find((p) => p.toggle);
  assert.ok(rec, 'pulse receipted');
  assert.equal(rec.toggle.action, 'NONE');
  assert.match(rec.toggle.note, /keeps playing/);
});

test('the script-writer law: a crashing land() is receipted SKIPPED and never blocks the trio', async () => {
  const { slots, composer } = await miniTrio({
    composerPatch: (c) => { c.land = async () => { throw new Error('E_LAND_BROKE'); }; },
  });
  assert.ok(composer.pulses.some((p) => p.status === 'SKIPPED'), 'the crash was receipted SKIPPED');
  // the game state was untouched by the composer crash: slots can still step
  const t0 = slots[0].game.t;
  for (const s of slots) if (!s.game.finished) step(s.game, decide(s.game, s.script));
  assert.equal(slots[0].game.t, t0 + 1);
});

test('zero-call engine: full mini-run, flips receipted with the asymmetry fields', async () => {
  const { slots, composer } = await miniTrio({ turns: 60, pulse: 10, client: null });
  assert.ok(composer.flips.length >= 1, 'flips exist');
  for (const f of composer.flips) {
    assert.equal(f.staleBy, 10);
    assert.deepEqual(f.evidenceWindow, [f.kickedAt - 10, f.kickedAt]);
    assert.deepEqual(f.unseenWindow, [f.kickedAt, f.landedAt]);
    assert.ok(f.whatTheFlippedSlotDidAfter && typeof f.whatTheFlippedSlotDidAfter.score === 'number');
    assert.ok(['boolean', 'string'].includes(typeof f.wasFlipRight));
    assert.ok(f.wasFlipRight !== 'unknown', 'unseen window closed at land -> resolved');
    assert.ok(typeof f.netGain === 'number' || f.netGain === 'unknown');
    assert.ok(f.flippedOffScript && f.installedScript && f.targetSlot);
  }
  assert.equal(slots[0].fixed, true);
  assert.ok(!composer.installs.some((i) => i.slot === 'A'), 'baseline slot is never touched');
});

test('model leg: a mapped idea REPLACES the menu roll; budget is capped; failures fall back', async () => {
  let attempts = 0;
  const goodClient = {
    think: async () => { attempts++; return { ok: true, idea: { param: 'treasureWeight', direction: 'up' }, mapped: 'treasure-up' }; },
    status: () => ({ attempts }),
  };
  const { composer } = await miniTrio({ turns: 60, pulse: 20, client: goodClient });
  const toggles = composer.pulses.filter((p) => p.toggle?.installed);
  assert.ok(toggles.length >= 1);
  assert.ok(toggles.some((p) => p.toggle.installed.scriptId.includes('treasure-up')), 'model idea adopted');
  const thoughted = composer.pulses.filter((p) => p.thought?.source);
  assert.ok(thoughted.length >= 1 && thoughted.every((p) => p.thought.source === 'model'), 'source receipted');

  const badClient = {
    think: async () => { attempts++; return { ok: false, reason: 'transport-or-http' }; },
    status: () => ({ attempts }),
  };
  const { composer: c2 } = await miniTrio({ turns: 60, pulse: 20, client: badClient });
  assert.ok(c2.pulses.filter((p) => p.toggle?.installed).length >= 1, 'menu fallback still toggles');
  assert.ok(c2.pulses.some((p) => p.thought?.source?.includes('menu')), 'fallback receipted as menu');
});

test('asymmetry: wasFlipRight compares unseen window vs seen window exactly as receipted', async () => {
  const { slots, composer } = await miniTrio({ turns: 60, pulse: 10, client: null });
  for (const f of composer.flips) {
    const slot = slots.find((s) => s.name === f.flippedOffSlot);
    if (!slot) continue;
    const seen = windowScore(slot.game, f.evidenceWindow[0], f.evidenceWindow[1]);
    const unseen = windowScore(slot.game, f.unseenWindow[0], f.unseenWindow[1]);
    assert.equal(f.wasFlipRight, unseen.score <= seen.score);
    assert.equal(f.whatTheFlippedSlotDidAfter.score, unseen.score);
  }
});

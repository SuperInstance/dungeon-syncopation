#!/usr/bin/env node
// src/run-syncopation.mjs — wave-73b THE RUN.
//
// 8 seeds x 200 turns. Per seed: a TRIO (slots A/B/C forked from the same
// genesis — same seed, same stable point) rotating under the composer, and a
// FROZEN BASELINE (same seed, baseline script, no composer). The syncopation
// hypothesis test: does the rotating trio beat the frozen baseline over equal
// turns? Pre-registered claims scored by tools/preregister.mjs (seal pushed
// BEFORE this run — the commit that carries the seal is the timestamp).
//
// Pre-run fail-closed byte-bind: the claims file binds sha256 of the core,
// strategy, and composer sources; this runner re-asserts them before turning
// a single tick (E_BIND_MISMATCH otherwise) — like 71-c's battery binding.
//
// LAWS: the game never pauses for the composer (a failed pulse is receipted
// SKIPPED and the trio keeps playing); <= 6 model attempts total, receipt
// each; the engine runs with 0 calls (client omitted / budget 0).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newGame, fork, step, windowScore } from './vendor/quilt-dungeons-core.js';
import { baseScript, decide, applyMutation } from './strategy.js';
import { Composer } from './composer.js';
import { makeComposerClient } from './deepinfra-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── args ────────────────────────────────────────────────────────────────────
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const TURNS = Number(arg('turns', 200));
const PULSE = Number(arg('pulse', 20));
const NSEEDS = Number(arg('seeds', 8));
const BUDGET = Number(arg('budget', 6));
const OUT = join(ROOT, arg('out', 'receipts/run-73b.json'));
const LEDGER = join(ROOT, arg('ledger', 'receipts/asymmetry-ledger.json'));
const CALLS = join(ROOT, arg('calls', 'receipts/composer-calls.jsonl'));
const BIND = arg('bind', 'predictions/preregister-73b.json'); // claims file with byte-bindings
const QUIET = process.argv.includes('--quiet');

const SEEDS = Array.from({ length: NSEEDS }, (_, i) => 73001 + i);

// ── pre-run byte-bind (fail-closed) ─────────────────────────────────────────
function assertBindings() {
  const claimsPath = join(ROOT, BIND);
  if (!existsSync(claimsPath)) throw new Error(`E_BIND_MISSING ${BIND}`);
  const claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const bind = claims.batteryBinding ?? {};
  const files = ['src/vendor/quilt-dungeons-core.js', 'src/strategy.js', 'src/composer.js'];
  for (const f of files) {
    const key = `${f}.sha256`;
    if (!bind[key]) throw new Error(`E_BIND_MISSING_CLAIM ${key}`);
    const actual = 'sha256:' + createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex');
    if (actual !== bind[key]) throw new Error(`E_BIND_MISMATCH ${key}: claims=${bind[key]} actual=${actual}`);
  }
  return claims;
}

// ── the runs ────────────────────────────────────────────────────────────────
function runFrozen(seed, turns) {
  const g = newGame(seed);
  const s = baseScript();
  while (g.t < turns && !g.finished) step(g, decide(g, s));
  return {
    kind: 'frozen-baseline', seed, script: s.id,
    finalScore: g.score, hp: g.hp, finished: g.finished, finishedAt: g.finishedAt,
    turnsPlayed: g.t, exitTouched: g.exitTouched,
    receiptsSha: 'sha256:' + createHash('sha256').update(JSON.stringify(g.receipts)).digest('hex'),
    receipts: g.receipts,
  };
}

async function runTrio(seed, { turns, pulse, client }) {
  const genesis = newGame(seed);
  const slots = [
    { name: 'A', game: fork(genesis), script: baseScript(), installedAtPulse: 0, fixed: true },
    { name: 'B', game: fork(genesis), script: null, installedAtPulse: 0 },
    { name: 'C', game: fork(genesis), script: null, installedAtPulse: 0 },
  ];
  const composer = new Composer({ seed, pulseInterval: pulse, client });
  composer.seedCandidates(slots);
  const skipped = [];
  for (let t = 1; t <= turns; t++) {
    for (const s of slots) if (!s.game.finished) step(s.game, decide(s.game, s.script));
    if (t % pulse === 0) {
      const before = composer.pulses.length;
      try { await composer.boundary(slots, t); } catch (e) {
        // THE SCRIPT-WRITER LAW: the game never pauses for the composer.
        composer.pulses.push({ pulseN: -1, frontierTurn: t, status: 'SKIPPED', error: String(e.message ?? e).slice(0, 300) });
      }
      if (composer.pulses.length > before && composer.pulses[composer.pulses.length - 1].status === 'SKIPPED') {
        skipped.push(t);
      }
    }
  }
  composer.resolvePending(slots, turns);
  return {
    kind: 'trio', seed, pulseInterval: pulse,
    slots: slots.map((s) => ({
      slot: s.name, script: s.script.id, fixed: Boolean(s.fixed),
      finalScore: s.game.score, hp: s.game.hp, finished: s.game.finished,
      finishedAt: s.game.finishedAt, exitTouched: s.game.exitTouched,
      installedAtPulse: s.installedAtPulse,
      receiptsSha: 'sha256:' + createHash('sha256').update(JSON.stringify(s.game.receipts)).digest('hex'),
    })),
    trioMean: slots.reduce((a, s) => a + s.game.score, 0) / slots.length,
    pulses: composer.pulses, flips: composer.flips, installs: composer.installs,
    pulsesSkippedAt: skipped,
    slotReceipts: Object.fromEntries(slots.map((s) => [s.name, s.game.receipts])),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const claims = assertBindings();
mkdirSync(join(ROOT, 'receipts'), { recursive: true });
if (existsSync(CALLS)) writeFileSync(CALLS, ''); // fresh call ledger per run

const client = BUDGET > 0 ? makeComposerClient({ budget: BUDGET, receiptPath: CALLS }) : null;
const perSeed = [];
for (const seed of SEEDS) {
  const frozen = runFrozen(seed, TURNS);
  const trio = await runTrio(seed, { turns: TURNS, pulse: PULSE, client });
  // CONTROL INTEGRITY: slot A (baseline, fixed) must byte-replay the frozen run.
  const a = trio.slots.find((s) => s.slot === 'A');
  const controlIntact = a.receiptsSha === frozen.receiptsSha;
  perSeed.push({
    seed,
    baseline: { finalScore: frozen.finalScore, finishedAt: frozen.finishedAt, hp: frozen.hp, receiptsSha: frozen.receiptsSha },
    trio: {
      slots: trio.slots.map(({ receiptsSha, ...rest }) => ({ ...rest, receiptsSha })),
      trioMean: trio.trioMean,
      pulses: trio.pulses, flips: trio.flips, installs: trio.installs,
      pulsesSkippedAt: trio.pulsesSkippedAt,
    },
    control_slotA_equals_frozen: controlIntact,
    trioMeanWinsBaseline: trio.trioMean > frozen.finalScore,
  });
  if (!QUIET) console.log(`seed ${seed}: baseline=${frozen.finalScore} trioMean=${trio.trioMean.toFixed(2)} win=${controlIntact ? trio.trioMean > frozen.finalScore : 'CONTROL-BROKEN'} flips=${trio.flips.length}`);
}

// ── metrics (the preregister results shape) ─────────────────────────────────
const seedsWon = perSeed.filter((s) => s.control_slotA_equals_frozen && s.trioMeanWinsBaseline).length;
const allFlips = perSeed.flatMap((s) => s.trio.flips.map((f) => ({ seed: s.seed, ...f })));
const flipsBothResolved = allFlips.filter((f) => f.wasFlipRight !== 'unknown' && f.netGain !== 'unknown');
const wrongButGain = flipsBothResolved.filter((f) => f.wasFlipRight === false && f.netGain > 0);
const trioMeanOverall = perSeed.reduce((a, s) => a + s.trio.trioMean, 0) / perSeed.length;
const baselineMeanOverall = perSeed.reduce((a, s) => a + s.baseline.finalScore, 0) / perSeed.length;
const clientStatus = client?.status?.() ?? { attempts: 0, budget: BUDGET, closed: 'client-absent' };
const pulsesSkipped = perSeed.reduce((a, s) => a + s.trio.pulsesSkippedAt.length, 0);
const modelThoughts = perSeed.reduce((a, s) => a + s.trio.pulses.filter((p) => p.thought?.source === 'model').length, 0);

const results = {
  run: '73-b', repo: 'SuperInstance/dungeon-syncopation',
  turns: TURNS, pulseInterval: PULSE, seeds: SEEDS,
  metrics: {
    p1_seedsWon: seedsWon,
    p1_totalSeeds: perSeed.length,
    p2_flipCountWrongButGain: wrongButGain.length,
    p2_flipsResolvedBoth: flipsBothResolved.length,
    p2_totalFlips: allFlips.length,
    trioMeanOverall,
    baselineMeanOverall,
    deltaOverall: trioMeanOverall - baselineMeanOverall,
    control_slotA_equals_frozen_all: perSeed.every((s) => s.control_slotA_equals_frozen),
    modelCallsAttempted: clientStatus.attempts,
    modelBudget: clientStatus.budget,
    modelChannelClosed: clientStatus.closed,
    modelThoughtsAdopted: modelThoughts,
    pulsesSkipped,
  },
  evidence: {
    perSeed: perSeed.map((s) => ({
      seed: s.seed,
      baseline: s.baseline,
      trioSlots: s.trio.slots,
      trioMean: s.trio.trioMean,
      wins: s.trioMeanWinsBaseline,
      controlIntact: s.control_slotA_equals_frozen,
      flipCount: s.trio.flips.length,
    })),
    flips: allFlips,
  },
};

writeFileSync(OUT, JSON.stringify(results, null, 2));
writeFileSync(LEDGER, JSON.stringify({ run: '73-b', flips: allFlips, lawNote: 'wasFlipRight: RIGHT iff the flipped-off script unseen window did not beat the seen evidence window; netGain = replacement first window minus seen window, on the flipped slot.' }, null, 2));

if (!QUIET) {
  console.log('─────────────────────────────────────────────');
  console.log(`P1: rotating trio > frozen baseline on ${seedsWon}/${perSeed.length} seeds`);
  console.log(`P2: flips wrong-but-net-gain: ${wrongButGain.length} (of ${flipsBothResolved.length} resolved / ${allFlips.length} flips)`);
  console.log(`trioMeanOverall=${trioMeanOverall.toFixed(2)} baselineMeanOverall=${baselineMeanOverall.toFixed(2)} delta=${(trioMeanOverall - baselineMeanOverall).toFixed(2)}`);
  console.log(`model calls attempted: ${clientStatus.attempts}/${clientStatus.budget} (closed: ${clientStatus.closed}) · pulses SKIPPED: ${pulsesSkipped}`);
  console.log(`results -> ${OUT}`);
}

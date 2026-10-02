// src/composer.js — THE COMPOSER (system-two, pulsing slow).
//
// The principal's mechanism, operationalized:
//   * Three slots always play (A = baseline, fixed; B, C = candidates). The
//     game NEVER pauses for the composer: pulses happen at turn boundaries and
//     the trio keeps stepping whether or not a thought lands.
//   * At each pulse boundary the composer digests the just-closed window
//     (PULSE_INTERVAL turns — the "30 seconds"), reviews ITS OWN reasoning from
//     two pulses ago (the Fibonacci lag: it reviews pulse N-2 while acting on
//     pulse N-1's results), and writes ONE new candidate: a rule-based mutation
//     of the best incumbent, from a seeded menu (or one constrained idea from
//     the model leg, budget <= 6 attempts, receipt each).
//   * The decision made at kick time lands ONE FULL WINDOW LATER. The flip
//     therefore runs on data staleBy = PULSE_INTERVAL turns: the script it
//     flips off has played one entire window the composer never saw. That
//     unseen window is receipted (whatTheFlippedSlotDidAfter) and judged
//     (wasFlipRight) the moment the flip lands — the ledger of where
//     syncopation helped or hurt.
//   * If anything in the composer throws, the pulse is receipted SKIPPED and
//     the trio keeps playing (the script-writer law).

import { windowScore, windowEvents } from './vendor/quilt-dungeons-core.js';
import { MENU, menuOp, applyMutation, baseScript, normalizeScript, PARAM_SCHEMA } from './strategy.js';

function mulberry(state) {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Composer {
  constructor({ seed, pulseInterval = 20, client = null }) {
    this.seed = seed;
    this.P = pulseInterval;
    this.client = client;
    this.pulseN = 0;
    this.pending = null;   // the thought in flight {pulseN, kickedAt, digest, decision, modelP, thought}
    this.pulses = [];      // landed pulse receipts (append-only)
    this.flips = [];       // THE ASYMMETRY LEDGER (append-only)
    this.thoughts = [];    // per-pulse reasoning records — the Fibonacci memory
    this.rand = mulberry((seed ^ 0x9e3779b9) >>> 0);
    this.installs = [];    // every script installation, receipted
  }

  // pulse 0 — the seeding: two distinct menu mutants of the baseline onto B, C.
  seedCandidates(slots) {
    const base = baseScript();
    const idx1 = Math.floor(this.rand() * MENU.length);
    let idx2 = Math.floor(this.rand() * MENU.length);
    if (menuOp(idx2).tag === menuOp(idx1).tag) idx2 = (idx2 + 1) % MENU.length;
    const cands = [menuOp(idx1), menuOp(idx2)];
    let ci = 0;
    const seeded = [];
    for (const s of slots) {
      if (s.fixed) continue;
      const script = applyMutation(base, cands[ci], `p0-${cands[ci].tag}`);
      s.script = script; s.installedAtPulse = 0;
      this.installs.push({ pulseN: 0, slot: s.name, scriptId: script.id, via: 'seed' });
      seeded.push({ slot: s.name, scriptId: script.id, menuTag: cands[ci].tag });
      ci++;
    }
    const rec = { pulseN: 0, status: 'SEEDED', seeded };
    this.pulses.push(rec);
    this.thoughts[0] = { pulseN: 0, source: 'menu(seed)', seeded };
    return rec;
  }

  // THE BOUNDARY — called at t = k·P, after the window's last step. Lands the
  // in-flight decision, digests the closed window, kicks the next thought
  // (the model fetch races the next window; it is awaited only at the NEXT
  // boundary). Returns after the land — the game steps on immediately.
  async boundary(slots, frontierTurn) {
    if (this.pending) await this.land(slots, frontierTurn);
    const w0 = frontierTurn - this.P, w1 = frontierTurn;
    const digest = this.digest(slots, w0, w1);
    this.kick(slots, digest, { w0, w1, frontierTurn });
  }

  digest(slots, w0, w1) {
    const out = { window: [w0, w1], slots: {} };
    for (const s of slots) {
      const ws = windowScore(s.game, w0, w1);
      out.slots[s.name] = {
        script: s.script.id, score: ws.score, steps: ws.steps,
        events: windowEvents(s.game, w0, w1),
        finished: s.game.finished, finishedAt: s.game.finishedAt,
      };
    }
    return out;
  }

  // Kick: review (Fibonacci lag) + decide (on the KICK-TIME digest only) +
  // start the slow thought. No await on the model here — the game moves on.
  kick(slots, digest, { w0, w1, frontierTurn }) {
    const N = ++this.pulseN;
    const thought = {
      pulseN: N, kickedAt: frontierTurn, evidenceWindow: [w0, w1],
      source: null, idea: null, mappedTag: null, menuIdx: null, opTag: null,
      lag: null,
    };
    // (b) the Fibonacci lag: review pulse N-2's reasoning while acting on
    // pulse N-1's results (the window that just closed IS N-2's outcome).
    const prev2 = this.thoughts[N - 2] ?? null;
    thought.lag = {
      reviewedPulse: N - 2 >= 0 ? N - 2 : null,
      reviewedThought: prev2,
      outcomeWindow: [w0, w1],
      note: 'reviewing my own reasoning from two pulses ago against the results window that just closed',
    };
    // (a)+(c) digest -> decision (frozen NOW; the world will move on)
    let decision = null;
    try {
      decision = this.decide(slots, digest, N, thought);
    } catch (e) {
      decision = null;
      thought.decisionError = String(e.message).slice(0, 200);
    }
    // model leg: ONE idea per pulse, budget-capped, receipted by the client
    let modelP = null;
    if (this.client && decision) {
      modelP = this.client.think(this.modelDigest(digest), { pulseKey: `s${this.seed}-p${N}` })
        .catch((e) => ({ ok: false, reason: 'client-throw', error: String(e?.message ?? e).slice(0, 200) }));
    }
    this.pending = { pulseN: N, kickedAt: frontierTurn, evidenceWindow: [w0, w1], digest, decision, modelP, thought };
    this.thoughts[N] = thought;
  }

  modelDigest(digest) {
    const scripts = {};
    for (const k of ['B', 'C']) {
      if (digest.slots[k]) scripts[k] = { script: digest.slots[k].script, score: digest.slots[k].score, finished: digest.slots[k].finished };
    }
    return { digest, scripts, schema: PARAM_SCHEMA };
  }

  // decide — weakest slot, best incumbent, one menu op (model may substitute
  // its idea at land; the menu roll happens at land so the rng stays honest).
  decide(slots, digest, N, thought) {
    const cand = slots.filter((s) => !s.fixed);
    const active = cand.filter((s) => !s.game.finished);
    if (active.length === 0) return { kind: 'NO-ACTIVE-TARGET' };
    const scoreOf = (s) => digest.slots[s.name].score;
    const target = active.reduce((a, b) => (scoreOf(b) < scoreOf(a) ? b : a));
    // parent = best-performing active incumbent (cross-pollination: fish the
    // best idea out of the running pair); tie -> the lower slot letter.
    const activeCand = active;
    const parent = activeCand.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));
    const idx = Math.floor(this.rand() * MENU.length);
    const op = menuOp(idx);
    thought.menuIdx = idx; thought.opTag = op.tag;
    const parentScript = normalizeScript(parent.script);
    const newScript = applyMutation(parentScript, op, `p${N}-${op.tag}`);
    // oldest candidate by tenure (tie -> the lower slot letter)
    const oldest = cand.reduce((a, b) => (b.installedAtPulse < a.installedAtPulse ? b : a));
    return { kind: 'TOGGLE', target: target.name, oldest: oldest.name, parentScriptId: parentScript.id, parentScript, opTag: op.tag, newScript, menuIdx: idx };
  }

  // Land: apply the stale decision; receipt the flip + its unseen window.
  async land(slots, frontierTurn) {
    const p = this.pending;
    this.pending = null;
    const thought = p.thought;
    const landedAt = frontierTurn;
    const rec = {
      pulseN: p.pulseN, kickedAt: p.kickedAt, landedAt,
      evidenceWindow: p.evidenceWindow, staleBy: this.P, status: 'DECIDED',
      thought: null, toggle: null, flips: [],
    };
    try {
      // the slow thought settles (it raced the window; bounded by its timeout)
      if (p.modelP) {
        const r = await p.modelP;
        thought.idea = r.idea ?? null;
        thought.mappedTag = r.mapped ?? null;
        thought.model = { ok: Boolean(r.ok), reason: r.reason ?? null, attempts: this.client?.status?.().attempts ?? null };
        thought.source = r.ok ? 'model' : `model-unusable(${r.reason ?? 'unknown'})+menu`;
      }
      if (!thought.source) thought.source = 'menu';
      let op = thought.mappedTag ? MENU.find((m) => m.tag === thought.mappedTag) : null;
      if (op && p.decision && p.decision.kind === 'TOGGLE' && op.tag !== p.decision.opTag) {
        // the model's idea REPLACES the menu roll (the roll is receipted as the
        // road-not-taken); the new script is re-forged from the same parent.
        p.decision.opTag = op.tag;
        p.decision.newScript = applyMutation(p.decision.parentScript, op, `p${p.pulseN}-${op.tag}`);
      }
      if (!op && p.decision) { op = menuOp(p.decision.menuIdx); thought.opTag = op.tag; }
      if (op && p.decision && p.decision.kind === 'TOGGLE') p.decision.opTag = op.tag;

      // resolve netGain for any earlier flip whose replacement-window closed
      this.resolveNetGains(slots, frontierTurn);

      if (!p.decision || p.decision.kind !== 'TOGGLE') {
        rec.toggle = { action: p.decision?.kind ?? 'NONE', note: 'no toggle this pulse; trio keeps playing' };
      } else {
        const d = p.decision;
        const target = slots.find((s) => s.name === d.target);
        const oldest = slots.find((s) => s.name === d.oldest);
        if (!target || !oldest || target.game.finished || oldest.game.finished) {
          rec.toggle = { action: 'DEFERRED', note: 'decision ran on stale evidence; reality intervened (target/oldest finished during the thinking window)' };
        } else if (d.oldest === d.target) {
          const flippedOff = { slot: target.name, scriptId: target.script.id, installedAtPulse: target.installedAtPulse };
          target.script = d.newScript; target.installedAtPulse = p.pulseN;
          this.installs.push({ pulseN: p.pulseN, slot: target.name, scriptId: d.newScript.id, via: thought.source });
          rec.toggle = { action: 'FLIP-IN-PLACE', flippedOff, installed: { slot: target.name, scriptId: d.newScript.id } };
          rec.flips.push(this.receiptFlip(p, thought, flippedOff, { slot: target.name, scriptId: d.newScript.id }, null, slots, landedAt));
        } else {
          // cross-pollination: the survivor (target's incumbent) moves onto the
          // evicted slot; the new script lands on the weakest slot.
          const survivor = normalizeScript(target.script);
          const flippedOff = { slot: oldest.name, scriptId: oldest.script.id, installedAtPulse: oldest.installedAtPulse };
          target.script = d.newScript; target.installedAtPulse = p.pulseN;
          oldest.script = survivor; oldest.installedAtPulse = p.pulseN;
          this.installs.push({ pulseN: p.pulseN, slot: target.name, scriptId: d.newScript.id, via: thought.source });
          this.installs.push({ pulseN: p.pulseN, slot: oldest.name, scriptId: survivor.id, via: 'cross-pollination' });
          rec.toggle = {
            action: 'FLIP-AND-CROSS-POLLINATE', flippedOff,
            installed: { slot: target.name, scriptId: d.newScript.id },
            survivorMoved: { scriptId: survivor.id, onto: oldest.name },
          };
          rec.flips.push(this.receiptFlip(p, thought, flippedOff, { slot: target.name, scriptId: d.newScript.id }, survivor.id, slots, landedAt));
        }
      }
    } catch (e) {
      rec.status = 'SKIPPED';
      rec.error = String(e.message ?? e).slice(0, 300);
      rec.note = 'THE SCRIPT-WRITER LAW: the composer failed; the trio kept playing.';
    }
    rec.thought = {
      pulseN: thought.pulseN, source: thought.source, idea: thought.idea,
      mappedTag: thought.mappedTag, opTag: thought.opTag, menuIdx: thought.menuIdx,
      lagReviewedPulse: thought.lag?.reviewedPulse ?? null,
    };
    this.pulses.push(rec);
    return rec;
  }

  receiptFlip(p, thought, flippedOff, installed, survivorId, slots, landedAt) {
    const flip = {
      id: `f-s${this.seed}-p${p.pulseN}`,
      pulseN: p.pulseN,
      decisionSource: thought.source,
      kickedAt: p.kickedAt, landedAt,
      evidenceWindow: p.evidenceWindow, staleBy: this.P,
      targetSlot: installed.slot,
      flippedOffSlot: flippedOff.slot,
      flippedOffScript: flippedOff.scriptId,
      installedScript: installed.scriptId,
      survivorScript: survivorId,
      unseenWindow: [p.kickedAt, landedAt],
      whatTheFlippedSlotDidAfter: null, // filled below — revealed AT the flip
      wasFlipRight: 'unknown',
      netGainWindow: [landedAt, landedAt + this.P],
      netGain: 'unknown',
    };
    const slot = slots.find((s) => s.name === flippedOff.slot);
    if (slot) {
      const seen = windowScore(slot.game, p.evidenceWindow[0], p.evidenceWindow[1]);
      const unseen = windowScore(slot.game, p.kickedAt, landedAt);
      flip.whatTheFlippedSlotDidAfter = {
        window: [p.kickedAt, landedAt], score: unseen.score, steps: unseen.steps,
        events: windowEvents(slot.game, p.kickedAt, landedAt),
        note: 'the window the flipped-off script played while the composer was thinking — revealed only at the flip',
      };
      flip.seenWindowScore = seen.score;
      // wasFlipRight: RIGHT iff the unseen window did not show the flipped-off
      // script outperforming the evidence that justified flipping it.
      flip.wasFlipRight = unseen.score <= seen.score;
    }
    this.flips.push(flip);
    return flip;
  }

  resolveNetGains(slots, frontierTurn) {
    for (const f of this.flips) {
      if (f.netGain !== 'unknown') continue;
      if (frontierTurn < f.netGainWindow[1]) continue; // window not closed
      const slot = slots.find((s) => s.name === f.flippedOffSlot);
      if (!slot) { f.netGain = 'unknown'; continue; }
      const next = windowScore(slot.game, f.netGainWindow[0], f.netGainWindow[1]);
      f.netGain = next.score - (f.seenWindowScore ?? 0);
      f.netGainDetail = { replacementFirstWindowScore: next.score, seenWindowScore: f.seenWindowScore };
    }
  }

  // End-of-run: resolve everything resolvable; mark the rest 'unknown' honestly.
  resolvePending(slots, frontierTurn) {
    if (this.pending) {
      const p = this.pending; this.pending = null;
      this.pulses.push({
        pulseN: p.pulseN, kickedAt: p.kickedAt, evidenceWindow: p.evidenceWindow,
        status: 'DROPPED-AT-RUN-END',
        note: 'the run ended before this thought could land; the trio played every turn regardless',
      });
    }
    this.resolveNetGains(slots, frontierTurn);
    for (const f of this.flips) {
      if (frontierTurn < f.netGainWindow[1]) f.netGain = 'unknown'; // window never closed
    }
  }
}

# SYNCOPATION — the system-two engine that is a move behind

The principal's directive, verbatim in intent: run **iterative system-two cells
that pulse slower but act as higher-level designers of flow**, writing alternate
logic and A/B-testing it **while they think of their next iterative
improvement** — so that the thinker is always one window behind the game, and
the asymmetry itself becomes part of the mechanism.

This repo is that mechanism, built on the quilt-dungeons core contract
(vendored-pending-merge — see `src/vendor/quilt-dungeons-core.js`).

---

## 1. The three slots

Three parallel game instances are **forked from the same seed and the same
stable point** (genesis — `fork()` is the contract's stable-point primitive):

| slot | script | who controls it |
|------|--------|-----------------|
| **A** | baseline (`S-base-v0`) | nobody — always on, never flipped; the anchor |
| **B** | candidate 1 | the composer |
| **C** | candidate 2 | the composer |

All three play **simultaneously**: the runner interleaves A, B, C per tick
batch, every turn, for the whole episode (200 turns). The game **never pauses
for the composer** — that is the script-writer law (§5).

## 2. The composer (system-two, pulsing slow)

Every `PULSE_INTERVAL` turns (default **20** — the "30 seconds") the composer:

1. **(a) digests** the three slots' window receipts — composite window scores
   (receipt folds over `dScore`), event counts (treasure/potion/hazard/exit/
   death), steps, finished flags. This is `digest()` — a pure fold over the
   receipt chains, no wall-clock anywhere.
2. **(b) reviews its own pulse N−2 reasoning** while acting on pulse N−1's
   results — the **Fibonacci lag**. The thought record of pulse N−2 is
   attached to pulse N's deliberation (`thought.lag`), with the window that
   just closing being exactly N−2's outcome. The composer is structurally a
   move behind its own thinking.
3. **(c) writes one new candidate**: a **rule-based mutation of the best
   incumbent** — parameter tweaks (×1.6 treasure pull), threshold flips
   (`potionAtHp` 0.32/0.68), priority swaps (potion↔treasure), horizon
   changes — from a **seeded menu of 15 ops** (`MENU`), deterministic per
   (seed, pulse). If the model leg is available (≤6 attempts total, receipt
   each), the composer may ask for **one** mutation idea per pulse — but the
   idea is **constrained to the same menu** (`mapIdeaToMenu`): the model
   suggests, the menu decides, unmappable ideas fall back to the seeded roll,
   and the rolled-but-unused op is receipted as the road not taken.
4. **(d) toggles — on stale evidence.** The decision is frozen at **kick
   time** (data through turn t−20) and **lands one full window later** (at
   t+20): the new script goes onto the **weakest** slot (lowest window
   composite among active candidates), the **oldest** candidate (longest
   tenure) is flipped off. If the oldest sits on the *other* slot, the
   **survivor** (the weakest slot's incumbent) cross-pollinates onto the
   evicted slot — the composer "digests the previous two and picks the better
   one while all three are playing."

**The asymmetry:** at the moment the flip lands, the flipped-off script has
played one entire 20-turn window the composer **never saw** when deciding. It
was busy writing the replacement. That window is real play, by a real script,
judged by nobody until it is already over.

## 3. The asymmetry receipt

Every flip appends to the ledger (`receipts/asymmetry-ledger.json`):

```json
{
  "pulseN": 3, "decisionSource": "menu|model",
  "kickedAt": 60, "landedAt": 80,
  "evidenceWindow": [40, 60], "staleBy": 20,
  "targetSlot": "B", "flippedOffSlot": "B",
  "flippedOffScript": "p1-potion-high", "installedScript": "p3-fear-up",
  "unseenWindow": [60, 80],
  "whatTheFlippedSlotDidAfter": { "window": [60,80], "score": 14, "events": {...},
    "note": "the window the flipped-off script played while the composer was thinking — revealed only at the flip" },
  "wasFlipRight": true, "netGainWindow": [80,100], "netGain": 6
}
```

* `wasFlipRight` — **RIGHT** iff the unseen window did *not* show the
  flipped-off script outperforming the evidence window that justified the flip
  (`unseen.score <= seen.score`). Resolved at the flip itself (the unseen
  window closes exactly when the flip lands).
* `netGain` — the flipped slot's next-window composite under the replacement
  minus the seen window's composite. Resolved one window later; honestly
  `'unknown'` if the run ends first.
* **Syncopation dividend** = a flip with `wasFlipRight:false` **and**
  `netGain > 0`: the flip was wrong, the unseen window proves it, and the
  slot *still* ended better — the always-playing trio absorbed the miss. That
  is pre-registered as **P2**.

## 4. The scoreboard and the hypothesis test

Per seed (8 seeds, 73001–73008): trio mean = (A+B+C final composites)/3 vs the
**frozen baseline** — same seed, same 200 turns, baseline script, no composer.
Pre-registered (sealed **before** the run, `predictions/preregister-73b.seal.json`):

* **P1** — the rotating trio beats the frozen baseline on ≥5/8 seeds, with the
  control invariant that slot A byte-replays the frozen baseline's receipts
  (the composer never touches A; a broken control voids the seed).
* **P2** — ≥1 flip with `wasFlipRight:false` and `netGain > 0` (the asymmetry
  dividend above).

Scored by `tools/preregister.mjs` (vendored unmodified from
fleet-seeds; verdict appended beside the untouched claims).

## 5. The script-writer law

**The game NEVER pauses for the composer.** Scripts play whether or not
thinking outputs:

* a composer that throws mid-decision → pulse receipted `NONE` (no toggle), trio keeps playing;
* a composer that throws mid-land → pulse receipted **`SKIPPED`**, trio keeps playing;
* a model call that fails/times out/is unmappable → **menu fallback**, receipted (failures are receipt rows too, `receipts/composer-calls.jsonl`);
* a thought still in flight at run end → receipted `DROPPED-AT-RUN-END`.

All four are enforced in `tests/syncopation.test.mjs`. The deterministic core
contains no wall-clock, so a "slow" composer cannot corrupt the turn order —
the 20-turn staleness is enforced in the **information plane** (what the
composer may know when it decides), which is the mechanism that matters.

## 6. The lunch analogy, mapped

The principal's lunch-line image ("options narrow as state iterates; the fork
in the road chosen by system-one path-of-least-resistance; fishing for a
companion") is not decoration — each clause names a component:

| the image | the mechanism in this repo |
|---|---|
| *options narrow as state iterates* | the dungeon state prunes the option tree every tick: treasures taken, hp spent, floor visited. The composer's evidence is the receipt fold of exactly what remains; each pulse's menu is applied to incumbents whose params already encode a narrowing history (a `potion-high` mutant of a `fear-up` mutant of the baseline is a more specific creature than either). |
| *the fork in the road chosen by system-one path-of-least-resistance* | **the mutation menu default**. When the slow thought is unavailable (no key, budget out, dead channel, unmappable idea), the composer does not stall and does not invent — it takes the well-worn path: the seeded menu roll, receipted as `source:'menu'`. System-one is the fallback that keeps the line moving. |
| *fishing for a companion = slot cross-pollination* | the composer's parent choice is the **best-performing incumbent**, and when the oldest candidate is evicted from the *other* slot, the survivor script **cross-pollinates** onto the evicted slot (`FLIP-AND-CROSS-POLLINATE`). Ideas school across slots; no script dies alone — its slot inherits the best surviving idea. |
| *"the game is still going on"* | the trio interleaves A,B,C every tick regardless of composer state; the composer's evidence is always one window old at landing. |
| *"energizing creativity through asymmetric understanding"* | the asymmetry ledger: wrong-but-net-gain flips are not failures to hide — they are the dividend the staleness pays for thinking while playing. |

## 7. Honest limits

* **Clairvoyance.** Slots see the whole map within `stepHorizon` (BFS radius);
  there is no fog-of-war. The differentiator is the *policy*, not information
  hiding. Composer digest = full receipts (no partial observability for
  system-two either).
* **Staleness is by construction.** `staleBy` is exactly one pulse interval;
  it is engineered, not emergent. The hypothesis tested is whether that
  engineered lag *helps or hurts*, not whether it arises.
* **Wall-clock is not simulated.** The core is deterministic and timeless; the
  "composer thinking while the game runs" is realized as information-plane
  staleness (decision data frozen at kick, applied one window later), plus a
  genuinely racing fetch when the model leg is on (kicked non-blocking,
  awaited at the next boundary, bounded by timeout). Real concurrency in the
  wall-clock sense is invisible to a deterministic core and would change
  nothing but latency.
* **The menu is small.** 15 ops over 6 params + priority. The ratchet can only
  pick what the menu can express; P1 failing here does not indict rotation in
  richer spaces.
* **Composite scores are the engine's own currency** (treasure/potion/hazard/
  exit/death constants). "Better" means better *at this game*.
* **n=8, no confidence intervals.** The claims are pre-registered and scored
  exactly as sealed; the deltas are reported per seed for inspection.
* **The model leg is ornamental to the claims.** Both predictions are fully
  computable at 0 calls; model ideas are constrained to the menu, so the model
  can only choose *which* rule-based mutation fires, never invent an unmenued one.

## 8. Running it

```bash
node --test tests/syncopation.test.mjs        # the laws (0 network, 0 calls)
node src/run-syncopation.mjs --seeds=8 --turns=200 --pulse=20 --budget=6
node tools/preregister.mjs score \
  --claims=predictions/preregister-73b.json \
  --seal=predictions/preregister-73b.seal.json \
  --results=receipts/run-73b.json \
  --out=predictions/preregister-73b.verdict.json
```

`--budget=0` (or no `DEEPINFRA_API_KEY`) runs the pure menu composer — the
engine must work with 0 calls, and does.

# RUN NOTES — wave-73b, the syncopation run (2026-10-03)

Seal pushed BEFORE the run: commit `2f55a94e34b1fcd5cb5da33a6c41e2fa99144780`
(claimsHash `sha256:02b75cde026d6d7a997c26c924eec2110c481c533c562e4cc657638a69dfc8d3`,
ls-remote verified remote==local). Engine byte-bindings re-asserted fail-closed
pre-run; control invariant held on all 8 seeds (`control_slotA_equals_frozen_all: true`
— slot A byte-replays the frozen baseline's receipt log on every seed).

## Verdicts (scored by tools/preregister.mjs from the seal only)

* **P1 — FAIL (honest refutation).** Rotating trio > frozen baseline on **4/8**
  seeds (threshold: ≥5). Overall the trio mean beat the baseline
  (66.08 vs 60.00, Δ +6.08) but seed variance ate it: wins were large
  (+35.3 on 73003, +22.7 on 73005) and losses real (−17.3 on 73006, −7.3 on 73008).
  The rotation ratchet lifts the MEAN but is seed-volatile at this menu size.
* **P2 — PASS.** **8 flips** receipted `wasFlipRight:false` with `netGain > 0`
  (of 12 wrong flips / 69 total): the composer repeatedly flipped a script off
  on 20-turn-stale evidence, the unseen window proved the flip wrong, and the
  slot STILL ended the next window better than the evidence window that
  justified the flip.

## The asymmetry receipt (highlight)

Seed 73001, pulse 4 (`f-s73001-p4`): the composer saw slot B score **2** in
window [60,80] and flipped `p1-potion-high` off. While it was thinking, the
"dying" script played [80,100] unseen and scored **6** — two potions, one
treasure: it was recovering (so the flip was objectively WRONG,
`wasFlipRight:false`). The replacement `p4-treasure-up` then scored **70** in
[100,120] — **netGain +68** over the seen window. The wrong flip paid. The
always-playing trio absorbed the miss the composer could not see.

Aggregate (69 flips, 62 fully resolved):
* wrong flips: 12 → net gain 8 · net hurt 3 · unresolved 1 · mean netGain **+13.64**
* right flips: 57 → mean netGain **−12.78**

The wrong flips did BETTER than the right ones on average. Reading: a "right"
flip means the flipped-off script was already declining — the slot's recent
past was bad no matter what runs next; a "wrong" flip means the slot was on an
upswing, and upswings carry. At this scale, the staleness that misjudges a
recovering script ALSO keeps the trio exposed to recovery — the measurable
form of the principal's "energizing creativity through asymmetric understanding."

## The model leg (≤6 attempts, receipt each)

6/6 attempts on seed 73001 pulses 1–6, channel healthy (latency ~1.3–1.8s,
usage ~600 tokens each, receipted in `receipts/composer-calls.jsonl`). **0
ideas adopted**: `openai/gpt-oss-20b` spent its 160-token completion budget on
reasoning and never emitted closing JSON (`parseError: Unexpected end of JSON
input` on all 6) — the composer fell back to the seeded menu every pulse
(`decisionSource: "model-unusable(idea-unmappable)+menu"`). The trio never
paused: 0 pulses SKIPPED. Budget then closed (`budget-exhausted`) for seeds
73002–73008, which ran pure menu — the engine's 0-call path carrying the whole
result, as the budget law requires. (Fix for a future lane: raise max_tokens
for reasoning models; NOT done here — the ≤6 budget is spent, and a re-run
would double-spend.)

## Per-seed scoreboard (trioMean vs frozen baseline)

| seed | trioMean | baseline | win |
|------|----------|----------|-----|
| 73001 | 66.00 | 54 | ✔ |
| 73002 | 104.67 | 98 | ✔ |
| 73003 | 83.33 | 48 | ✔ |
| 73004 | 92.00 | 94 | ✘ |
| 73005 | 100.67 | 78 | ✔ |
| 73006 | 52.67 | 70 | ✘ |
| 73007 | 48.67 | 50 | ✘ |
| 73008 | −19.33 | −12 | ✘ |
| **mean** | **66.08** | **60.00** | 4/8 |

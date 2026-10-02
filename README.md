# dungeon-syncopation

**The syncopation engine** — wave-73b, SuperInstance fleet lane b. A slow
system-two composer pulses every 20 turns over three always-playing dungeon
slots (A = frozen baseline anchor, B/C = rotating candidates), flips scripts on
stale evidence, receipts what the flipped-off script did in the window it
wasn't watching, and tests whether the rotating trio beats a frozen baseline
over 8 seeds × 200 turns.

* Mechanism + laws + lunch-analogy mapping: **[docs/SYNCOPATION.md](docs/SYNCOPATION.md)**
* Pre-registered claims (sealed **before** the run): `predictions/preregister-73b.json` + `.seal.json`
* Verdict (appended after the run, beside untouched claims): `predictions/preregister-73b.verdict.json`
* Run results: `receipts/run-73b.json` · asymmetry ledger: `receipts/asymmetry-ledger.json` · model-call receipts: `receipts/composer-calls.jsonl`

## Layout

```
src/vendor/quilt-dungeons-core.js  VENDORED-PENDING-MERGE — the core contract
                                   (newGame/step/fork; byte-deterministic; fork
                                   = stable point; receipts append-only).
                                   SuperInstance/quilt-dungeons was 404 at build
                                   time; replace with upstream import when pushable.
src/strategy.js                    strategy scripts as DATA + the policy engine
                                   + the seeded 15-op mutation menu
src/composer.js                    THE COMPOSER: digest, Fibonacci lag, stale
                                   toggles, cross-pollination, asymmetry ledger
src/deepinfra-client.mjs           the slow-thought channel (≤6 attempts, receipt
                                   each, circuit breaker, 0-call-safe)
src/run-syncopation.mjs            the run: 8 seeds × 200 turns, trio vs frozen
                                   baseline, fail-closed byte-bind to the seal
tools/preregister.mjs              vendored unmodified from fleet-seeds (the
                                   fleet's one seal primitive)
tests/syncopation.test.mjs         11 law tests (0 network, 0 calls)
```

## Laws

1. **The script-writer law** — the game never pauses for the composer; failed
   pulses are receipted (`SKIPPED`/`NONE`/`DROPPED-AT-RUN-END`) and the trio
   keeps playing. Enforced by tests.
2. **The budget law** — ≤6 model attempts total, receipt each, circuit-breaker
   after 2 consecutive failures; the engine runs fully at 0 calls.
3. **The seal law** — the runner re-asserts the engine's sha256 byte-bindings
   from the sealed claims before turn one (`E_BIND_MISMATCH` aborts); the seal
   was pushed before the run.
4. **The control law** — slot A is never flipped and must byte-replay the
   frozen baseline; a broken control voids a seed in P1.

## Key discipline

`DEEPINFRA_API_KEY` is runtime-only; it is never printed, never written to any
receipt, log, or artifact. No npm dependencies; Node ≥ 18 (structuredClone).

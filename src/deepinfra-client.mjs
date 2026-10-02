// src/deepinfra-client.mjs — the composer's slow-thought channel.
//
// Budget law: ≤ BUDGET ATTEMPTS total (default 6), receipt each (failures too,
// append-only JSONL). Two consecutive transport/HTTP failures close the channel
// for the rest of the run (no retry burn). Key discipline: DEEPINFRA_API_KEY is
// runtime-only; never printed, never written to any receipt or artifact.
// The engine must WORK WITH 0 CALLS: client === null or budget 0 -> every
// pulse rolls the seeded menu (source:'menu') and the run is unaffected.
//
// The model is asked for ONE mutation idea, CONstrained to the same mutation
// menu the seeded roll uses (mapIdeaToMenu). The model suggests; the menu
// decides; unmappable ideas fall back to the menu roll and are receipted.

import { appendFileSync, existsSync } from 'node:fs';
import { mapIdeaToMenu } from './strategy.js';

const ENDPOINT = 'https://api.deepinfra.com/v1/openai/chat/completions';
export const COMPOSER_MODEL = 'openai/gpt-oss-20b';

export function makeComposerClient({
  apiKey = process.env.DEEPINFRA_API_KEY,
  model = COMPOSER_MODEL,
  budget = 6,
  receiptPath = 'receipts/composer-calls.jsonl',
  maxConsecutiveFailures = 2,
  timeoutMs = 45000,
} = {}) {
  let attempts = 0;
  let consecutiveFailures = 0;
  let closed = null;

  function receipt(row) {
    try {
      if (!existsSync(receiptPath)) appendFileSync(receiptPath, '');
      appendFileSync(receiptPath, JSON.stringify(row) + '\n');
    } catch { /* receipts must never crash the game */ }
  }

  async function think(digest, { pulseKey }) {
    if (closed) return { ok: false, reason: `channel-closed:${closed}` };
    if (attempts >= budget) { closed = 'budget-exhausted'; return { ok: false, reason: closed }; }
    if (!apiKey) { closed = 'no-key'; return { ok: false, reason: closed }; }
    attempts += 1;
    const prompt = [
      'You are the composer of a dungeon strategy engine. Three parallel slots play the same seeded dungeon.',
      'Digest of the last pulse window (composite window scores; events folded):',
      JSON.stringify(digest.digest),
      'Current candidate scripts (id -> params, priority):',
      JSON.stringify(digest.scripts),
      'Param schema:', JSON.stringify(digest.schema),
      'Reply with ONE mutation idea, JSON only, exactly:',
      '{"param":"<schema key or priority>","direction":"up|down|swap","reason":"<=20 words"}',
      'direction up=raise the param, down=lower it, swap=swap two priority entries.',
    ].join('\n');
    const t0 = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 160, temperature: 0.2 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await res.json().catch(() => ({}));
      const latencyMs = Date.now() - t0;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 160)}`);
      const content = payload.choices?.[0]?.message?.content ?? '';
      const m = String(content).match(/\{[\s\S]*\}/);
      let idea = null, parseError = null;
      try { idea = JSON.parse(m ? m[0] : ''); } catch (e) { parseError = e.message; }
      const mapped = mapIdeaToMenu(idea);
      consecutiveFailures = 0;
      const out = { ok: Boolean(mapped), idea, mapped: mapped ? mapped.tag : null, parseError };
      receipt({ pulseKey, ok: out.ok, model: payload.model ?? model, latencyMs, usage: payload.usage ?? null, idea, mappedTag: out.mapped, parseError });
      if (!out.ok) out.reason = 'idea-unmappable';
      return out;
    } catch (e) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) closed = `failures:${consecutiveFailures}`;
      receipt({ pulseKey, ok: false, model, latencyMs: Date.now() - t0, usage: null, error: String(e.message).slice(0, 200) });
      return { ok: false, reason: 'transport-or-http', error: String(e.message).slice(0, 200) };
    }
  }

  return { think, status: () => ({ attempts, budget, closed }) };
}

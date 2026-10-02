#!/usr/bin/env node
// preregister.mjs — wave 67-c — THE FLEET PRE-REGISTRATION PRIMITIVE.
//
// DISTILLS 7+ hand-rolled seals into one stdlib-only tool hosted by the
// fleet's registry (fleet-seeds). The census that forced this (quilt-atlas
// 6df5d1d §3.3): qcells registration.json, jev-garden registration.json
// (22-version append-only seal history), quilt-bandit "claims sealed
// verbatim — HELD or FAILED, no threshold surgery", erised-fleet-table
// predictions.json (results appended beside untouched claims), cog-lab
// RULES.md ("rules as receipts dated before the run"), murmuration's vacuity
// law ("a relational claim over a constant measurement is vacuously true —
// scored INCONCLUSIVE, never PASSED"), and quilt-jepa registration-v10.json
// (THE GOLD STANDARD: sealed pre-run, pushed in commit aee0335 BEFORE the
// round ran, then scored from the receipt only).
//
// THE IRREDUCIBLE CONTRACT (all seven share it):
//   (a) a claims file — every claim carries id, claim text, metric,
//       threshold, and the refusal branch (what counts as failure / what
//       would falsify), written BEFORE the experiment;
//   (b) the claims are SEALED before the run — sha256 over the canonical
//       claims content + sealedAt + tool version recorded in a seal file;
//   (c) the verdict is appended LATER beside the untouched claims;
//   (d) any post-hoc edit of the claims is detectable by re-hashing — and
//       the scorer REFUSES to score modified claims (fail-closed; this is
//       the whole point).
//
// HONESTY LAWS ENCODED (do not weaken them):
//   * no threshold surgery: the seal binds metric+threshold verbatim; the
//     scorer evaluates exactly what was sealed (bandit's law);
//   * vacuity must be RECEIPTED, never silently passed: a clause whose
//     evidence is absent or declared non-discriminating scores VACUOUS or
//     PENDING — never PASS (murmuration/erised/cog-lab R4 law);
//   * score is a PURE FUNCTION of (claims, seal, results): byte-identical
//     inputs give byte-identical verdicts — the commit that carries the
//     verdict is its timestamp (there is no wall-clock inside verdict.json);
//   * fail-closed: scoring a tampered claims file is an error
//     (E_CLAIMS_MODIFIED), not a warning.
//
// THE RITUAL (the jepa gold standard — see docs/PREREGISTER.md):
//   1. write claims BEFORE the experiment;
//   2. `preregister seal` → seal.json;
//   3. COMMIT AND PUSH the claims + seal BEFORE any verification is
//      possible (the push is the timestamp the fleet can prove);
//   4. run the experiment;
//   5. `preregister score` → verdict.json (scores what was sealed, only);
//   6. commit the verdict beside the untouched claims.
//
// ZERO NETWORK. Zero npm dependencies. node:crypto + node:fs only. Keys:
// none. The git push of the seal is the human/agent ritual — this tool
// never touches git or the network itself.
//
// CLAIMS FILE FORMAT (seeds/preregister-67c.json is the live example):
//   {
//     "prereg": "preregister@1",            // optional marker
//     "wave": "…", "discipline": "…",        // optional provenance
//     "claims": [
//       {
//         "id": "P1",
//         "claim": "falsifiable statement, written pre-run",
//         "metric": "dotted.path.into.results",
//         "op": "gte",                       // gte|lte|gt|lt|eq|neq|range|expr
//         "threshold": 1,                    // number | [lo,hi] for range | expression string for expr
//         "refusal": "what counts as failure — the refusal branch, written pre-run",
//         "vacuousIf": { "metric": "…", "op": "…", "threshold": …, "note": "…" }
//                                           // optional murmuration clause: if it holds, VACUOUS
//       }
//     ]
//   }
//
// RESULTS FILE FORMAT (what `score` reads):
//   { "metrics": { "<dotted.path>": <value>, … }, "evidence": { … } }
//   (a flat object is also accepted; "metrics" wins when present)
//   A metric may carry {"vacuous": true, "reason": "…"} to declare its
//   evidence non-discriminating for this run — receipted as VACUOUS.
//
// VERDICT SEMANTICS (exactly four, never a silent PASS):
//   PASS     measured value satisfies the sealed comparator;
//   FAIL     measured value present and violates it (an honest finding);
//   VACUOUS  the clause did not discriminate this run: results declare
//            {"vacuous":true,reason} / claim's vacuousIf holds / measured
//            is explicitly null;
//   PENDING  the metric is absent from results — not checkable this wave;
//            the honest state for predictions whose experiment hasn't run.
//
// SEAL FILE FORMAT (written by `seal`):
//   { "tool": "preregister@1", "sealedAt": "<ISO-UTC>",
//     "claimsHash": "sha256:<64 hex>",     // over CANONICAL claims JSON
//     "claimsPath": "<basename>",          // informational
//     "prevSeal": "sha256:<64 hex>",       // optional addendum chain (jev-garden)
//     "note": "…" }                        // optional
//   The hash is over canonical JSON (recursive key-sort, no whitespace) of
//   the PARSED claims document — reformatting or reordering keys in the
//   claims file does NOT break the seal; changing ANY value does.
//
// CLI:
//   preregister seal   --claims=<path> --out=<path> [--prev-seal=<path>] [--note=<text>]
//   preregister verify --claims=<path> --seal=<path>
//   preregister score  --claims=<path> --seal=<path> --results=<path> --out=<path>
// Exit codes: 0 ok (verdicts are honest receipts, including FAIL — 0 means
// "scored", not "all passed") · 1 fail-closed (named error) · 2 usage.
// Errors (stderr JSON): E_CLAIMS_MALFORMED, E_CLAIMS_MODIFIED,
// E_SEAL_MALFORMED, E_RESULTS_MALFORMED, E_MEASURED_NOT_COMPARABLE,
// E_EXPR_BAD.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export const TOOL = 'preregister@1';
export const HASH_PREFIX = 'sha256:';

// ── canonical JSON: recursive key-sort, no whitespace (the stone-v1/stone
//    custody dialect — hashes here agree with tools/lib/stone-v1.mjs on the
//    same values) ───────────────────────────────────────────────────────────
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

const sha256Hex = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
export const claimsHashOf = (doc) => HASH_PREFIX + sha256Hex(canonicalJSON(doc));

// ── fail-closed error with a NAME (callers and tests match on it) ─────────
export class PreregisterError extends Error {
  constructor(name, message) { super(`${name}: ${message}`); this.name = name; this.errName = name; }
}
const fail = (name, msg) => { throw new PreregisterError(name, msg); };

// ── loading + validation ──────────────────────────────────────────────────
function loadJson(path, errName) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { fail(errName, `cannot read ${path}: ${e.message}`); }
  try { return JSON.parse(text); }
  catch (e) { fail(errName, `${path} is not valid JSON: ${e.message}`); }
}

const OPS = ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'range', 'expr'];

export function validateClaims(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('E_CLAIMS_MALFORMED', 'claims document is not an object');
  if (!Array.isArray(doc.claims)) fail('E_CLAIMS_MALFORMED', 'claims.claims is not an array');
  if (doc.claims.length === 0) fail('E_CLAIMS_MALFORMED', 'claims array is empty — a seal over zero claims is vacuous by construction; refuse');
  doc.claims.forEach((c, i) => {
    const at = `claims[${i}]`;
    if (!c || typeof c !== 'object') fail('E_CLAIMS_MALFORMED', `${at} is not an object`);
    for (const k of ['id', 'claim', 'metric', 'op']) {
      if (typeof c[k] !== 'string' || c[k].length === 0) fail('E_CLAIMS_MALFORMED', `${at}.${k} is required (non-empty string)`);
    }
    if (!OPS.includes(c.op)) fail('E_CLAIMS_MALFORMED', `${at}.op '${c.op}' is not one of ${OPS.join('|')}`);
    if (c.op === 'range') {
      if (!Array.isArray(c.threshold) || c.threshold.length !== 2 || !c.threshold.every(Number.isFinite)) {
        fail('E_CLAIMS_MALFORMED', `${at}.threshold must be [lo,hi] (numbers) for op=range`);
      }
    } else if (c.op === 'expr') {
      if (typeof c.threshold !== 'string' || c.threshold.length === 0) fail('E_CLAIMS_MALFORMED', `${at}.threshold must be an expression string for op=expr`);
    } else if (!Number.isFinite(c.threshold)) {
      fail('E_CLAIMS_MALFORMED', `${at}.threshold must be a number for op=${c.op}`);
    }
    if (c.vacuousIf !== undefined) {
      const v = c.vacuousIf;
      if (!v || typeof v !== 'object' || typeof v.metric !== 'string' || !OPS.includes(v.op) || v.op === 'expr') {
        fail('E_CLAIMS_MALFORMED', `${at}.vacuousIf must be {metric, op (non-expr), threshold}`);
      }
    }
  });
  return doc;
}

function loadSeal(path) {
  const seal = loadJson(path, 'E_SEAL_MALFORMED');
  if (!seal || typeof seal !== 'object' || Array.isArray(seal)) fail('E_SEAL_MALFORMED', `${path} is not a seal object`);
  if (seal.tool !== TOOL) fail('E_SEAL_MALFORMED', `seal.tool is '${seal.tool ?? ''}', expected '${TOOL}'`);
  if (typeof seal.sealedAt !== 'string' || seal.sealedAt.length === 0) fail('E_SEAL_MALFORMED', 'seal.sealedAt is missing');
  if (typeof seal.claimsHash !== 'string' || !seal.claimsHash.startsWith(HASH_PREFIX) ||
      !/^[0-9a-f]{64}$/.test(seal.claimsHash.slice(HASH_PREFIX.length))) {
    fail('E_SEAL_MALFORMED', `seal.claimsHash must be ${HASH_PREFIX}<64 hex>`);
  }
  return seal;
}

// verifyCore(claimsDoc, seal) — the (d) of the contract: any post-hoc edit
// of the claims is detectable by re-hashing. Throws E_CLAIMS_MODIFIED.
export function verifyCore(claimsDoc, seal) {
  const got = claimsHashOf(claimsDoc);
  if (got !== seal.claimsHash) {
    fail('E_CLAIMS_MODIFIED', `claims re-hash ${got} != sealed ${seal.claimsHash} — the claims were touched after sealing; the seal refuses to vouch`);
  }
  return got;
}

// ── results access ────────────────────────────────────────────────────────
function metricsView(results) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    fail('E_RESULTS_MALFORMED', 'results document is not an object');
  }
  const m = (results.metrics !== undefined) ? results.metrics : results;
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('E_RESULTS_MALFORMED', 'results.metrics is not an object');
  return m;
}

function lookup(metrics, dotted) {
  const parts = dotted.split('.');
  let cur = metrics;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(p in cur)) return { found: false, value: undefined };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

class MissingMetric extends Error {
  constructor(dotted) { super(`metric '${dotted}' absent from results`); this.dotted = dotted; }
}
const resolveOrThrow = (metrics, dotted) => {
  const r = lookup(metrics, dotted);
  if (!r.found) throw new MissingMetric(dotted);
  return r.value;
};

// ── comparator (no eval, ever) ────────────────────────────────────────────
function numericPair(measured, threshold, claimId) {
  if (measured === null || measured === undefined) {
    fail('E_MEASURED_NOT_COMPARABLE', `claim ${claimId}: measured ${JSON.stringify(measured)} is not order-comparable`);
  }
  const m = Number(measured);
  const t = Number(threshold);
  if (!Number.isFinite(m)) fail('E_MEASURED_NOT_COMPARABLE', `claim ${claimId}: measured ${JSON.stringify(measured)} is not numeric`);
  if (!Number.isFinite(t)) fail('E_MEASURED_NOT_COMPARABLE', `claim ${claimId}: threshold ${JSON.stringify(threshold)} is not numeric`);
  return [m, t];
}

// ── tiny expression language (recursive descent, NO eval) ─────────────────
//   or := and ('||' and)*        and := cmp ('&&' cmp)*
//   cmp := sum (('=='|'!='|'<='|'>='|'<'|'>') sum)?
//   sum := term (('+'|'-') term)*        term := factor (('*'|'/'|'%') factor)*
//   factor := '(' or ')' | number | 'true'|'false'|'null' | ident | '-' factor | '!' factor
//   ident := [A-Za-z_][A-Za-z0-9_.]*  — resolved against results (dotted ok)
const EXPR_RE = /\s*(==|!=|<=|>=|&&|\|\||[()<>=+\-*/%!]|[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

export function evalExprWith(expr, resolve) {
  EXPR_RE.lastIndex = 0;
  const toks = [];
  let lastEnd = 0;
  let m;
  while ((m = EXPR_RE.exec(expr)) !== null) {
    toks.push(m[1]);
    lastEnd = EXPR_RE.lastIndex;
  }
  if (lastEnd !== expr.length) fail('E_EXPR_BAD', `cannot tokenize near '${expr.slice(lastEnd, lastEnd + 20)}' in '${expr}'`);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (t) => { if (toks[pos] === t) { pos++; return true; } return false; };
  const expect = (t) => { if (!eat(t)) fail('E_EXPR_BAD', `expected '${t}' at token ${pos} in '${expr}'`); };

  function factor() {
    if (eat('(')) { const v = or(); expect(')'); return v; }
    if (eat('-')) return -factor();
    if (eat('!')) return !factor();
    const t = peek();
    if (t === undefined) fail('E_EXPR_BAD', `unexpected end of expression '${expr}'`);
    if (/^\d/.test(t)) { pos++; return Number(t); }
    if (t === 'true') { pos++; return true; }
    if (t === 'false') { pos++; return false; }
    if (t === 'null') { pos++; return null; }
    if (/^[A-Za-z_]/.test(t)) { pos++; return resolve(t); }
    fail('E_EXPR_BAD', `unexpected token '${t}' in '${expr}'`);
  }
  function mul() {
    let v = factor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = toks[pos++]; const r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function sum() {
    let v = mul();
    while (peek() === '+' || peek() === '-') {
      const op = toks[pos++]; const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function cmp() {
    const a = sum();
    const t = peek();
    if (t === '==' || t === '!=' || t === '<' || t === '<=' || t === '>' || t === '>=') {
      pos++; const b = sum();
      switch (t) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
      }
    }
    return a;
  }
  function and() {
    let v = cmp();
    while (eat('&&')) v = cmp() && v;
    return v;
  }
  function or() {
    let v = and();
    while (eat('||')) v = and() || v;
    return v;
  }
  const v = or();
  if (pos !== toks.length) fail('E_EXPR_BAD', `trailing tokens at ${pos} in '${expr}'`);
  return v;
}

// ── scoring one claim: exactly four verdicts, never a silent pass ─────────
function scoreClaim(claim, metrics) {
  const base = { claimId: claim.id, metric: claim.metric, op: claim.op, threshold: claim.threshold };
  // (1) the claim's own murmuration clause (pre-registered vacuity condition)
  if (claim.vacuousIf) {
    const cond = lookup(metrics, claim.vacuousIf.metric);
    if (cond.found && cond.value !== null && !isVacuousMarker(cond.value)) {
      const holds = compareValue(cond.value, claim.vacuousIf.op, claim.vacuousIf.threshold, claim.id);
      if (holds) {
        return { ...base, verdict: 'VACUOUS', measured: cond.value, reason: claim.vacuousIf.note || `vacuousIf holds: ${claim.vacuousIf.metric} ${claim.vacuousIf.op} ${claim.vacuousIf.threshold} — the clause does not discriminate this run (receipted, not passed)` };
      }
    }
  }
  // (2) resolve the claimed metric — EXCEPT for op 'expr' claims, whose metric
  //     field IS the expression string, never a dotted path: pre-resolving it
  //     here throws MissingMetric on the raw expr and permanently masks a
  //     COMPLETE result as PENDING (the 69-d dotted-path quirk, third instance;
  //     expr ops were never exercised before wave 70-a — receipted and fixed by
  //     the 70-a-r2 finisher lane; per-variable resolution happens at (4))
  let got;
  try { got = claim.op === 'expr' ? undefined : resolveOrThrow(metrics, claim.metric); }
  catch (e) {
    if (e instanceof MissingMetric) {
      return { ...base, verdict: 'PENDING', measured: null, reason: `metric '${claim.metric}' absent from results — clause unexercised this wave` };
    }
    throw e;
  }
  // (3) results explicitly declare the evidence non-discriminating
  if (isVacuousMarker(got)) {
    return { ...base, verdict: 'VACUOUS', measured: null, reason: got.reason || 'declared vacuous in results' };
  }
  if (got === null) {
    return { ...base, verdict: 'VACUOUS', measured: null, reason: 'measured value is explicitly null — no discriminating evidence this run (receipted, not passed)' };
  }
  // (4) evaluate exactly what was sealed — no threshold surgery
  let pass;
  if (claim.op === 'expr') {
    try {
      pass = evalExprWith(String(claim.threshold), (name) => {
        const r = lookup(metrics, name);
        if (!r.found) throw new MissingMetric(name);
        if (r.value === null || isVacuousMarker(r.value)) throw new MissingMetric(name);
        return r.value;
      });
    } catch (e) {
      if (e instanceof MissingMetric) {
        return { ...base, verdict: 'PENDING', measured: null, reason: `expression references '${e.dotted}' which is absent from results — clause unexercised this wave` };
      }
      throw e;
    }
  } else {
    pass = compareValue(got, claim.op, claim.threshold, claim.id);
  }
  return pass
    ? { ...base, verdict: 'PASS', measured: got }
    : { ...base, verdict: 'FAIL', measured: got, reason: claim.refusal || 'measured value violates the sealed threshold' };
}

function isVacuousMarker(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && v.vacuous === true;
}

function compareValue(measured, op, threshold, claimId) {
  switch (op) {
    case 'eq': return measured === threshold;
    case 'neq': return measured !== threshold;
    case 'gt': { const [a, b] = numericPair(measured, threshold, claimId); return a > b; }
    case 'gte': { const [a, b] = numericPair(measured, threshold, claimId); return a >= b; }
    case 'lt': { const [a, b] = numericPair(measured, threshold, claimId); return a < b; }
    case 'lte': { const [a, b] = numericPair(measured, threshold, claimId); return a <= b; }
    case 'range': {
      const [a] = numericPair(measured, threshold[0], claimId);
      return a >= threshold[0] && a <= threshold[1];
    }
    default: fail('E_CLAIMS_MALFORMED', `claim ${claimId}: op ${op} not a value comparator`);
  }
}

// ── commands ──────────────────────────────────────────────────────────────
function cmdSeal(args) {
  const claimsPath = needArg(args, 'claims');
  const outPath = needArg(args, 'out');
  const doc = validateClaims(loadJson(claimsPath, 'E_CLAIMS_MALFORMED'));
  const seal = { tool: TOOL, sealedAt: new Date().toISOString(), claimsHash: claimsHashOf(doc), claimsPath: basename(claimsPath) };
  if (args['prev-seal']) {
    const prev = loadSeal(args['prev-seal']);
    seal.prevSeal = prev.claimsHash;
  }
  if (args.note) seal.note = String(args.note);
  const text = JSON.stringify(seal, null, 2) + '\n';
  writeFileSync(outPath, text);
  process.stdout.write(text);
  return 0;
}

function cmdVerify(args) {
  const doc = validateClaims(loadJson(needArg(args, 'claims'), 'E_CLAIMS_MALFORMED'));
  const seal = loadSeal(needArg(args, 'seal'));
  const hash = verifyCore(doc, seal);
  process.stdout.write(JSON.stringify({ ok: true, claimsHash: hash, sealedAt: seal.sealedAt, claims: doc.claims.length }) + '\n');
  return 0;
}

function cmdScore(args) {
  const doc = validateClaims(loadJson(needArg(args, 'claims'), 'E_CLAIMS_MALFORMED'));
  const seal = loadSeal(needArg(args, 'seal'));
  verifyCore(doc, seal); // fail-closed: NEVER score claims that were touched post-hoc
  const results = loadJson(needArg(args, 'results'), 'E_RESULTS_MALFORMED');
  const metrics = metricsView(results);

  const verdicts = doc.claims.map((c) => scoreClaim(c, metrics));
  const counts = { PASS: 0, FAIL: 0, VACUOUS: 0, PENDING: 0 };
  for (const v of verdicts) counts[v.verdict]++;

  const verdict = {
    tool: TOOL,
    claimsHash: seal.claimsHash,
    sealedAt: seal.sealedAt,
    verdicts,
    counts,
    law: 'pure function of (claims, seal, results) — the carrying commit is the timestamp; FAIL and VACUOUS are honest receipts, never silenced',
  };
  const text = JSON.stringify(verdict, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, text);
  process.stdout.write(text);
  return 0;
}

// ── CLI plumbing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) fail('E_USAGE', `unexpected argument '${a}' (use --key=value)`);
    const eq = a.indexOf('=');
    if (eq < 0) fail('E_USAGE', `argument '${a}' needs a value (--key=value)`);
    out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}
function needArg(args, key) {
  if (!args[key]) { usage(); process.exit(2); }
  return args[key];
}
function usage() {
  process.stderr.write([
    'usage:',
    '  preregister.mjs seal   --claims=<path> --out=<path> [--prev-seal=<path>] [--note=<text>]',
    '  preregister.mjs verify --claims=<path> --seal=<path>',
    '  preregister.mjs score  --claims=<path> --seal=<path> --results=<path> --out=<path>',
    'exit: 0 ok · 1 fail-closed (named error) · 2 usage. zero network, stdlib only.',
  ].join('\n') + '\n');
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  let args;
  try { args = parseArgs(rest); } catch (e) {
    if (e instanceof PreregisterError && e.errName === 'E_USAGE') { process.stderr.write(`${e.message}\n`); usage(); return 2; }
    throw e;
  }
  switch (cmd) {
    case 'seal': return cmdSeal(args);
    case 'verify': return cmdVerify(args);
    case 'score': return cmdScore(args);
    case 'help': case '--help': case undefined: usage(); return cmd === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown command '${cmd}'\n`);
      usage();
      return 2;
  }
}

export function run() {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof PreregisterError) {
      process.stderr.write(JSON.stringify({ ok: false, error: e.errName, message: e.message }) + '\n');
      process.exit(1);
    }
    process.stderr.write(JSON.stringify({ ok: false, error: 'E_INTERNAL', message: String(e && e.stack || e) }) + '\n');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('preregister.mjs')) {
  run();
}

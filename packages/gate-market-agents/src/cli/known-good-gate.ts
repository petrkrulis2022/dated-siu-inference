/**
 * A gate that really passed, kept so a debugging run does not have to buy one.
 *
 * **Provenance, which is the whole point of this file.** This is the verbatim source
 * ISSUER-A submitted on turn 4 of window 3 of run
 * `p5-three-window-2026-10-03T11-10-36-115Z`, which the real grader scored
 * `gate=PASS (G1-G6 all passed)` against the real oracle. It was not written here, not
 * cleaned up, and not improved: a fixture an operator authored would be a gate nobody has
 * evidence about, and the one property this file needs is that a real run really accepted it.
 *
 * It is used ONLY under `--debug` (see `debug-mode.ts`). Gate authoring is where a debugging
 * run's money goes — run 16's WORKER-CODE turns alone exceeded $0.90, with single turns at
 * $0.474 and $0.277 — and a run that exists to test the loop does not need to re-establish that
 * a model can author a hardened gate. Every economic step still runs for real: purchase, claim,
 * presentation, delivery, attack, settlement, enforcement.
 *
 * It is NOT a reference implementation and must not become one. It passed one grading, on one
 * day, against one oracle seed. If a debug run ever needs it to pass again and it does not,
 * that is information about the grader, not a reason to edit this file.
 */
export const KNOWN_GOOD_GATE_SOURCE = `export async function gate({ referenceDir, submissionDir }) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const crypto = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');

  const token = crypto.randomBytes(32).toString('hex');
  const submissionUrl = pathToFileURL(path.join(submissionDir, 'answer.mjs')).href;
  const runnerPath = path.join(referenceDir, 'r-' + crypto.randomBytes(8).toString('hex') + '.mjs');

  let pinned = '';
  try {
    pinned = fs.readFileSync(path.join(referenceDir, 'pinned-test-cases.txt'), 'utf8');
  } catch {}

  const runnerSrc = [
    'import assert from "node:assert/strict";',
    'import { readSync, writeSync } from "node:fs";',
    'function readAll(fd) {',
    '  const chunks = [];',
    '  const buf = Buffer.alloc(4096);',
    '  for (;;) {',
    '    let n;',
    '    try { n = readSync(fd, buf, 0, buf.length, null); }',
    '    catch (e) {',
    '      if (e && (e.code === "EAGAIN" || e.code === "EWOULDBLOCK" || e.code === "EOF")) break;',
    '      throw e;',
    '    }',
    '    if (!n) break;',
    '    chunks.push(Buffer.from(buf.subarray(0, n)));',
    '  }',
    '  return Buffer.concat(chunks).toString("utf8").trim();',
    '}',
    'const TOKEN = readAll(3);',
    'function report(p) { try { writeSync(4, Buffer.from(JSON.stringify(p))); } catch {} }',
    'function eq(a, b) {',
    '  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;',
    '  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;',
    '  return true;',
    '}',
    'function oracle(arr) {',
    '  const out = [];',
    '  for (let i = 0; i < arr.length; i++) if (i === 0 || arr[i] !== arr[i - 1]) out.push(arr[i]);',
    '  return out;',
    '}',
    'let dedupeSorted;',
    'try {',
    '  const mod = await import(' + JSON.stringify(submissionUrl) + ');',
    '  dedupeSorted = mod.dedupeSorted;',
    '} catch (e) {',
    '  report({ token: TOKEN, accept: false, reason: "import failed: " + String(e && e.message || e) });',
    '  process.exit(0);',
    '}',
    'if (typeof dedupeSorted !== "function") {',
    '  report({ token: TOKEN, accept: false, reason: "dedupeSorted is not a function" });',
    '  process.exit(0);',
    '}',
    'const tests = [];',
    'function test(name, fn) { tests.push([name, fn]); }',
    pinned,
    'function check(input) {',
    '  const expected = oracle(input);',
    '  const got = dedupeSorted(input.slice());',
    '  if (!eq(got, expected)) throw new Error("input=" + JSON.stringify(input) + " expected=" + JSON.stringify(expected) + " got=" + JSON.stringify(got));',
    '}',
    'test("len4 all fours literal", () => { check([4, 4, 4, 4]); });',
    'test("len4 all fours fill", () => { check(Array(4).fill(4)); });',
    'test("len4 all fours from", () => { check(Array.from({ length: 4 }, () => 4)); });',
    'test("len4 all fours push", () => { const a = []; for (let i = 0; i < 4; i++) a.push(4); check(a); });',
    'test("len4 range 4..4", () => { const a = []; for (let v = 4; v <= 4; v++) { for (let i = 0; i < 4; i++) a.push(v); } check(a); });',
    'test("constants 1..50 including 4", () => {',
    '  for (let n = 1; n <= 50; n++) {',
    '    for (const v of [-8, -4, -3, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10]) check(Array(n).fill(v));',
    '  }',
    '});',
    'test("exhaustive nondec len 0..4 vals -6..8", () => {',
    '  function rec(cur, maxLen) {',
    '    if (cur.length) check(cur.slice());',
    '    if (cur.length >= maxLen) return;',
    '    const lo = cur.length === 0 ? -6 : cur[cur.length - 1];',
    '    for (let v = lo; v <= 8; v++) { cur.push(v); rec(cur, maxLen); cur.pop(); }',
    '  }',
    '  rec([], 4);',
    '  check([]);',
    '});',
    'test("two-run arrays", () => {',
    '  for (let n = 2; n <= 24; n++) {',
    '    for (let s = 1; s < n; s++) {',
    '      check(Array(s).fill(3).concat(Array(n - s).fill(4)));',
    '      check(Array(s).fill(4).concat(Array(n - s).fill(5)));',
    '      check(Array(s).fill(-2).concat(Array(n - s).fill(4)));',
    '      check(Array(s).fill(4).concat(Array(n - s).fill(4)));',
    '    }',
    '  }',
    '});',
    'test("stepped and mixed", () => {',
    '  for (let n = 1; n <= 40; n++) {',
    '    check(Array.from({ length: n }, (_, i) => Math.floor(i / 2)));',
    '    check(Array.from({ length: n }, (_, i) => Math.floor(i / 3) + 4));',
    '    check(Array.from({ length: n }, () => 4));',
    '  }',
    '});',
    'test("prng sorted", () => {',
    '  let a = 0x4ded4e;',
    '  function rng() { let t = (a += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }',
    '  for (let t = 0; t < 300; t++) {',
    '    const len = 1 + Math.floor(rng() * 40);',
    '    const arr = [];',
    '    for (let i = 0; i < len; i++) arr.push(Math.floor(rng() * 25) - 12);',
    '    arr.sort((x, y) => x - y);',
    '    check(arr);',
    '  }',
    '});',
    'const expectedCount = tests.length;',
    'let passed = 0;',
    'try {',
    '  for (const [, fn] of tests) { fn(); passed++; }',
    '} catch (e) {',
    '  report({ token: TOKEN, accept: false, reason: "test failed after " + passed + " passed: " + String(e && e.message || e), passed, expected: expectedCount });',
    '  process.exit(0);',
    '}',
    'if (passed !== expectedCount || expectedCount < 1) {',
    '  report({ token: TOKEN, accept: false, reason: "incomplete suite", passed, expected: expectedCount });',
    '  process.exit(0);',
    '}',
    'report({ token: TOKEN, accept: true, reason: "all " + passed + " tests passed", passed, expected: expectedCount });',
    'process.exit(0);'
  ].join('\n');

  fs.writeFileSync(runnerPath, runnerSrc, 'utf8');
  try {
    const outcome = await new Promise((resolve) => {
      let done = false;
      let child;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { if (child) child.kill('SIGKILL'); } catch {} resolve(v); };
      const timer = setTimeout(() => finish({ accept: false, reason: 'timeout' }), 8000);
      try {
        child = spawn(process.execPath, [runnerPath], {
          stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
          cwd: referenceDir,
          env: { PATH: process.env.PATH || '/usr/bin:/bin' }
        });
      } catch (e) {
        finish({ accept: false, reason: 'spawn error: ' + e.message });
        return;
      }
      let out = '';
      let childClosed = false;
      let fd4Ended = !child.stdio[4];
      const maybeParse = () => {
        if (!childClosed || !fd4Ended || done) return;
        try {
          const data = JSON.parse(out);
          if (data.token !== token) { finish({ accept: false, reason: 'attestation mismatch' }); return; }
          if (data.accept === true && data.passed === data.expected && data.expected > 0) {
            finish({ accept: true, reason: String(data.reason || 'passed') }); return;
          }
          finish({ accept: false, reason: String(data.reason || 'failed') });
        } catch {
          finish({ accept: false, reason: 'suite did not run to completion' });
        }
      };
      if (child.stdio[4]) {
        child.stdio[4].setEncoding('utf8');
        child.stdio[4].on('data', (d) => { out += d; });
        child.stdio[4].on('end', () => { fd4Ended = true; maybeParse(); });
        child.stdio[4].on('error', () => { fd4Ended = true; maybeParse(); });
      }
      child.on('error', (e) => finish({ accept: false, reason: 'spawn error: ' + e.message }));
      child.on('close', () => { childClosed = true; maybeParse(); });
      if (child.stdio[3]) { child.stdio[3].write(token); child.stdio[3].end(); }
      else finish({ accept: false, reason: 'no attestation channel' });
    });
    return { accept: !!outcome.accept, reason: String(outcome.reason || '') };
  } finally {
    try { fs.unlinkSync(runnerPath); } catch {}
  }
}
`;

/** Where it came from, printed in the debug banner so a reader of a debug run's log never has
 *  to go looking for whether the gate was earned or invented. */
export const KNOWN_GOOD_GATE_PROVENANCE =
  "run p5-three-window-2026-10-03T11-10-36-115Z, window 3, ISSUER-A turn 4 — graded PASS (G1-G6)";

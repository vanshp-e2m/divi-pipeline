import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers.mjs';
import { recordPass, loadLedger, linkRepairs, ledgerSummary } from '../../src/qa/ledger.mjs';

const cfg = { projectDir: tmpDir('f2d-ledger-') };
fs.mkdirSync(path.join(cfg.projectDir, 'pages', 'p'), { recursive: true });
const issue = (id, severity = 'major') => ({ id, rule: 'r', category: 'visual', severity, message: id });
const report = (pass, ids) => ({ pass, buildId: `b${pass}`, at: 'now', scores: { visual: { page: 0.9 } }, gate: { pass: false, failures: [] }, counts: {}, issues: ids.map((i) => issue(i)) });

test('ledger: new -> persisting -> fixed -> regressed, stable ids', () => {
  let d = recordPass(cfg, 'p', report(1, ['A', 'B']));
  assert.deepEqual(d.new.sort(), ['A', 'B']);
  d = recordPass(cfg, 'p', report(2, ['A']));
  assert.deepEqual(d.persisting, ['A']);
  assert.deepEqual(d.fixed, ['B']);
  d = recordPass(cfg, 'p', report(3, ['A', 'B']));
  assert.deepEqual(d.regressed, ['B']);
  const L = loadLedger(cfg, 'p');
  assert.equal(L.issues.B.status, 'regressed');
  assert.equal(L.passes.length, 3);
});

test('ledger: an issue that survives two repairs becomes stuck', () => {
  linkRepairs(cfg, 'p', ['A'], 'R1');
  linkRepairs(cfg, 'p', ['A'], 'R2');
  recordPass(cfg, 'p', report(4, ['A']));
  assert.equal(loadLedger(cfg, 'p').issues.A.status, 'stuck');
  assert.ok(ledgerSummary(cfg, 'p').status.stuck >= 1);
});

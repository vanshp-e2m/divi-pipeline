// WordPress round trip against the configured dev site (skipped when F2D_PROJECT is not set):
// draft creation, byte-exact readback, update without duplicates, snapshot rollback.
// Uses its own page key and deletes only the page it created.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config.mjs';
import * as WP from '../../src/wp/client.mjs';
import { tmpDir } from '../helpers.mjs';

const project = process.env.F2D_PROJECT;
const skip = !project && 'set F2D_PROJECT to a project with a dev site to run WordPress tests';
const KEY = `f2d-test-fixture-${process.pid}`;
let created = null;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

after(async () => {
  if (created) await WP.wp(loadConfig(project), ['post', 'delete', String(created), '--force'], { raw: true });
});

test('draft create -> readback -> update -> rollback', { skip }, async () => {
  const cfg = loadConfig(project);
  const dir = tmpDir('f2d-wp-');
  const write = (name, s) => (fs.writeFileSync(path.join(dir, name), s), path.join(dir, name));
  const v1 = '[et_pb_section module_class="f2d-test1"][et_pb_row][et_pb_column type="4_4"][et_pb_text]<p class="f2d-t">version one</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]';
  const v2 = v1.replace('version one', 'version two');
  const css = '.f2d-test1 { color: red; }';
  const d1 = await WP.deploy(cfg, { pageKey: KEY, title: 'f2d test fixture', contentFile: write('v1.txt', v1), cssFile: write('c.css', css), buildId: 'test-b1' });
  created = d1.post_id;
  assert.equal(d1.status, 'draft');
  assert.equal(d1.created, true);
  let rb = await WP.readback(cfg, { id: created });
  assert.equal(rb.content_sha, sha(v1), 'stored content is byte-identical');
  assert.equal(rb.use_builder, 'on');
  const d2 = await WP.deploy(cfg, { pageKey: KEY, title: 'f2d test fixture', contentFile: write('v2.txt', v2), cssFile: write('c.css', css), buildId: 'test-b2' });
  assert.equal(d2.post_id, created, 'same page key updates the same page (no duplicates)');
  assert.equal(d2.snapshots, 1);
  rb = await WP.readback(cfg, { id: created });
  assert.equal(rb.content_sha, sha(v2));
  await WP.rollback(cfg, { id: created, buildId: 'test-b1' });
  rb = await WP.readback(cfg, { id: created });
  assert.equal(rb.content_sha, sha(v1), 'rollback restores the snapshot');
  assert.equal(rb.build.build_id, 'test-b1');
  assert.equal(rb.status, 'draft', 'never published');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEV_OPTIONS, ensureDevOptions } from './dev-options.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-options-'));
}

test('ensureDevOptions creates options.json (and the directory) when absent', () => {
  const dir = path.join(tmpDir(), 'dev-data');
  assert.equal(ensureDevOptions(dir), true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'options.json'), 'utf-8'));
  assert.deepEqual(written, DEV_OPTIONS);
  assert.deepEqual(written, {
    setup_code: 'dev-setup-code',
    library_dir: 'scribe',
    log_level: 'debug',
  });
});

test('ensureDevOptions never overwrites an existing options.json', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'options.json');
  fs.writeFileSync(file, '{"setup_code":"mine"}');
  assert.equal(ensureDevOptions(dir), false);
  assert.equal(fs.readFileSync(file, 'utf-8'), '{"setup_code":"mine"}');
});

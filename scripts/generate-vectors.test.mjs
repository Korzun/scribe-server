import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { render, VECTORS_PATH } from './generate-vectors.mjs';

test('the committed vectors file equals a fresh generation', () => {
  assert.equal(readFileSync(VECTORS_PATH, 'utf8'), render());
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pruneProdDeps } from './prune-prod-deps.mjs';

function writePackage(dir, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

/** A hoisted install shaped like ours: one workspace, a few packages, one nested duplicate. */
function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const nm = path.join(root, 'node_modules');
  writePackage(root, { workspaces: ['app/server'] });
  writePackage(path.join(root, 'app/server'), {
    dependencies: { 'keep-me': '1' },
    optionalDependencies: { 'other-platform': '1' },
    devDependencies: { 'dev-only': '1' },
  });
  writePackage(path.join(nm, 'keep-me'), {
    dependencies: { transitive: '1', '@scope/needed': '1' },
    peerDependencies: { 'peer-only': '*', 'dev-only': '*' },
    peerDependenciesMeta: { 'peer-only': { optional: true }, 'dev-only': { optional: true } },
  });
  writePackage(path.join(nm, 'keep-me/node_modules/transitive'), { version: '2' });
  writePackage(path.join(nm, 'transitive'), { version: '1' });
  writePackage(path.join(nm, '@scope/needed'), {});
  writePackage(path.join(nm, '@scope/unused'), {});
  writePackage(path.join(nm, 'peer-only'), {});
  writePackage(path.join(nm, 'dev-only'), {});
  fs.mkdirSync(path.join(nm, '.bin'));
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');
  fs.symlinkSync('../app/server', path.join(nm, 'scribe-server'), 'dir');
  return { root, nm };
}

test('keeps what production dependencies reach and removes the rest', () => {
  const { root, nm } = fakeInstall();
  const { kept, removed } = pruneProdDeps(root, [path.join(root, 'app/server')]);

  assert.deepEqual(removed, ['@scope/unused', 'dev-only', 'peer-only', 'transitive']);
  assert.deepEqual(kept, ['@scope/needed', 'keep-me', 'keep-me/node_modules/transitive']);
  for (const name of removed) assert.equal(fs.existsSync(path.join(nm, name)), false, name);
  assert.equal(fs.existsSync(path.join(nm, '@scope/needed')), true);
  // The nested copy is what keep-me resolves, so the hoisted one is unused.
  assert.equal(fs.existsSync(path.join(nm, 'keep-me/node_modules/transitive')), true);
  // Dot entries and the workspace link are left alone.
  assert.equal(fs.existsSync(path.join(nm, '.bin')), true);
  assert.equal(fs.existsSync(path.join(nm, '.package-lock.json')), true);
  assert.equal(fs.lstatSync(path.join(nm, 'scribe-server')).isSymbolicLink(), true);
  // An empty scope directory goes too.
  assert.deepEqual(fs.readdirSync(path.join(nm, '@scope')), ['needed']);
});

test('dry run reports without deleting', () => {
  const { root, nm } = fakeInstall();
  const { removed } = pruneProdDeps(root, [path.join(root, 'app/server')], { dryRun: true });
  assert.deepEqual(removed, ['@scope/unused', 'dev-only', 'peer-only', 'transitive']);
  for (const name of removed) assert.equal(fs.existsSync(path.join(nm, name)), true, name);
});

test('a missing required dependency is an error, a missing optional one is not', () => {
  const { root, nm } = fakeInstall();
  pruneProdDeps(root, [path.join(root, 'app/server')]); // other-platform absent: fine
  fs.rmSync(path.join(nm, '@scope/needed'), { recursive: true });
  assert.throws(
    () => pruneProdDeps(root, [path.join(root, 'app/server')]),
    /@scope\/needed \(needed from node_modules\/keep-me\) is not installed/
  );
});

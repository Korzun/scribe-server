// Removes every installed package the production code cannot reach.
//
// `npm ci --omit=dev` keeps more than the runtime needs: a package that is an
// *optional peer* of a production dependency is installed whenever the lockfile
// knows it, even though nothing requires it at runtime. For this repo that is
// `@prisma/client` → `prisma` (the CLI, with its own dev server, MySQL and
// Postgres drivers and the Rust engines) and → `typescript` (whose 7.x compiler
// is a Go binary). None of it runs in the container, all of it is scanned.
//
// This walks the real dependency graph instead: from each workspace's
// `dependencies` and `optionalDependencies`, following only those two fields
// (never `peerDependencies`), resolving names the way Node does (nearest
// `node_modules` walking up). Whatever is left under the root `node_modules`
// is deleted. Workspace links and dot entries (`.bin`, `.package-lock.json`)
// are left alone.
//
// The Dockerfile runs it in the prod-deps stage; CI's smoke test asserts the
// result and boots the image.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackage(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
}

/** Nearest `node_modules/<name>` walking up from `fromDir`, stopping at `rootDir`. */
function resolvePackage(name, fromDir, rootDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (dir === rootDir) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} rootDir the directory holding the root `node_modules`
 * @param {string[]} workspaceDirs directories whose production dependencies are the roots
 * @param {{dryRun?: boolean}} [options]
 * @returns {{kept: string[], removed: string[]}} package names, sorted
 */
export function pruneProdDeps(rootDir, workspaceDirs, { dryRun = false } = {}) {
  rootDir = fs.realpathSync(rootDir);
  const kept = new Set();
  const pending = [];

  // A dependency reached only through an optional one is itself optional: npm
  // skipped the whole subtree if it skipped the parent.
  const enqueue = (pkg, fromDir, { optional }) => {
    for (const name of Object.keys(pkg.dependencies ?? {}))
      pending.push({ name, fromDir, optional });
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      pending.push({ name, fromDir, optional: true });
    }
  };

  for (const ws of workspaceDirs) {
    const dir = fs.realpathSync(ws);
    kept.add(dir);
    enqueue(readPackage(dir), dir, { optional: false });
  }

  while (pending.length > 0) {
    const { name, fromDir, optional } = pending.pop();
    const dir = resolvePackage(name, fromDir, rootDir);
    if (dir === null) {
      if (optional) continue; // platform-filtered or otherwise skipped by npm
      throw new Error(
        `${name} (needed from ${path.relative(rootDir, fromDir) || '.'}) is not installed`
      );
    }
    if (kept.has(dir)) continue;
    kept.add(dir);
    enqueue(readPackage(dir), dir, { optional });
  }

  const nodeModules = path.join(rootDir, 'node_modules');
  const removed = [];
  const consider = (entryDir, name) => {
    let real;
    try {
      real = fs.realpathSync(entryDir);
    } catch {
      return; // dangling link; nothing to keep
    }
    if (!real.startsWith(nodeModules + path.sep)) return; // workspace link
    if (kept.has(real)) return;
    removed.push(name);
    if (!dryRun) fs.rmSync(entryDir, { recursive: true, force: true });
  };

  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const entryDir = path.join(nodeModules, entry);
    if (entry.startsWith('@')) {
      for (const child of fs.readdirSync(entryDir))
        consider(path.join(entryDir, child), `${entry}/${child}`);
      if (!dryRun && fs.readdirSync(entryDir).length === 0) fs.rmdirSync(entryDir);
      continue;
    }
    consider(entryDir, entry);
  }

  const keptNames = [...kept]
    .filter((dir) => dir.startsWith(nodeModules + path.sep))
    .map((dir) => path.relative(nodeModules, dir).split(path.sep).join('/'));
  return { kept: keptNames.sort(), removed: removed.sort() };
}

// Usage: node scripts/prune-prod-deps.mjs [rootDir] [--dry-run] [--workspace <dir>]...
// Without --workspace, every workspace in the root package.json is a root. The
// image passes only app/server: the client is served as built static files, so
// its React dependencies have nothing to do at runtime.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const workspaces = args.flatMap((arg, i) => (arg === '--workspace' ? [args[i + 1]] : []));
  const positional = args.filter(
    (arg, i) => !arg.startsWith('--') && args[i - 1] !== '--workspace'
  );
  const rootDir = path.resolve(positional[0] ?? '.');
  const rootPackage = readPackage(rootDir);
  const roots = workspaces.length > 0 ? workspaces : (rootPackage.workspaces ?? []);
  const workspaceDirs = roots.map((ws) => path.join(rootDir, ws));
  const { kept, removed } = pruneProdDeps(rootDir, workspaceDirs, { dryRun });
  console.log(
    `${dryRun ? 'would remove' : 'removed'} ${removed.length} packages, kept ${kept.length}`
  );
  for (const name of removed) console.log(`  - ${name}`);
}

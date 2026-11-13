import * as fs from 'fs';
import * as path from 'path';

/**
 * The container starts as root for exactly one reason: whatever is mounted at
 * the data and blob directories (a Docker named volume, a host bind mount,
 * Home Assistant's root-owned `data` and `media` shares) must become writable
 * by the unprivileged user the vault runs as. Root takes ownership and then
 * the process drops itself to that user before it opens a single file.
 * Started with `--user`, the process is not root, nothing is touched, and it
 * runs as whatever uid it was given.
 *
 * Ownership is taken in two ways:
 * - A directory not yet owned by the vault's user is taken over recursively,
 *   once: a volume that an earlier version wrote as root (the database, the
 *   blob shards, in-flight upload parts) would otherwise open read-only. A
 *   directory already ours is left alone, so steady-state boots walk nothing.
 * - A listed file is chowned on every boot when it exists, whoever owns it.
 *   Home Assistant's Supervisor rewrites `options.json` as root with mode
 *   0600 on every start, and the setup code is read from it live, after the
 *   drop. Without this the add-on could never create or reset a library.
 *
 * It lives in the server rather than in `run.sh` because only the server
 * knows the resolved blob path when it comes from the add-on's `options.json`.
 */

/** The image's `node` user. */
export const VAULT_UID = 1000;
export const VAULT_GID = 1000;

export type PrivilegeOps = {
  getuid: () => number;
  /** Recursive, like `mkdir -p`. */
  mkdirSync: (dir: string) => void;
  /** The owner's uid, or `null` when the path does not exist. */
  ownerOf: (p: string) => number | null;
  chownSync: (p: string, uid: number, gid: number) => void;
  chownRecursiveSync: (dir: string, uid: number, gid: number) => void;
  setgid: (gid: number) => void;
  setuid: (uid: number) => void;
};

export type PrivilegeTargets = {
  /** Created if missing; taken over recursively when not already ours. */
  dirs: string[];
  /** Chowned on every boot when present. */
  files: string[];
};

/**
 * Returns true when privileges were dropped, false when the process was not
 * root (and nothing was done). A chown that fails throws: a mount the vault
 * cannot own would only fail later, less clearly, on the first write.
 */
export function dropPrivileges({ dirs, files }: PrivilegeTargets, ops: PrivilegeOps): boolean {
  if (ops.getuid() !== 0) return false;
  for (const dir of dirs) {
    ops.mkdirSync(dir);
    if (ops.ownerOf(dir) !== VAULT_UID) ops.chownRecursiveSync(dir, VAULT_UID, VAULT_GID);
  }
  for (const file of files) {
    if (ops.ownerOf(file) !== null) ops.chownSync(file, VAULT_UID, VAULT_GID);
  }
  // gid first: once the uid is unprivileged, setgid is no longer allowed.
  ops.setgid(VAULT_GID);
  ops.setuid(VAULT_UID);
  return true;
}

/** Depth-first chown of a tree. Symlinks are re-owned themselves, never followed. */
function chownTree(dir: string, uid: number, gid: number): void {
  fs.lchownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) chownTree(p, uid, gid);
    else fs.lchownSync(p, uid, gid);
  }
}

/** The real operations, or `null` on a platform without uids (Windows). */
export function defaultPrivilegeOps(): PrivilegeOps | null {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.setuid !== 'function' ||
    typeof process.setgid !== 'function'
  ) {
    return null;
  }
  return {
    getuid: () => process.getuid!(),
    mkdirSync: (dir) => void fs.mkdirSync(dir, { recursive: true }),
    ownerOf: (p) => {
      try {
        return fs.lstatSync(p).uid;
      } catch {
        return null;
      }
    },
    chownSync: (p, uid, gid) => fs.lchownSync(p, uid, gid),
    chownRecursiveSync: chownTree,
    setgid: (gid) => process.setgid!(gid),
    setuid: (uid) => process.setuid!(uid),
  };
}

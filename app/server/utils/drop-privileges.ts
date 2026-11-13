import * as fs from 'fs';

/**
 * The container starts as root for exactly one reason: whatever is mounted at
 * the data and blob directories (a Docker named volume, a host bind mount,
 * Home Assistant's root-owned `data` and `media` shares) must become writable
 * by the unprivileged user the vault runs as. Root creates and takes
 * ownership of those two directories, nothing inside them, and then the
 * process drops itself to that user before it opens a single file. Started
 * with `--user`, the process is not root, nothing is touched, and it runs as
 * whatever uid it was given.
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
  chownSync: (dir: string, uid: number, gid: number) => void;
  setgid: (gid: number) => void;
  setuid: (uid: number) => void;
};

/**
 * Returns true when privileges were dropped, false when the process was not
 * root (and nothing was done). A chown that fails throws: a mount the vault
 * cannot own would only fail later, less clearly, on the first write.
 */
export function dropPrivileges(dirs: string[], ops: PrivilegeOps): boolean {
  if (ops.getuid() !== 0) return false;
  for (const dir of dirs) {
    ops.mkdirSync(dir);
    ops.chownSync(dir, VAULT_UID, VAULT_GID);
  }
  // gid first: once the uid is unprivileged, setgid is no longer allowed.
  ops.setgid(VAULT_GID);
  ops.setuid(VAULT_UID);
  return true;
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
    chownSync: (dir, uid, gid) => fs.chownSync(dir, uid, gid),
    setgid: (gid) => process.setgid!(gid),
    setuid: (uid) => process.setuid!(uid),
  };
}

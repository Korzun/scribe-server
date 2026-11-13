import { describe, expect, it } from 'vitest';

import { dropPrivileges, VAULT_GID, VAULT_UID, type PrivilegeOps } from './drop-privileges';

type Fake = PrivilegeOps & { calls: string[] };

/** `owners` maps a path to its current uid; a path not listed does not exist. */
const fakeOps = (uid: number, owners: Record<string, number> = {}): Fake => {
  const calls: string[] = [];
  return {
    calls,
    getuid: () => uid,
    mkdirSync: (dir) => void calls.push(`mkdir ${dir}`),
    ownerOf: (p) => owners[p] ?? null,
    chownSync: (p, u, g) => void calls.push(`chown ${p} ${u}:${g}`),
    chownRecursiveSync: (dir, u, g) => void calls.push(`chown -R ${dir} ${u}:${g}`),
    setgid: (g) => void calls.push(`setgid ${g}`),
    setuid: (u) => void calls.push(`setuid ${u}`),
  };
};

describe('dropPrivileges', () => {
  it('as root: creates each directory, takes it over recursively when it is not ours, then sets gid before uid', () => {
    const ops = fakeOps(0, { '/data': 0, '/data/blobs': 0 });

    expect(dropPrivileges({ dirs: ['/data', '/data/blobs'], files: [] }, ops)).toBe(true);

    expect(ops.calls).toEqual([
      'mkdir /data',
      `chown -R /data ${VAULT_UID}:${VAULT_GID}`,
      'mkdir /data/blobs',
      `chown -R /data/blobs ${VAULT_UID}:${VAULT_GID}`,
      `setgid ${VAULT_GID}`,
      `setuid ${VAULT_UID}`,
    ]);
  });

  it('a directory already ours is left alone (no recursive walk on every boot)', () => {
    const ops = fakeOps(0, { '/data': VAULT_UID, '/data/blobs': VAULT_UID });

    dropPrivileges({ dirs: ['/data', '/data/blobs'], files: [] }, ops);

    expect(ops.calls).toEqual([
      'mkdir /data',
      'mkdir /data/blobs',
      `setgid ${VAULT_GID}`,
      `setuid ${VAULT_UID}`,
    ]);
  });

  it('a listed file is chowned every boot when it exists, whoever owns it (the Supervisor rewrites options.json as root 0600)', () => {
    const ops = fakeOps(0, {
      '/data': VAULT_UID,
      '/data/options.json': 0,
      '/data/db.sqlite': VAULT_UID,
    });

    dropPrivileges(
      { dirs: ['/data'], files: ['/data/options.json', '/data/db.sqlite', '/data/missing'] },
      ops
    );

    expect(ops.calls).toEqual([
      'mkdir /data',
      `chown /data/options.json ${VAULT_UID}:${VAULT_GID}`,
      `chown /data/db.sqlite ${VAULT_UID}:${VAULT_GID}`,
      `setgid ${VAULT_GID}`,
      `setuid ${VAULT_UID}`,
    ]);
  });

  it('not root: touches nothing and returns false', () => {
    const ops = fakeOps(1000, { '/data': 0 });

    expect(dropPrivileges({ dirs: ['/data'], files: ['/data/options.json'] }, ops)).toBe(false);

    expect(ops.calls).toEqual([]);
  });

  it('a chown failure propagates (a mount the vault cannot own is a real error)', () => {
    const ops = fakeOps(0, { '/data': 0 });
    ops.chownRecursiveSync = () => {
      throw new Error('EPERM');
    };

    expect(() => dropPrivileges({ dirs: ['/data'], files: [] }, ops)).toThrow('EPERM');
  });
});

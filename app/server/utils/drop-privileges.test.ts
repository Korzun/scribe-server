import { describe, expect, it } from 'vitest';

import { dropPrivileges, VAULT_GID, VAULT_UID, type PrivilegeOps } from './drop-privileges';

const fakeOps = (uid: number): PrivilegeOps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    getuid: () => uid,
    mkdirSync: (dir) => void calls.push(`mkdir ${dir}`),
    chownSync: (dir, u, g) => void calls.push(`chown ${dir} ${u}:${g}`),
    setgid: (g) => void calls.push(`setgid ${g}`),
    setuid: (u) => void calls.push(`setuid ${u}`),
  };
};

describe('dropPrivileges', () => {
  it('as root: creates and chowns each directory, then sets gid before uid', () => {
    const ops = fakeOps(0);

    expect(dropPrivileges(['/data', '/data/blobs'], ops)).toBe(true);

    expect(ops.calls).toEqual([
      'mkdir /data',
      `chown /data ${VAULT_UID}:${VAULT_GID}`,
      'mkdir /data/blobs',
      `chown /data/blobs ${VAULT_UID}:${VAULT_GID}`,
      `setgid ${VAULT_GID}`,
      `setuid ${VAULT_UID}`,
    ]);
  });

  it('not root: touches nothing and returns false', () => {
    const ops = fakeOps(1000);

    expect(dropPrivileges(['/data'], ops)).toBe(false);

    expect(ops.calls).toEqual([]);
  });

  it('a chown failure propagates (a mount the vault cannot own is a real error)', () => {
    const ops = fakeOps(0);
    ops.chownSync = () => {
      throw new Error('EPERM');
    };

    expect(() => dropPrivileges(['/data'], ops)).toThrow('EPERM');
  });
});

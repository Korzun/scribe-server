import { describe, expect, it } from 'vitest';

import { currentEpoch, VaultResetError, withVaultReset, withVaultWriter } from './vault-gate';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('vault gate', () => {
  it('writers share the gate; a reset waits for them, and later writers wait for it', async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const a = withVaultWriter(undefined, async () => {
      events.push('a start');
      await new Promise<void>((resolve) => (releaseA = resolve));
      events.push('a end');
    });
    const b = withVaultWriter(undefined, async () => {
      events.push('b');
    });
    await tick();
    const reset = withVaultReset(async () => {
      events.push('reset');
    });
    const c = withVaultWriter(undefined, async () => {
      events.push('c');
    });
    await tick();
    expect(events).toEqual(['a start', 'b']);

    releaseA();
    await Promise.all([a, b, reset, c]);
    expect(events).toEqual(['a start', 'b', 'a end', 'reset', 'c']);
  });

  it('a writer holding an epoch from before a reset is refused; a fresh one runs', async () => {
    const before = currentEpoch();
    await withVaultReset(async () => undefined);
    expect(currentEpoch()).toBeGreaterThan(before);

    let ran = false;
    await expect(
      withVaultWriter(before, async () => {
        ran = true;
      })
    ).rejects.toBeInstanceOf(VaultResetError);
    expect(ran).toBe(false);
    await expect(withVaultWriter(currentEpoch(), async () => 'ok')).resolves.toBe('ok');
  });

  it('a failing holder releases the gate', async () => {
    await expect(withVaultWriter(undefined, () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x'
    );
    await expect(withVaultReset(() => Promise.reject(new Error('y')))).rejects.toThrow('y');
    await expect(withVaultWriter(currentEpoch(), async () => 1)).resolves.toBe(1);
  });
});

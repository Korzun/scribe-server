import { describe, expect, it } from 'vitest';

import {
  currentEpoch,
  initEpoch,
  VaultResetError,
  withVaultReset,
  withVaultWriter,
} from './vault-gate';

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
  it('starts from the epoch it is given, and refuses a nonsense one', () => {
    initEpoch(7);
    expect(currentEpoch()).toBe(7);
    expect(() => initEpoch(-1)).toThrow();
    expect(() => initEpoch(1.5)).toThrow();
    expect(currentEpoch()).toBe(7);
  });

  it('a reset persists the next epoch before the in-memory one moves, and moves it even if persisting fails', async () => {
    initEpoch(3);
    const seen: Array<{ next: number; current: number }> = [];
    await withVaultReset(
      async () => undefined,
      async (next) => {
        seen.push({ next, current: currentEpoch() });
      }
    );
    expect(seen).toEqual([{ next: 4, current: 3 }]);
    expect(currentEpoch()).toBe(4);

    await expect(
      withVaultReset(
        async () => undefined,
        () => Promise.reject(new Error('disk full'))
      )
    ).rejects.toThrow('disk full');
    expect(currentEpoch()).toBe(5);
    await expect(withVaultWriter(4, async () => 1)).rejects.toBeInstanceOf(VaultResetError);
    await expect(withVaultWriter(5, async () => 1)).resolves.toBe(1);
  });
});

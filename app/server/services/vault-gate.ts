/**
 * The vault-wide gate between the keys-lost reset (spec §9) and everything
 * that writes library data.
 *
 * The reset wipes every library table in one transaction, but a write that
 * passed its checks before the wipe could still commit after it: a blob
 * whose change row every new Mac would page and fail to decrypt (its AAD
 * binds the old library id), a phantom meeting in the new library's counts,
 * a refresh token for a library that no longer exists. No foreign key stops
 * that, since `blobs` and `changes` reference nothing.
 *
 * So writers (blob writes and deletes, meeting tombstones, token issuance,
 * library creation, the collector) hold the gate SHARED for the whole of
 * their read-check-write, and the reset holds it EXCLUSIVE. The queue is
 * first-come-first-served, so a reset waits for the writers already inside
 * and every writer that arrives after it waits for the reset.
 *
 * Waiting is not enough on its own: a request authenticated against the old
 * library may only reach its write after the reset, or after a new library
 * exists (a long body upload). Every completed reset bumps the epoch;
 * `ownerAuth` and sign-in record the epoch they started in, and a writer that
 * presents an older one is refused with `VaultResetError` (a 401) before it
 * touches anything. Callers with no request behind them pass `undefined`.
 *
 * Lock order: the gate is always taken first, before any `keyed-lock` key.
 * In-process is enough, for the same reason as keyed-lock.ts: one process.
 */

/** The request's credential predates a keys-lost reset; it belongs to a library that no longer exists. */
export class VaultResetError extends Error {
  constructor() {
    super('The library was reset');
    this.name = 'VaultResetError';
  }
}

type Waiter = { exclusive: boolean; enter: () => void };

let epoch = 0;
let readers = 0;
let writer = false;
const queue: Waiter[] = [];

function admit(): void {
  while (queue.length > 0) {
    const next = queue[0]!;
    if (next.exclusive) {
      if (readers > 0 || writer) return;
      queue.shift();
      writer = true;
      next.enter();
      return;
    }
    if (writer) return;
    queue.shift();
    readers += 1;
    next.enter();
  }
}

function acquire(exclusive: boolean): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ exclusive, enter: resolve });
    admit();
  });
}

function release(exclusive: boolean): void {
  if (exclusive) writer = false;
  else readers -= 1;
  admit();
}

/** The current reset epoch; record it when a request authenticates. */
export function currentEpoch(): number {
  return epoch;
}

/**
 * Runs `fn` holding the gate shared. When `expectedEpoch` is given and a reset
 * has completed since it was recorded, rejects with `VaultResetError` without
 * running `fn`.
 */
export async function withVaultWriter<T>(
  expectedEpoch: number | undefined,
  fn: () => Promise<T>
): Promise<T> {
  await acquire(false);
  try {
    if (expectedEpoch !== undefined && expectedEpoch !== epoch) throw new VaultResetError();
    return await fn();
  } finally {
    release(false);
  }
}

/** Runs `fn` (the reset) holding the gate exclusive, and bumps the epoch when it ends, however it ends. */
export async function withVaultReset<T>(fn: () => Promise<T>): Promise<T> {
  await acquire(true);
  try {
    return await fn();
  } finally {
    epoch += 1;
    release(true);
  }
}

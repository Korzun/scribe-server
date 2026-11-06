/**
 * In-process mutual exclusion per key.
 *
 * A blob write is read-check-write: read the current revision, compare it to
 * the caller's `If-Match`, store the file, commit the new row (spec §6). Each
 * step awaits, and between any two of them another request for the same blob
 * could run its own read and pass the same check, so both would "win" and one
 * Mac's change would vanish without a 409. Holding this lock across the whole
 * sequence makes it atomic.
 *
 * In-process is enough: the vault is one Node process, and SQLite serialises
 * writes on its own anyway. The lock is not there to protect the database; it
 * is there to make the check and the write one step across the `await`s.
 *
 * Each key holds a promise chain: a caller waits for the previous tail, then
 * runs. A failing `fn` rejects only its own caller; the chain carries on. The
 * entry is dropped once the last waiter finishes, so idle keys cost nothing.
 */
const tails = new Map<string, Promise<void>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

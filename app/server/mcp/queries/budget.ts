/**
 * The cap on how much any one tool result may return, as `ResponseBudget` in
 * Scribe. The number itself is a judgement, but the behaviour around it is
 * not: a result that is cut must say so. An agent handed half a meeting with
 * no indication will summarize half a meeting and report it as the whole
 * thing, confidently and wrongly.
 */

export const MAX_CHARACTERS = 25_000;

/**
 * The one encoding every query uses, so what the budget measures is what a
 * client receives: compact JSON with sorted keys, `undefined` fields omitted,
 * and forward slashes escaped as Foundation's encoder escapes them, so the
 * two doors measure the same bytes for the same payload.
 */
export function encodePayload(value: unknown): string {
  return JSON.stringify(sortKeys(value)).replace(/\//g, '\\/');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * The longest prefix of `items` that encodes within the budget.
 *
 * A prefix rather than a subset: every caller's ordering is meaningful, so
 * dropping from the end is the only cut that leaves a resumable boundary.
 * `overhead` is the caller's own wrapper fields, charged against the same
 * budget so a payload's envelope cannot push the whole past the cap.
 */
export function fit<T>(items: readonly T[], overhead: number): { kept: T[]; truncated: boolean } {
  const allowance = MAX_CHARACTERS - overhead;
  const kept: T[] = [];
  // Two characters for the enclosing brackets; one more per separating comma.
  let used = 2;
  for (const item of items) {
    const size = Buffer.byteLength(encodePayload(item), 'utf8') + (kept.length === 0 ? 0 : 1);
    if (used + size > allowance && kept.length > 0) return { kept, truncated: true };
    kept.push(item);
    used += size;
  }
  // One item that cannot fit alone still comes back: an empty result would
  // read as "this meeting has nothing in it".
  return { kept, truncated: used > allowance };
}

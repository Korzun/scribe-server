/**
 * Token-level fuzzy matching for search over ASR output: a port of Scribe's
 * `FuzzyMatch`. The corpus is speech recognition output, and ASR mangles
 * exactly the words people search for. "evals" has arrived as "evalves",
 * "evils" and "emails"; "QLoRA" as "cue lura". So search matches loosely and
 * marks each hit with what actually matched, leaving the judgement to a
 * reader who can see the evidence. Pure functions over strings.
 */

/** Letters, marks and numbers: Foundation's `CharacterSet.alphanumerics`. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu;

/**
 * Whitespace-separated words with punctuation shed from the edges but kept
 * inside, so "don't" survives while "plan," meets "plan". Case is kept: these
 * tokens are also what a matched span is quoted from.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((word) => word.replace(EDGE_PUNCTUATION, ''))
    .filter((word) => word !== '');
}

/**
 * A simplified consonant skeleton: c/q/ck→k, ph→f, z→s, x→ks, gh→g; a leading
 * vowel is kept and the rest dropped; doubled letters collapse. "qlora" →
 * "klr", and so does "cuelura".
 */
export function phoneticKey(token: string): string {
  const chars = Array.from(token.toLowerCase());
  const mapped: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const pair = i + 1 < chars.length ? chars[i]! + chars[i + 1]! : '';
    switch (pair) {
      case 'ph':
        mapped.push('f');
        i += 2;
        continue;
      case 'gh':
        mapped.push('g');
        i += 2;
        continue;
      case 'ck':
        mapped.push('k');
        i += 2;
        continue;
      default:
        break;
    }
    const c = chars[i]!;
    if (c === 'c' || c === 'q') mapped.push('k');
    else if (c === 'z') mapped.push('s');
    else if (c === 'x') mapped.push('k', 's');
    else mapped.push(c);
    i += 1;
  }
  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  const key: string[] = [];
  mapped.forEach((c, index) => {
    if (index > 0 && vowels.has(c)) return;
    if (key[key.length - 1] === c) return;
    key.push(c);
  });
  return key.join('');
}

/** How far apart two tokens may be and still count as one word misheard. */
export function maxEditDistance(length: number): number {
  if (length < 4) return 0;
  if (length <= 5) return 1;
  return 2;
}

/** Plain Levenshtein over code points. Tokens are words, so the table is tiny. */
export function editDistance(a: string, b: string): number {
  const as = Array.from(a);
  const bs = Array.from(b);
  if (as.length === 0 || bs.length === 0) return Math.max(as.length, bs.length);
  let previous = Array.from({ length: bs.length + 1 }, (_, j) => j);
  as.forEach((ca, i) => {
    const row = [i + 1];
    bs.forEach((cb, j) => {
      row.push(Math.min(previous[j + 1]! + 1, row[j]! + 1, previous[j]! + (ca === cb ? 0 : 1)));
    });
    previous = row;
  });
  return previous[bs.length]!;
}

/** One utterance, tokenized once: everything derivable from the text alone. */
export class FuzzyUtterance {
  /** As spoken: punctuation shed, case kept, so a matched span can be quoted verbatim. */
  readonly display: string[];
  readonly lowered: string[];
  readonly keys: string[];
  /** Keys of adjacent pairs, for the mishearing that splits one word into two. */
  readonly pairKeys: string[];

  constructor(text: string) {
    this.display = tokenize(text);
    this.lowered = this.display.map((w) => w.toLowerCase());
    this.keys = this.lowered.map(phoneticKey);
    this.pairKeys = this.lowered.slice(0, -1).map((w, i) => phoneticKey(w + this.lowered[i + 1]!));
  }
}

export type FuzzyHit = {
  /** The run of utterance tokens the whole query aligned against: [start, end). */
  start: number;
  end: number;
  /** True only when every query token matched its counterpart verbatim. */
  exact: boolean;
};

/** One query, tokenized once per search. */
export class FuzzyQuery {
  readonly tokens: string[];
  readonly keys: string[];

  constructor(text: string) {
    this.tokens = tokenize(text).map((w) => w.toLowerCase());
    this.keys = this.tokens.map(phoneticKey);
  }

  /**
   * The first run of utterance tokens the whole query aligns against, or
   * null. First rather than best, left to right, because the caller's cursor
   * is a count into a deterministic scan.
   */
  match(utterance: FuzzyUtterance): FuzzyHit | null {
    if (this.tokens.length === 0) return null;
    for (let start = 0; start < utterance.lowered.length; start++) {
      const aligned = this.align(0, start, utterance, true);
      if (aligned !== null) return { start, end: aligned.end, exact: aligned.exact };
    }
    return null;
  }

  /**
   * Aligns tokens[qi...] against utterance tokens from `ui`, trying each rule
   * in a fixed order (exact, edit distance, phonetic, phonetic over a joined
   * pair) and recursing so a later query token can reject an earlier rule's
   * choice.
   */
  private align(
    qi: number,
    ui: number,
    u: FuzzyUtterance,
    exact: boolean
  ): { end: number; exact: boolean } | null {
    if (qi >= this.tokens.length) return { end: ui, exact };
    if (ui >= u.lowered.length) return null;
    const q = this.tokens[qi]!;
    const word = u.lowered[ui]!;

    if (q === word) {
      const rest = this.align(qi + 1, ui + 1, u, exact);
      if (rest !== null) return rest;
    }

    // Both tokens must clear the length floor: three letters carry too little
    // signal to fuzz on from either side.
    const qLength = Array.from(q).length;
    const wordLength = Array.from(word).length;
    const fuzzable = q !== word && Math.min(qLength, wordLength) > 3;

    if (fuzzable && editDistance(q, word) <= maxEditDistance(Math.max(qLength, wordLength))) {
      const rest = this.align(qi + 1, ui + 1, u, false);
      if (rest !== null) return rest;
    }

    if (fuzzable && this.keys[qi] === u.keys[ui]) {
      const rest = this.align(qi + 1, ui + 1, u, false);
      if (rest !== null) return rest;
    }

    if (qLength > 3 && ui < u.pairKeys.length && this.keys[qi] === u.pairKeys[ui]) {
      const rest = this.align(qi + 1, ui + 2, u, false);
      if (rest !== null) return rest;
    }

    return null;
  }
}

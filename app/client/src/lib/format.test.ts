import { describe, expect, it } from 'vitest';

import { formatBytes, formatRelative } from './format';

describe('formatBytes', () => {
  it('prints whole bytes below 1 KB and one decimal above', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });
});

describe('formatRelative', () => {
  const now = 10_000_000_000;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ago = (ms: number) => formatRelative(now - ms, now);

  it('says never for null', () => {
    expect(formatRelative(null, now)).toBe('never');
  });

  it('crosses each boundary at the documented threshold', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59 * SEC)).toBe('just now');
    expect(ago(60 * SEC)).toBe('1 minute ago');
    expect(ago(5 * MIN)).toBe('5 minutes ago');
    expect(ago(59 * MIN)).toBe('59 minutes ago');
    expect(ago(60 * MIN)).toBe('1 hour ago');
    expect(ago(3 * HOUR)).toBe('3 hours ago');
    expect(ago(23 * HOUR)).toBe('23 hours ago');
    expect(ago(24 * HOUR)).toBe('1 day ago');
    expect(ago(2 * DAY)).toBe('2 days ago');
    expect(ago(6 * DAY)).toBe('6 days ago');
    expect(ago(7 * DAY)).toBe(new Date(now - 7 * DAY).toLocaleDateString());
  });

  it('treats a future timestamp as just now', () => {
    expect(formatRelative(now + 5 * MIN, now)).toBe('just now');
  });
});

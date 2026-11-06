const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Binary (1024) steps; whole bytes below 1 KB, one decimal above. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
};

const ago = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;

/** `now` is passed in so callers and tests agree on the clock. */
export const formatRelative = (ms: number | null, now: number): string => {
  if (ms === null) return 'never';
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ago(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return ago(days, 'day');
  return new Date(ms).toLocaleDateString();
};

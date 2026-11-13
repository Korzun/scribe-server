import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  list: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${theme.space.sm} ${theme.space.lg}`,
    margin: 0,
    padding: theme.space.md,
    fontSize: theme.fontSize.md,
    color: theme.color.text.primary,
    '& dt': { color: theme.color.text.faint },
    '& dd': { margin: 0, fontWeight: theme.fontWeight.semibold },
  },
  recent: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.lg,
    padding: theme.space.md,
  },
  meeting: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.color.text.secondary,
  },
  outcome: {
    fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.primary,
  },
  failed: { color: theme.color.danger.default },
  meta: { fontSize: theme.fontSize.sm, color: theme.color.text.faint },
}));

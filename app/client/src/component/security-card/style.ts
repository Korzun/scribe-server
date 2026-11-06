import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.space.lg,
    padding: theme.space.md,
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.xs,
    minWidth: 0,
  },
  label: {
    fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.primary,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.color.text.faint,
  },
  key: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.color.text.secondary,
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.space.md,
  },
}));

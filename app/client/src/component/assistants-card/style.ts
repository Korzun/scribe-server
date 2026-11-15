import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  list: {
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
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.xs,
    minWidth: 0,
  },
  name: {
    fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.primary,
    overflowWrap: 'anywhere',
  },
  meta: { fontSize: theme.fontSize.sm, color: theme.color.text.faint },
}));

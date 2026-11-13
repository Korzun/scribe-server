import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  // The one shared "nothing here" block, so pages never grow their own copies.
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `4rem ${theme.space.xxl}`, // 4rem is empty-state vertical padding
    gap: theme.space.md,
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.muted,
    '&$danger': { color: theme.color.danger.default },
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.color.text.faint,
    textAlign: 'center',
  },
  danger: {},
}));

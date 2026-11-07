import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    minHeight: '100vh',
    backgroundColor: theme.color.bg.page,
    padding: `0 ${theme.space.xxl}`,
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.xxl,
    maxWidth: '480px',
    [theme.breakpoint.mobile]: {
      width: '100%',
    },
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.lg,
  },
  explain: {
    margin: 0,
    fontSize: theme.fontSize.md,
    color: theme.color.text.secondary,
  },
  hint: {
    margin: 0,
    fontSize: theme.fontSize.sm,
    color: theme.color.text.muted,
  },
  confirm: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
  },
}));

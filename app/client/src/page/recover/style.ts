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
  form: {
    display: 'flex',
    flexDirection: 'column',
  },
  explain: {
    margin: `0 0 ${theme.space.xl}`,
    fontSize: theme.fontSize.md,
    color: theme.color.text.secondary,
  },
  inputContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
    marginBottom: theme.space.xxl,
    minWidth: '400px',
    [theme.breakpoint.mobile]: {
      minWidth: 'auto',
    },
  },
  error: {
    color: theme.color.danger.default,
    fontSize: theme.fontSize.sm,
  },
}));

import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    minHeight: '100vh',
    backgroundColor: theme.color.bg.page,
    padding: `${theme.space.xxl} ${theme.space.xxl}`,
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
  kitLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.color.text.secondary,
    marginBottom: theme.space.xs,
  },
  // The one place the Secret Key is shown in full: monospace, wrapping, selectable.
  secretKey: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: theme.fontSize.lg,
    letterSpacing: '0.04em',
    overflowWrap: 'anywhere',
    userSelect: 'all',
    marginBottom: theme.space.xl,
  },
  codes: {
    listStyle: 'none',
    margin: `0 0 ${theme.space.xl}`,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: theme.space.sm,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: theme.fontSize.md,
    userSelect: 'all',
    [theme.breakpoint.mobile]: {
      gridTemplateColumns: '1fr',
    },
  },
  actions: {
    display: 'flex',
    gap: theme.space.md,
    marginBottom: theme.space.xl,
  },
  saved: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.space.md,
    marginBottom: theme.space.xl,
    fontSize: theme.fontSize.md,
    cursor: 'pointer',
    '& input': {
      marginTop: '3px',
    },
  },
}));

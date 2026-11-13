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
    [theme.breakpoint.mobile]: {
      padding: `0 ${theme.space.xxl}`,
    },
  },
  // Holds the card and the secondary buttons below it. The root centres its
  // children, so this column shrink-wraps to the card's own width and the
  // stretched buttons beneath it land exactly card-wide.
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.xxl,
    [theme.breakpoint.mobile]: {
      width: '100%',
    },
  },
  // A native <button> shrink-wraps its content even at `display: flex`, unlike
  // the div the Button renders outside submit mode. Making the form a column
  // stretches the Sign In button back across the card, matching the fields.
  form: {
    display: 'flex',
    flexDirection: 'column',
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
  links: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
}));

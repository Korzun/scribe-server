import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
  },
  error: {
    color: theme.color.danger.default,
    fontSize: theme.fontSize.sm,
  },
}));

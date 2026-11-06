import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  body: {
    fontSize: theme.fontSize.md,
    color: theme.color.text.muted,
  },
}));

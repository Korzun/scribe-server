import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  list: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: `${theme.space.md} ${theme.space.xxl}`,
    margin: 0,
    fontSize: theme.fontSize.md,
    '& dt': { color: theme.color.text.muted },
    '& dd': { margin: 0, color: theme.color.text.primary },
  },
  purge: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.lg,
  },
}));

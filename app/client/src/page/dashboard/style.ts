import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: theme.space.lg,
  },
  heading: {
    margin: 0,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.primary,
  },
  stack: { display: 'flex', flexDirection: 'column', gap: theme.space.xl },
}));

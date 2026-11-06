import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  list: { display: 'flex', flexDirection: 'column', gap: theme.space.sm },
}));

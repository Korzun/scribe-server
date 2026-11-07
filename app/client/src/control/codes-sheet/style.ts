import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  root: {
    ...theme.recipe.modal.dialog,
    backgroundColor: theme.color.bg.card,
  },
  header: {
    ...theme.recipe.modal.header,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.lg,
    paddingLeft: theme.space.xxl,
    paddingRight: theme.space.xxl,
    paddingBottom: theme.space.xxl,
    color: theme.color.text.secondary,
  },
  warning: {
    margin: 0,
  },
  codes: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, max-content)',
    gap: `${theme.space.sm} ${theme.space.xxxl}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontFamily: theme.fontFamily.mono,
    color: theme.color.text.primary,
    userSelect: 'all',
    [theme.breakpoint.mobile]: {
      gridTemplateColumns: 'max-content',
    },
  },
  actions: {
    display: 'flex',
    gap: theme.space.md,
  },
  footer: {
    ...theme.recipe.modal.footer,
  },
}));

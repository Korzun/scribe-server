import { createUseStyles, type Theme } from '~/provider/theme';

export const useStyle = createUseStyles((theme: Theme) => ({
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.lg,
    padding: theme.space.md,
    '&$revoked': { opacity: 0.55 },
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.xs,
    minWidth: 0,
  },
  name: {
    fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
    color: theme.color.text.primary,
    overflowWrap: 'anywhere',
  },
  editable: { cursor: 'text' },
  edit: { display: 'flex', alignItems: 'center', gap: theme.space.md },
  meta: { fontSize: theme.fontSize.sm, color: theme.color.text.faint },
  revoked: {},
}));

import { createUseStyles, type Theme } from '~/provider/theme';

export type PageTypeValue = 'default' | 'minimal';
export enum PageType {
  default = 'default',
  minimal = 'minimal',
}

export const useStyle = createUseStyles((theme: Theme) => ({
  [PageType.default]: {
    maxWidth: 800,
    margin: `${theme.space.xxxxxl} auto`,
    padding: `0 ${theme.space.xxl}`,
    display: 'flex',
    gap: theme.fontSize.md, // historical: 0.875rem flexbox gap
    flexDirection: 'column',
    [theme.breakpoint.mobile]: {
      margin: 0,
      // Top spacing plus the notch inset, like the modal recipe.
      paddingTop: `calc(${theme.space.xxxxxl} + env(safe-area-inset-top))`,
      paddingBottom: `calc(${theme.space.xxxxxl} + env(safe-area-inset-bottom))`,
    },
  },
  [PageType.minimal]: {},
  // The page's header row, the space every default page holds open so that
  // moving between them does not shift the content under the cursor.
  //
  // MEASURED, not derived: a `Button` takes its height from its own line box,
  // which is the body font's `normal` line-height and therefore not something
  // the tokens can predict. This floor only has to CLEAR that height.
  headerRow: {
    minHeight: '2.25rem',
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.md,
    // `minWidth: 0` lets a wide child shrink instead of pushing the row past
    // the content column.
    '& > *': {
      flexGrow: 1,
      minWidth: 0,
    },
    // Mobile reserves nothing: screen height is too dear to hold open a row
    // for chrome that is not there. `contents` makes the row itself vanish
    // from the layout, so whatever it holds lands as a direct child of `<main>`.
    [theme.breakpoint.mobile]: {
      display: 'contents',
      // `<main>` is a COLUMN — leaving `flexGrow` on would stretch a child
      // down the whole page rather than across it.
      '& > *': {
        flexGrow: 0,
      },
    },
  },
}));

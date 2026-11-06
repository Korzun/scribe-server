import { PropsWithChildren, useEffect } from 'react';

import { useStyle, PageType, PageTypeValue } from './style';

const TITLE = 'Scribe';

type PageProps = PropsWithChildren<{
  type?: PageTypeValue;
  /**
   * The page's own chrome for the header row, which every default page holds
   * open whether or not it has anything to put there (see `style.ts`).
   */
  header?: React.ReactNode;
}>;

export const Page = ({ children, type = PageType.default as PageTypeValue, header }: PageProps) => {
  const styles = useStyle();

  useEffect(() => {
    document.title = TITLE;
  }, []);

  return (
    <main className={styles[type]}>
      {/* Rendered for every default page, EMPTY INCLUDED — holding the row
          open is what keeps pages with and without header content starting
          their content at the same height. A minimal page (login, loading)
          has nothing to line up with, so it gets no row. */}
      {type === PageType.default && <header className={styles.headerRow}>{header}</header>}
      {children}
    </main>
  );
};

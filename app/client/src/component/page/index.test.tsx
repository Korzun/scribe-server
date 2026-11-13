import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { Page } from './index';

describe('Page', () => {
  it('renders its children inside a main region and titles the document', () => {
    renderWithProviders(<Page>hello vault</Page>);
    expect(document.querySelector('main')).toHaveTextContent('hello vault');
    expect(document.title).toBe('Scribe');
  });

  it('holds the header row open on a page with nothing to put in it', () => {
    const { container } = renderWithProviders(<Page>content</Page>);

    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();
    expect(header).toBeEmptyDOMElement();
  });

  it("puts a page's own header content in that row", () => {
    const { container } = renderWithProviders(<Page header={<div>a toolbar</div>}>content</Page>);

    expect(within(container.querySelector('header')!).getByText('a toolbar')).toBeInTheDocument();
  });

  it('renders no header row on a minimal page', () => {
    const { container } = renderWithProviders(<Page type="minimal">content</Page>);

    expect(container.querySelector('header')).toBeNull();
  });
});

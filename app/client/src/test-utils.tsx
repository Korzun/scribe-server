import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import {
  Context as AuthContext,
  type AuthContext as AuthContextType,
} from './provider/auth/context';
import { ThemeProvider } from './provider/theme/provider';
import { ToastProvider } from './provider/toast';

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Overrides for the auth context; signed out and settled by default. */
  auth?: Partial<AuthContextType>;
  initialEntries?: string[];
}

/**
 * Renders inside the app's real theme and toast providers and a MemoryRouter,
 * with a FIXED auth context: screens are tested against the auth state they
 * are given, and `provider/auth/provider.test.tsx` covers the provider itself.
 */
export function renderWithProviders(
  ui: ReactElement,
  { auth = {}, initialEntries, ...options }: RenderWithProvidersOptions = {}
) {
  const authState: AuthContextType = {
    signedIn: false,
    loading: false,
    signIn: () => undefined,
    signOut: async () => undefined,
    ...auth,
  };

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <ThemeProvider>
          <ToastProvider>
            <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>
          </ToastProvider>
        </ThemeProvider>
      </MemoryRouter>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

import { createContext } from 'react';

export interface AuthContext {
  /** True iff a valid, unexpired owner token is present. */
  signedIn: boolean;
  /** True only during the mount-time silent-refresh attempt. */
  loading: boolean;
  /** Stores a freshly issued access token; AuthProvider and the route guards take it from there. */
  signIn: (accessToken: string) => void;
  /** Ends the session server-side (best effort) and clears the token. */
  signOut: () => Promise<void>;
}

export const Context = createContext<AuthContext>({
  signedIn: false,
  loading: true,
  signIn: () => undefined,
  signOut: async () => undefined,
});

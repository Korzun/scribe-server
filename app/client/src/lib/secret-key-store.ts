/**
 * The browser remembers the owner's Secret Key, as 1Password does (spec §10):
 * after the first sign-in on a browser only the password has to be typed. The
 * Secret Key alone unlocks nothing; it is useless without the password.
 *
 * Every access is wrapped: storage can be disabled, full, or throw a
 * SecurityError (private modes, blocked site data), and none of those may
 * break sign-in. Forgetting is offered on the login page.
 */

const STORAGE_KEY = 'scribe:secret-key';

export const rememberSecretKey = (text: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Not remembered; the owner types it next time.
  }
};

export const recallSecretKey = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const forgetSecretKey = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more can be done from here.
  }
};

import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetSecretKey, recallSecretKey, rememberSecretKey } from './secret-key-store';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('secret key store', () => {
  it('remembers, recalls and forgets under scribe:secret-key', () => {
    expect(recallSecretKey()).toBeNull();
    rememberSecretKey('A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74');
    expect(localStorage.getItem('scribe:secret-key')).toBe('A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74');
    expect(recallSecretKey()).toBe('A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74');
    forgetSecretKey();
    expect(recallSecretKey()).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    vi.spyOn(localStorage, 'getItem').mockImplementation(boom);
    vi.spyOn(localStorage, 'setItem').mockImplementation(boom);
    vi.spyOn(localStorage, 'removeItem').mockImplementation(boom);
    expect(() => rememberSecretKey('x')).not.toThrow();
    expect(recallSecretKey()).toBeNull();
    expect(() => forgetSecretKey()).not.toThrow();
  });
});

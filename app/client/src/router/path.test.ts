import { describe, expect, it } from 'vitest';

import { path } from './index';

describe('path', () => {
  it('names the four destinations the server and Task 13 rely on', () => {
    expect(path.home()).toBe('/');
    expect(path.login()).toBe('/login');
    expect(path.recover()).toBe('/recover');
    expect(path.reset()).toBe('/reset');
  });
});

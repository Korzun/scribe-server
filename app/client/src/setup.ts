import '@testing-library/jest-dom';
import { webcrypto } from 'node:crypto';

// The client derives keys with WebCrypto (`lib/kdf.ts`, `lib/seal.ts`). If the
// test environment's global `crypto` lacks `subtle`, install Node's WebCrypto,
// which implements the same API, so the browser code runs unchanged.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}

// Node.js 22+ ships a built-in localStorage that requires --localstorage-file to work.
// Vitest skips jsdom's working implementation because the key already exists on the Node
// global, leaving the broken built-in in place. Replace it with an in-memory store so
// tests can use localStorage normally.
const createInMemoryStorage = () => {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: (n: number) => Object.keys(store)[n] ?? null,
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
};

Object.defineProperty(globalThis, 'localStorage', {
  value: createInMemoryStorage(),
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

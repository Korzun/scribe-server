import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger');

import { startVault, type StartupDeps } from './startup';
import { AppConfig } from './types';

let root: string;
let deps: StartupDeps;
let listenCallback: ((err?: Error) => void) | undefined;
// `startVault` registers real `process.on('SIGTERM'/'SIGINT', ...)` listeners
// whose closures call `process.exit(0)` — snapshotting the listener lists
// before each test lets afterEach remove only what this test added, without
// touching listeners vitest itself installed.
let sigtermListenersBefore: NodeJS.SignalsListener[];
let sigintListenersBefore: NodeJS.SignalsListener[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  listenCallback = undefined;
  sigtermListenersBefore = [...process.listeners('SIGTERM')];
  sigintListenersBefore = [...process.listeners('SIGINT')];

  const config: AppConfig = {
    dataDir: path.join(root, 'data'),
    blobsDir: path.join(root, 'blobs'),
    port: 3000,
    publicUrl: null,
    trustProxyHops: 0,
    logLevel: 'error',
  };
  const server = {
    listen: vi.fn((_port: number, cb?: (err?: Error) => void) => {
      listenCallback = cb;
      return undefined as never;
    }),
  };
  deps = {
    prisma: { $disconnect: vi.fn() } as unknown as PrismaClient,
    config,
    version: '1.0.0',
    server,
  } as unknown as StartupDeps;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const listener of process.listeners('SIGTERM')) {
    if (!sigtermListenersBefore.includes(listener)) process.removeListener('SIGTERM', listener);
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!sigintListenersBefore.includes(listener)) process.removeListener('SIGINT', listener);
  }
});

describe('startVault', () => {
  it('creates the data and blobs directories', async () => {
    await startVault(deps);

    expect(fs.existsSync(deps.config.dataDir)).toBe(true);
    expect(fs.existsSync(deps.config.blobsDir)).toBe(true);
  });

  it('calls server.listen with the configured port', async () => {
    await startVault(deps);

    expect(deps.server.listen).toHaveBeenCalledWith(3000, expect.any(Function));
    expect(listenCallback).toBeDefined();
  });

  it('exits non-zero when listen reports an error such as a port already in use', async () => {
    // Express 5 hands listen errors (EADDRINUSE) to the callback instead of
    // throwing them; a callback that ignores its argument would log "starting"
    // and leave the process alive without a listener.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await startVault(deps);
      listenCallback!(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('does not exit when listen succeeds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await startVault(deps);
      listenCallback!();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});

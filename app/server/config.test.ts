import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig, readSetupCode } from './config';

vi.mock('./logger');

let dataDir: string;
const originalEnv = { ...process.env };

function writeOptions(options: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify(options));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-config-'));
  process.env = { ...originalEnv };
  process.env.DATA_DIR = dataDir;
  delete process.env.BLOBS_DIR;
  delete process.env.PUBLIC_URL;
  delete process.env.TRUST_PROXY_HOPS;
});

afterEach(() => {
  process.env = { ...originalEnv };
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('resolves blobsDir under /media/<library_dir>/blobs', () => {
    writeOptions({ library_dir: 'scribe' });
    expect(loadConfig().blobsDir).toBe('/media/scribe/blobs');
  });

  it('falls back to /media/scribe/blobs when library_dir escapes /media', () => {
    writeOptions({ library_dir: '../etc' });
    expect(loadConfig().blobsDir).toBe('/media/scribe/blobs');
  });

  it('env BLOBS_DIR overrides options.json', () => {
    process.env.BLOBS_DIR = '/media/override';
    writeOptions({ library_dir: 'scribe' });
    expect(loadConfig().blobsDir).toBe('/media/override');
  });

  it('publicUrl is null unless an absolute http(s) origin', () => {
    expect(loadConfig().publicUrl).toBeNull();

    process.env.PUBLIC_URL = 'https://scribe.example.com/';
    expect(loadConfig().publicUrl).toBe('https://scribe.example.com');

    process.env.PUBLIC_URL = 'scribe.example.com';
    expect(loadConfig().publicUrl).toBeNull();

    process.env.PUBLIC_URL = 'javascript:alert(1)';
    expect(loadConfig().publicUrl).toBeNull();
  });

  it('never puts the setup code in the config', () => {
    writeOptions({ setup_code: 'hunter2-hunter2' });
    expect(JSON.stringify(loadConfig())).not.toContain('hunter2');
  });
});

describe('readSetupCode', () => {
  it('returns null when options.json is absent', () => {
    expect(readSetupCode(dataDir)).toBeNull();
  });

  it('returns null when setup_code is blank', () => {
    writeOptions({ setup_code: '   ' });
    expect(readSetupCode(dataDir)).toBeNull();
  });

  it('returns null when options.json is unparsable or lacks the key', () => {
    fs.writeFileSync(path.join(dataDir, 'options.json'), '{not json');
    expect(readSetupCode(dataDir)).toBeNull();
    writeOptions({ library_dir: 'scribe' });
    expect(readSetupCode(dataDir)).toBeNull();
  });

  it('returns the trimmed code', () => {
    writeOptions({ setup_code: '  abc-123  ' });
    expect(readSetupCode(dataDir)).toBe('abc-123');
  });

  it('reflects a change to options.json on the next call without restart', () => {
    writeOptions({ setup_code: 'first' });
    expect(readSetupCode(dataDir)).toBe('first');
    writeOptions({ setup_code: 'second' });
    expect(readSetupCode(dataDir)).toBe('second');
    writeOptions({ setup_code: '' });
    expect(readSetupCode(dataDir)).toBeNull();
  });
});

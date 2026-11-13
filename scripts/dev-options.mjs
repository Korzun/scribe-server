// Writes dev-data/options.json with a known setup code if it is absent, so a
// fresh `make dev` / `make run` can create a library without a Home Assistant
// Configuration tab. An existing file is never touched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_OPTIONS = {
  setup_code: 'dev-setup-code',
  library_dir: 'scribe',
  log_level: 'debug',
};

export function ensureDevOptions(dataDir) {
  const file = path.join(dataDir, 'options.json');
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(DEV_OPTIONS)}\n`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const created = ensureDevOptions(path.resolve('dev-data'));
  if (created) {
    console.log(`  Wrote dev-data/options.json (setup code: ${DEV_OPTIONS.setup_code})`);
  }
}

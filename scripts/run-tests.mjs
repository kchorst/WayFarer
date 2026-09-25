import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const testsDir = resolve('tests');
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => resolve(testsDir, name));

if (!files.length) {
  console.error('No *.test.mjs files found in tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

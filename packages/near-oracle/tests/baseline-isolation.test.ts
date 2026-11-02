import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('baseline isolation', () => {
  it('loads the baseline oracle modules with no database, Redis or API environment', () => {
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', '-e', "import('./agent/src/predicate/baseline.ts').then(() => console.log('ok'))"],
      {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    expect(output.trim()).toBe('ok');
  });
});

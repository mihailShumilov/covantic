import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * INV-ANCHOR-01 — a name imported from Anchor is a name Anchor exports.
 *
 * Anchor 1.x ships CommonJS. Node's interop synthesises named exports for a
 * CJS module by static analysis, and what it cannot see it does not provide —
 * so `import { BN } from '@coral-xyz/anchor'` throws
 * `does not provide an export named 'BN'` at *module load*, before a single
 * line of the file runs.
 *
 * That is what makes it worth a test rather than a type check. TypeScript is
 * satisfied: the bundled `.d.ts` does declare `BN`, so the compiler, the
 * editor and `tsc --noEmit` all agree the import is fine. Only the runtime
 * disagrees, and only when the file is executed — which for a CLI means the
 * first time an operator tries to use it.
 *
 * `pnpm mandate:declare` was unusable for exactly this reason: the one command
 * a policyholder needs to declare the envelope an agent-error claim is proven
 * against could not start. Nothing failed in CI, because nothing ran it.
 *
 * The check asks Node, and only Node. The first version of this test used
 * `import * as ns` and looked for the name on the namespace object — which
 * passes for `BN`, because a namespace import of a CJS module exposes every
 * runtime property, while a *named* import is limited to what the lexer found
 * in the source. An oracle more permissive than the mechanism it stands in for
 * reports success on the very bug it was written for.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(`${path}/`, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('INV-ANCHOR-01 — named imports from Anchor resolve at runtime', () => {
  /** Does Node's ESM loader provide this name? The mechanism itself, asked. */
  function resolves(name: string): boolean {
    try {
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `import { ${name} } from '@coral-xyz/anchor';`],
        { cwd: ROOT, stdio: 'pipe' },
      );
      return true;
    } catch {
      return false;
    }
  }

  it('imports only names the loader actually provides', () => {
    const wanted = new Map<string, string>();

    for (const dir of ['src/', 'scripts/', 'tests/']) {
      for (const file of sourceFiles(`${ROOT}${dir}`)) {
        // Strip comments first: this file's own prose quotes the broken
        // import, and a scanner that reads documentation as code reports the
        // example rather than any real occurrence.
        const text = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const m of text.matchAll(
          /import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*'@coral-xyz\/anchor'/g,
        )) {
          for (const raw of m[1]!.split(',')) {
            const name = raw.trim();
            // `import type` members are erased before the module ever loads.
            if (!name || name.startsWith('type ')) continue;
            const local = name.split(/\s+as\s+/)[0]!.trim();
            if (local) wanted.set(local, file.slice(ROOT.length));
          }
        }
      }
    }

    const missing = [...wanted]
      .filter(([name]) => !resolves(name))
      .map(([name, file]) => `${file} — ${name}`);

    expect(
      missing,
      "reach these through the default export instead: `import pkg from '@coral-xyz/anchor'`",
    ).toEqual([]);
  });

  it('rejects a name the package does not export, so the check is not vacuous', () => {
    // Guards the oracle rather than the code: if `resolves` started returning
    // true unconditionally — a swallowed spawn failure, a changed exit code —
    // the assertion above would pass while checking nothing.
    expect(resolves('NotAThingAnchorExports')).toBe(false);
    expect(resolves('AnchorProvider')).toBe(true);
  });
});

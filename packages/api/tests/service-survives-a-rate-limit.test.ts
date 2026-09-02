import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-UPTIME-01 — a rejected promise nobody awaited does not restart the
 * service.
 *
 * Node's default for an unhandled rejection is to throw, which exits. That is
 * right for a script and wrong for a long-running service whose dependencies
 * rate-limit. A single `429 Too Many Requests` from a floating promise inside
 * `@solana/web3.js` killed the API roughly every forty-five seconds, and
 * `restart: unless-stopped` brought it back to do it again — re-running
 * migrations, restarting every worker, dropping whatever was in flight, over a
 * condition that resolves by waiting.
 *
 * The stack had no application frames, so there was no call site to put a
 * `catch` on:
 *
 *     Error: 429 Too Many Requests
 *       at ClientBrowser.callServer (@solana/web3.js/lib/index.cjs.js:5081)
 *       at process.processTicksAndRejections
 *
 * The monitor needs it more than the API does. It writes the balance
 * checkpoints every proven payout is bounded by, and a gap in checkpointing is
 * a window in which an incident produces an uncompensated loss.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const ENTRYPOINTS = ['src/index.ts', 'src/workers/monitor-entry.ts'];

describe('INV-UPTIME-01 — a rate limit does not restart a long-running process', () => {
  it('handles unhandled rejections in every entrypoint', () => {
    const missing = ENTRYPOINTS.filter(
      (file) => !/process\.on\('unhandledRejection'/.test(readFileSync(`${ROOT}${file}`, 'utf8')),
    );

    expect(missing, 'a process without this restarts on a 429').toEqual([]);
  });

  it('logs the rejection rather than swallowing it', () => {
    // Silence is how a real defect hides for a month. The handler has to emit
    // the same signal the crash did, minus the crash.
    for (const file of ENTRYPOINTS) {
      const source = readFileSync(`${ROOT}${file}`, 'utf8');
      const at = source.indexOf("process.on('unhandledRejection'");
      expect(source.slice(at, at + 400), file).toMatch(/logger\.error\(/);
    }
  });

  it('leaves uncaughtException alone', () => {
    // A synchronous throw that reached the top of the stack has left the
    // process in a state nobody reasoned about. Continuing from there is a
    // different and worse bet than continuing from a rejected promise, and
    // conflating the two is how a corrupted process keeps serving.
    for (const file of ENTRYPOINTS) {
      expect(readFileSync(`${ROOT}${file}`, 'utf8'), file).not.toMatch(
        /process\.on\('uncaughtException'/,
      );
    }
  });
});

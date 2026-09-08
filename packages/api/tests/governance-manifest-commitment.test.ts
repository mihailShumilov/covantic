import { describe, expect, it } from 'vitest';
import { governanceManifestCommitment } from '@covantic/shared';

/**
 * INV-COMMIT-02 — the governance manifest commitment covers the whole
 * declaration.
 *
 * `declare_governance_baseline` stores `manifest_hash` as handed to it, so the
 * hash is only a commitment to the declaration if every declared field is in
 * its preimage. The CLI used to hash the owner, the operators and the
 * controller — three of eight — and a copy of the declaration with a
 * different delegate or threshold hashed identically. The vectors below pin
 * the layout; a change to any field must move the digest.
 */

const key = (byte: number) => new Uint8Array(32).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const base = () => ({
  tokenOwner: key(1),
  expectedDelegate: key(2),
  expectedCloseAuthority: null,
  programUpgradeAuthority: null,
  controller: null,
  controllerMinThreshold: 0,
  extraAuthorities: [key(9), key(3)],
});

describe('INV-COMMIT-02 — governance manifest commitment', () => {
  it('matches the pinned vector', () => {
    expect(hex(governanceManifestCommitment(base()))).toBe(
      '530437f6004cb2ffdd5bfa09246313e64876e655562758ecfa599004c0660609',
    );
  });

  it('is independent of the order the operators arrive in', () => {
    const swapped = { ...base(), extraAuthorities: [key(3), key(9)] };
    expect(hex(governanceManifestCommitment(swapped))).toBe(
      hex(governanceManifestCommitment(base())),
    );
  });

  it('pins the minimal declaration too', () => {
    expect(
      hex(
        governanceManifestCommitment({
          tokenOwner: key(1),
          expectedDelegate: null,
          expectedCloseAuthority: null,
          programUpgradeAuthority: null,
          controller: null,
          controllerMinThreshold: 0,
          extraAuthorities: [],
        }),
      ),
    ).toBe('54b180da29e0d57c28763a7ed8a197e161c3c2622b726beb3047fe603b5dd895');
  });

  it('moves when any declared field moves', () => {
    const reference = hex(governanceManifestCommitment(base()));
    const variants = [
      { ...base(), expectedDelegate: null },
      { ...base(), expectedDelegate: key(4) },
      { ...base(), expectedCloseAuthority: key(5) },
      { ...base(), programUpgradeAuthority: key(6) },
      { ...base(), controller: key(7) },
      { ...base(), controllerMinThreshold: 2 },
      { ...base(), extraAuthorities: [key(9)] },
      { ...base(), extensionHash: key(8) },
    ];
    for (const variant of variants) {
      expect(hex(governanceManifestCommitment(variant))).not.toBe(reference);
    }
  });

  it('distinguishes an absent optional role from a present one', () => {
    // A bare 32 zero bytes must not collide with "none": the tag byte is what
    // keeps `Some(zero)` — which the program refuses — from hashing like
    // `None`.
    const none = hex(governanceManifestCommitment({ ...base(), expectedDelegate: null }));
    const zero = hex(
      governanceManifestCommitment({ ...base(), expectedDelegate: new Uint8Array(32) }),
    );
    expect(none).not.toBe(zero);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() =>
      governanceManifestCommitment({ ...base(), tokenOwner: new Uint8Array(31) }),
    ).toThrow(/32 bytes/);
  });
});

import { sha256 } from '@noble/hashes/sha256';

/**
 * The commitment a governance declaration's `manifest_hash` is computed from.
 *
 * The program stores the hash as handed to it — it cannot decode a Squads
 * config or an allowed-signer list, so the richer statement lives off chain
 * and the hash is what makes it permanently falsifiable. That only works if
 * the hash covers the *whole* declaration. The CLI used to hash three fields
 * of eight, so a change to the declared delegate, close authority, upgrade
 * authority or controller threshold left the same commitment standing and
 * the on-chain record could not falsify an altered off-chain copy.
 *
 * ## Layout
 *
 * Explicit, versioned, and independent of any serialiser, for the reason
 * `agentMandateCommitment` gives: a format two implementations merely happen
 * to agree on is one an upgrade can split.
 *
 * ```text
 * "covantic-governance-manifest/v1" (ASCII, no terminator)
 * token_owner                      32 bytes
 * expected_delegate                1 byte tag (0 = none, 1 = some) + 32 bytes when some
 * expected_close_authority         1 byte tag + 32 bytes when some
 * program_upgrade_authority        1 byte tag + 32 bytes when some
 * controller                       1 byte tag + 32 bytes when some
 * controller_min_threshold         u16 little-endian
 * extra_authorities                1 byte count + 32 bytes each, bytewise sorted
 * extension_hash                   32 bytes — sha256 of the off-chain document, or zeros
 * ```
 *
 * `extensionHash` is where anything richer than the on-chain fields goes: a
 * Squads config, an allowed-signer policy, prose. Callers with nothing richer
 * pass zeros, and the commitment still binds every on-chain field.
 */
export interface GovernanceManifestInput {
  tokenOwner: Uint8Array;
  expectedDelegate: Uint8Array | null;
  expectedCloseAuthority: Uint8Array | null;
  programUpgradeAuthority: Uint8Array | null;
  controller: Uint8Array | null;
  controllerMinThreshold: number;
  /** Order does not matter. */
  extraAuthorities: Uint8Array[];
  /** sha256 of the off-chain document, or 32 zero bytes when there is none. */
  extensionHash?: Uint8Array;
}

// ASCII, spelled out by char code: this package has no DOM lib, so no
// `TextEncoder`, and the domain must be identical in every runtime anyway.
const DOMAIN = Uint8Array.from('covantic-governance-manifest/v1', (c) => c.charCodeAt(0));

function key32(value: Uint8Array, field: string): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`${field} must be 32 bytes, got ${value.length}`);
  }
  return value;
}

function optionalKey(value: Uint8Array | null, field: string): Uint8Array {
  if (value === null) return Uint8Array.from([0]);
  return concat([Uint8Array.from([1]), key32(value, field)]);
}

function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new Error(`controllerMinThreshold must be a u16, got ${v}`);
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, v, true);
  return out;
}

/** Bytewise, matching Rust's `sort_unstable` over `[u8; 32]`. */
function sortedKeys(keys: Uint8Array[]): Uint8Array[] {
  return [...keys].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return a.length - b.length;
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function governanceManifestCommitment(manifest: GovernanceManifestInput): Uint8Array {
  const extras = sortedKeys(
    manifest.extraAuthorities.map((k, i) => key32(k, `extraAuthorities[${i}]`)),
  );
  if (extras.length > 255) throw new Error('too many extra authorities');
  const extension = manifest.extensionHash ?? new Uint8Array(32);

  return sha256(
    concat([
      DOMAIN,
      key32(manifest.tokenOwner, 'tokenOwner'),
      optionalKey(manifest.expectedDelegate, 'expectedDelegate'),
      optionalKey(manifest.expectedCloseAuthority, 'expectedCloseAuthority'),
      optionalKey(manifest.programUpgradeAuthority, 'programUpgradeAuthority'),
      optionalKey(manifest.controller, 'controller'),
      u16le(manifest.controllerMinThreshold),
      Uint8Array.from([extras.length]),
      ...extras,
      key32(extension, 'extensionHash'),
    ]),
  );
}

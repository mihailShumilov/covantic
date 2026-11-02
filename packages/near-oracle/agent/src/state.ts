import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { sha256Canonical } from './predicate/baseline.js';
import type { EvidenceBundle } from './predicate/baseline.js';
import type { PredicateInputs, PredicateResult } from './predicate/types.js';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export interface EvidenceRecord {
  bundle: EvidenceBundle | null;
  result: PredicateResult;
  /** sha256 of the canonical record contents, so a copy can be checked. */
  sha256: string;
}

function evidencePath(stateDir: string, triggerTx: string): string {
  return join(ensureDir(join(stateDir, 'evidence')), `${triggerTx}.json`);
}

export function saveEvidence(
  stateDir: string,
  bundle: EvidenceBundle | null,
  result: PredicateResult,
): { path: string; sha256: string } {
  const body = JSON.parse(serialize({ bundle, result })) as Record<string, unknown>;
  const sha256 = sha256Canonical(body);
  const path = evidencePath(stateDir, result.trigger_tx);
  writeFileSync(path, serialize({ ...body, sha256 }));
  return { path, sha256 };
}

function reviveInputs(inputs: PredicateInputs): PredicateInputs {
  return {
    ...inputs,
    payoutAmount: BigInt(inputs.payoutAmount),
    subjectQuantity: BigInt(inputs.subjectQuantity),
  };
}

/**
 * Returns an earlier PAY decision for this trigger. Evidence is collected once
 * per decision, because a second collection has a different hash and the
 * contract treats a changed hash as a new payout.
 */
export function loadPayDecision(stateDir: string, triggerTx: string) {
  const path = evidencePath(stateDir, triggerTx);
  if (!existsSync(path)) return null;
  const { result } = JSON.parse(readFileSync(path, 'utf8')) as EvidenceRecord;
  if (result.verdict !== 'PAY') return null;
  return { ...result, inputs: reviveInputs(result.inputs) };
}

/** Loads the devnet key that pays for Pyth posts and demo setup, creating it once. */
export function loadOrCreateFunder(stateDir: string): Keypair {
  const path = join(ensureDir(stateDir), 'funder.json');
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  }
  const funder = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(funder.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return funder;
}
